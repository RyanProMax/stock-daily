import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseAgentEvents, stableHash } from "./daily-workflow-core.mjs";
import { auditNativeAgentAttempt } from "./native-agent-receipts.mjs";

const SKIP_DIRECTORIES = new Set(["artifacts", "events", "native-attempts", "node_modules", ".git"]);

function clock(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function positiveBudget(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function collectTimeBudgets(manifest, manifestReference, attempts, budgets, errors) {
  for (const kind of ["workflow", "research"]) {
    const declared = manifest[`${kind}BudgetMs`];
    const elapsed = manifest[`${kind}ElapsedMs`];
    const stored = manifest[`${kind}Sessions`];
    const relevant = attempts.filter(attempt => kind === "workflow" || ["facts", "causal", "recap_discovery"].includes(attempt.role));
    try {
      if (declared != null && !positiveBudget(declared)) throw new Error("Invalid frozen time budget");
      if (elapsed != null && (!Number.isSafeInteger(elapsed) || elapsed < 0)) throw new Error("Invalid declared elapsed time");
      if (stored != null && !Array.isArray(stored)) throw new Error("Time sessions are not an array");
      // Old manifests predate persistent clocks. Recover their measured run
      // interval, rather than treating a parser/configuration upgrade as free time.
      let sessions = stored ?? [];
      if (!sessions.length) {
        const starts = relevant.map(attempt => clock(attempt.startedAt)).filter(Number.isFinite);
        const inferredStart = starts.length ? new Date(Math.min(...starts)).toISOString() : undefined;
        const startedAt = kind === "research" ? manifest.researchStartedAt ?? inferredStart ?? (elapsed > 0 ? manifest.startedAt : undefined)
          : manifest.startedAt ?? inferredStart;
        const start = clock(startedAt);
        const completions = relevant.map(attempt => clock(attempt.completedAt)).filter(Number.isFinite);
        const end = kind === "research" ? Math.max(start, ...completions)
          : Math.max(...[clock(manifest.completedAt ?? manifest.failedAt ?? manifest.updatedAt), ...completions].filter(Number.isFinite));
        const measured = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
        if (elapsed > 0 || measured > 0) {
          if (!Number.isFinite(start)) throw new Error("Historical elapsed time has no session identity");
          sessions = [{ startedAt, elapsedMs: Math.max(elapsed ?? 0, measured), recovered: true }];
        } else if (elapsed === 0 || declared != null || Number.isFinite(start)) {
          // A newly initialized run can legitimately have no research session.
          if (kind === "workflow" && !Number.isFinite(start)) throw new Error("Historical workflow budget has no clock");
        }
      }
      const hasHistory = sessions.length > 0;
      const fallback = manifest.coverageRequired ? (kind === "workflow" ? 3_300_000 : 2_100_000)
        : (kind === "workflow" ? 2_700_000 : 1_200_000);
      if (declared != null) budgets[kind].limits.push(declared);
      let localElapsed = 0;
      for (const [index, session] of sessions.entries()) {
        if (!session || typeof session !== "object" || Array.isArray(session) || !Number.isFinite(clock(session.startedAt))) throw new Error("Invalid time session identity");
        if (session.budgetMs != null && !positiveBudget(session.budgetMs)) throw new Error("Invalid session time ceiling");
        let sessionElapsed = session.elapsedMs;
        if (!Number.isSafeInteger(sessionElapsed) || sessionElapsed < 0) {
          if (sessionElapsed != null) throw new Error("Invalid session elapsed time");
          const end = clock(session.endedAt);
          if (!Number.isFinite(end) || end < clock(session.startedAt)) throw new Error("Time session has no verifiable elapsed interval");
          sessionElapsed = end - clock(session.startedAt);
        }
        if (session.endedAt != null && (!Number.isFinite(clock(session.endedAt)) || clock(session.endedAt) < clock(session.startedAt))) throw new Error("Invalid time session end");
        const budgetMs = session.budgetMs ?? declared ?? fallback;
        budgets[kind].limits.push(budgetMs);
        localElapsed += sessionElapsed;
        const startedAt = new Date(clock(session.startedAt)).toISOString();
        const identity = `${kind}:${startedAt}`;
        const previous = budgets[kind].sessions.get(identity);
        const reference = { identity, manifest: manifestReference, index, startedAt, elapsedMs: sessionElapsed, budgetMs,
          ...(session.endedAt ? { endedAt: session.endedAt } : {}), ...(session.recovered ? { recovered: true } : {}) };
        // Copies/checkpoints of one wall-clock session are one charge. A later
        // checkpoint may increase consumption, but may never reduce its ceiling.
        if (!previous || reference.elapsedMs > previous.elapsedMs) budgets[kind].sessions.set(identity, reference);
        if (previous) budgets[kind].sessions.get(identity).budgetMs = Math.min(previous.budgetMs, budgetMs);
      }
      if (hasHistory && elapsed != null && elapsed > localElapsed) throw new Error("Declared elapsed time exceeds retained sessions");
    } catch (error) {
      errors.push({ manifest: manifestReference, collection: `${kind}Sessions`, reason: error.message });
    }
  }
}

async function verifiedRoleTarget(runDir, audited, market, marketAsOf) {
  if (!["facts", "causal"].includes(audited.invocation.role)) return null;
  const prompt = await readFile(resolve(runDir, audited.reference.promptArtifact), "utf8");
  const marker = "<task_input_json>";
  const start = prompt.lastIndexOf(marker);
  // Pre-receipt/foreign fixtures without a frozen payload cannot prove a
  // target. Do not turn a guessed stage-name mapping into a role charge.
  if (start < 0) return null;
  const end = prompt.indexOf("</task_input_json>", start);
  if (end < 0) throw new Error("Native research payload is incomplete");
  const payload = JSON.parse(prompt.slice(start + marker.length, end));
  if (payload.market !== market || payload.marketAsOf !== marketAsOf || typeof payload.anomaly?.target !== "string" || !payload.anomaly.target.trim()) throw new Error("Native research target/session is not verifiable");
  if (typeof payload.anomaly.id !== "string" || audited.invocation.key !== `${payload.anomaly.id}-${audited.invocation.role}`) return null;
  return payload.anomaly.target;
}

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
  const budgets = Object.fromEntries(["workflow", "research"].map(kind => [kind, { limits: [], sessions: new Map() }]));
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
    const localAttempts = [];
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
            const target = await verifiedRoleTarget(runDir, audited, market, marketAsOf);
            checked = { searchCount: audited.receipt.queries.length, eventHash: audited.receipt.eventHash, receiptHash: audited.reference.receiptHash,
              startedAt: audited.invocation.startedAt, completedAt: audited.receipt.completedAt, role: audited.invocation.role, ...(target ? { target } : {}) };
          } else checked = { ...await legacyAttempt(runDir, record), startedAt: record.startedAt, completedAt: record.completedAt };
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
          localAttempts.push(attempt);
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
    collectTimeBudgets(manifest, relative(root, manifestPath), localAttempts, budgets, unverifiedAttempts);
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
  const timeBudgets = Object.fromEntries(Object.entries(budgets).map(([kind, budget]) => {
    const sessions = [...budget.sessions.values()];
    return [kind, { elapsedMs: sessions.reduce((sum, session) => sum + session.elapsedMs, 0), limitMs: budget.limits.length ? Math.min(...budget.limits) : null, sessions }];
  }));
  const roles = new Map();
  for (const attempt of modernCharges.values()) {
    if (!attempt.target || !["facts", "causal"].includes(attempt.role)) continue;
    const identity = `${attempt.target}|${attempt.role}`;
    if (!roles.has(identity)) roles.set(identity, { scope: "primary", target: attempt.target, role: attempt.role, agentRunIds: [] });
    roles.get(identity).agentRunIds.push(attempt.agentRunId);
  }
  const roleAttempts = [...roles.values()].map(role => ({ ...role, attemptCount: role.agentRunIds.length }));
  return { market, marketAsOf, knownQueryCount: chargedAttempts.reduce((sum, attempt) => sum + attempt.searchCount, 0), unverifiedAttempts, chargedAttempts, timeBudgets, roleAttempts };
}
