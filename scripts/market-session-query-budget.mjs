import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseAgentEvents, stableHash } from "./daily-workflow-core.mjs";
import { auditNativeAgentAttempt } from "./native-agent-receipts.mjs";

const SKIP_DIRECTORIES = new Set(["artifacts", "events", "native-attempts", "node_modules", ".git"]);

function standardRunSession(manifestPath) {
  const match = /^(US|CN)-(\d{4}-\d{2}-\d{2})-.+/u.exec(basename(dirname(manifestPath)));
  if (!match) return null;
  const date = new Date(`${match[2]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[2]) return null;
  return { market: match[1], marketAsOf: match[2] };
}

function compactReference(root, manifestPath, collection, index, record = {}) {
  return {
    manifest: relative(root, manifestPath), collection, index,
    ...Object.fromEntries(["key", "role", "agentRunId", "eventArtifact", "eventHash", "receiptHash"]
      .filter(key => typeof record?.[key] === "string").map(key => [key, record[key]])),
  };
}

async function manifests(root, errors) {
  const found = [];
  async function visit(directory, depth) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (directory === root && error.code === "ENOENT") return;
      errors.push({ manifest: relative(root, directory), reason: `Cannot inspect query history: ${error.code ?? error.message}` });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isFile() && entry.name === "manifest.json") found.push(path);
      if (depth < 3 && entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) await visit(path, depth + 1);
    }
  }
  await visit(root, 0);
  return found;
}

async function legacyAttempt(runDir, record) {
  if (typeof record.eventArtifact !== "string" || !record.eventArtifact ||
      typeof record.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.eventHash)) {
    throw new Error("Legacy attempt has no verifiable raw event reference");
  }
  const eventPath = resolve(runDir, record.eventArtifact), inside = relative(runDir, eventPath);
  if (isAbsolute(record.eventArtifact) || inside === ".." || inside.startsWith(`..${sep}`)) {
    throw new Error("Legacy event reference escapes its run directory");
  }
  const raw = await readFile(eventPath, "utf8");
  if (stableHash(raw) !== record.eventHash) throw new Error("Legacy raw event hash changed");
  let parsed;
  try { parsed = parseAgentEvents(raw); }
  catch {
    // A failed/interrupted turn still paid for completed searches. Validate every
    // original JSON line, then use the same parser on a search-accounting view.
    // The synthetic terminal marker is never evidence of successful execution.
    const events = raw.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
    if (!events.length) throw new Error("Legacy raw event stream is empty");
    const searches = events.filter(event => event.type === "item.completed" && event.item?.type === "web_search");
    parsed = parseAgentEvents([...searches, { type: "turn.completed" }].map(event => JSON.stringify(event)).join("\n"));
  }
  if ((record.searchCount != null && record.searchCount !== parsed.searchCount) ||
      (record.queries != null && stableHash(record.queries) !== stableHash(parsed.queries))) {
    throw new Error("Legacy executed-query accounting changed");
  }
  return { searchCount: parsed.searchCount, eventHash: record.eventHash };
}

/** Actual query consumption belongs to a trading session, independently of run configuration. */
export async function marketSessionQueryConsumption(workRoot, { market, marketAsOf }) {
  if (!["US", "CN"].includes(market) || !/^\d{4}-\d{2}-\d{2}$/u.test(marketAsOf ?? "")) {
    throw new Error("A market and trading-session date are required");
  }
  const root = resolve(workRoot), unverifiedAttempts = [], auditedAttempts = [], identities = new Map(), conflicted = new Set();
  const paths = await manifests(root, unverifiedAttempts);
  for (const manifestPath of paths) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Manifest is not an object");
    } catch (error) {
      const runSession = standardRunSession(manifestPath);
      if (runSession && (runSession.market !== market || runSession.marketAsOf !== marketAsOf)) continue;
      unverifiedAttempts.push({ manifest: relative(root, manifestPath), reason: `Cannot establish manifest session: ${error.message}`.slice(0, 240) });
      continue;
    }
    if (manifest.market !== market || manifest.marketAsOf !== marketAsOf) continue;
    const runDir = dirname(manifestPath);
    let localKnownCount = 0;
    for (const collection of ["agentRuns", "failedAgentRuns"]) {
      if (manifest[collection] == null) continue;
      if (!Array.isArray(manifest[collection])) {
        unverifiedAttempts.push({ manifest: relative(root, manifestPath), collection, reason: "Attempt collection is not an array" });
        continue;
      }
      for (const [index, record] of manifest[collection].entries()) {
        const reference = compactReference(root, manifestPath, collection, index, record);
        try {
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid attempt record");
          if (record.agentRunId != null && (typeof record.agentRunId !== "string" || !record.agentRunId)) throw new Error("Invalid attempt identity");
          const modern = Boolean(record.receiptArtifact || record.invocationArtifact || record.eventStreamArtifact);
          let checked;
          if (modern) {
            const audited = await auditNativeAgentAttempt(runDir, record);
            checked = { searchCount: audited.receipt.queries.length, eventHash: audited.receipt.eventHash, receiptHash: audited.reference.receiptHash };
          } else checked = await legacyAttempt(runDir, record);
          // A declaration describes this manifest's records. Global alias
          // removal must not make individually verified records look missing.
          localKnownCount += checked.searchCount;
          const identity = modern ? `agent:${record.agentRunId}` : `legacy:${checked.eventHash}`;
          const previous = record.agentRunId ? identities.get(record.agentRunId) : null;
          if (previous && (previous.eventHash !== checked.eventHash || previous.searchCount !== checked.searchCount ||
              (previous.receiptHash && checked.receiptHash && previous.receiptHash !== checked.receiptHash))) {
            if (!conflicted.has(record.agentRunId)) unverifiedAttempts.push({ ...reference, reason: "Same attempt identity has conflicting original receipts", conflictingManifest: previous.manifest });
            conflicted.add(record.agentRunId);
            continue;
          }
          const attempt = { ...reference, identity, ...checked };
          if (!modern) delete attempt.receiptHash;
          if (record.agentRunId && (!previous || checked.receiptHash)) identities.set(record.agentRunId, attempt);
          auditedAttempts.push({ modern, attempt });
        } catch (error) {
          unverifiedAttempts.push({ ...reference, reason: String(error.message ?? error).slice(0, 240) });
        }
      }
    }
    if (manifest.searchQueryCount != null && (!Number.isSafeInteger(manifest.searchQueryCount) || manifest.searchQueryCount < 0)) {
      unverifiedAttempts.push({ manifest: relative(root, manifestPath), reason: "Invalid declared query consumption" });
    } else if (manifest.searchQueryCount > localKnownCount) {
      unverifiedAttempts.push({ manifest: relative(root, manifestPath), reason: "Declared queries exceed verifiable original attempt records" });
    }
  }
  // Receipts prove independent modern invocations even when their event bytes
  // coincide. Legacy metadata alone cannot prove another paid invocation.
  const modernCharges = new Map(), legacyCharges = new Map();
  for (const { modern, attempt } of auditedAttempts) {
    if (attempt.agentRunId && conflicted.has(attempt.agentRunId)) continue;
    if (modern) modernCharges.set(attempt.identity, attempt);
    else if (!legacyCharges.has(attempt.eventHash)) legacyCharges.set(attempt.eventHash, attempt);
  }
  const modernEventHashes = new Set([...modernCharges.values()].map(attempt => attempt.eventHash));
  const chargedAttempts = [...modernCharges.values(), ...[...legacyCharges.values()].filter(attempt => !modernEventHashes.has(attempt.eventHash))];
  return { market, marketAsOf, knownQueryCount: chargedAttempts.reduce((sum, attempt) => sum + attempt.searchCount, 0), unverifiedAttempts, chargedAttempts };
}
