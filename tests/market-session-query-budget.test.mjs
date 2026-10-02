import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AGENT_FILESYSTEM_ISOLATION, stableHash } from "../scripts/daily-workflow-core.mjs";
import { beginNativeAgentAttempt, finishNativeAgentAttempt } from "../scripts/native-agent-receipts.mjs";
import { marketSessionQueryConsumption } from "../scripts/market-session-query-budget.mjs";

const session = { market: "US", marketAsOf: "2026-10-01" };
async function temporary(t) {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-session-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function events(queries, terminal = "turn.completed") {
  return [...queries.map(query => ({ type: "item.completed", item: { type: "web_search", action: { type: "search", query } } })),
    { type: terminal }].map(event => JSON.stringify(event)).join("\n") + "\n";
}
async function manifest(root, name, value) {
  const run = resolve(root, name);
  await mkdir(run, { recursive: true });
  await writeFile(resolve(run, "manifest.json"), JSON.stringify({ ...session, agentRuns: [], ...value }));
  return run;
}
async function legacy(root, name, queries, options = {}) {
  const run = resolve(root, name), raw = events(queries, options.terminal);
  const record = { key: options.key ?? name, startedAt: options.startedAt ?? name, eventArtifact: "events/call.jsonl",
    eventHash: stableHash(raw), queries: [...new Set(queries)], searchCount: queries.length };
  await mkdir(resolve(run, "events"), { recursive: true });
  await writeFile(resolve(run, record.eventArtifact), raw);
  await manifest(root, name, { [options.failed ? "failedAgentRuns" : "agentRuns"]: [record], ...options.manifest });
  return { run, record, raw };
}
async function modern(root, name, queries, options = {}) {
  const run = await manifest(root, name, {}), prompt = "Controlled query-budget fixture; no native process.", schemaText = '{}';
  const schemaHash = stableHash(schemaText), call = { agentRunId: options.agentRunId ?? randomUUID(), key: "facts", role: "facts",
    schemaHash, promptHash: stableHash({ prompt, schemaHash, filesystemIsolation: AGENT_FILESYSTEM_ISOLATION }) };
  const refs = await beginNativeAgentAttempt(run, call, { prompt, schemaText }), raw = events(queries, options.failed ? "turn.failed" : "turn.completed");
  await writeFile(resolve(run, refs.eventStreamArtifact), raw);
  const receipt = await finishNativeAgentAttempt(run, call, { events: raw, completedAt: "2026-10-02T00:00:00Z", exitCode: options.failed ? 1 : 0 });
  const record = { ...call, ...receipt, eventHash: stableHash(raw), queries, searchCount: queries.length };
  await manifest(root, name, { [options.failed ? "failedAgentRuns" : "agentRuns"]: [record] });
  return { run, record };
}

test("one trading session charges across workflow versions, input hashes, cutoffs and attempts", async t => {
  const root = await temporary(t);
  await legacy(root, "runs/first", ["first", "first"], { manifest: { workflowVersion: "v1", inputHash: "old", cutoffAt: "morning", attempt: 1 } });
  await legacy(root, "runs/second", ["second"], { manifest: { workflowVersion: "v2", inputHash: "new", cutoffAt: "night", attempt: 9 } });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 3);
  assert.equal(result.unverifiedAttempts.length, 0);
  assert.equal(result.chargedAttempts.length, 2);
});

test("modern copied receipt identity charges once; distinct invocations charge independently", async t => {
  const root = await temporary(t), first = await modern(root, "runs/one", ["same query"]);
  const alias = await modern(root, "runs/two", ["same query"]);
  await manifest(root, "runs/one", { agentRuns: [first.record, first.record], failedAgentRuns: [first.record] });
  const copy = await manifest(root, "copied-version", { workflowVersion: "another", agentRuns: [first.record] });
  await cp(resolve(first.run, "native-attempts"), resolve(copy, "native-attempts"), { recursive: true });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 2);
  assert.equal(result.chargedAttempts.length, 2);
  assert.notEqual(first.record.agentRunId, alias.record.agentRunId);
});

test("conflicting valid receipts under one modern identity fail closed", async t => {
  const root = await temporary(t), agentRunId = randomUUID();
  await modern(root, "runs/one", ["first"], { agentRunId });
  await modern(root, "runs/two", ["second", "third"], { agentRunId });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 0);
  assert.match(result.unverifiedAttempts[0].reason, /conflicting/);
});

test("legacy aliases deduplicate actual events and retain repeated searches inside an attempt", async t => {
  const root = await temporary(t), old = await legacy(root, "runs/original", ["query", "query"]);
  const alias = await manifest(root, "alias", { agentRuns: [old.record] });
  await mkdir(resolve(alias, "events"));
  await copyFile(resolve(old.run, old.record.eventArtifact), resolve(alias, old.record.eventArtifact));
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 2);
  assert.equal(result.chargedAttempts.length, 1);
});

test("changing legacy alias metadata cannot create a second physical query charge", async t => {
  const root = await temporary(t), original = await legacy(root, "runs/original", ["one paid query"]);
  const changed = { ...original.record, key: "different alias", startedAt: "different time" };
  const alias = await manifest(root, "renamed-alias", { agentRuns: [changed, { ...changed, key: "another alias" }], searchQueryCount: 2 });
  await mkdir(resolve(alias, "events"));
  await copyFile(resolve(original.run, original.record.eventArtifact), resolve(alias, original.record.eventArtifact));
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 1);
  assert.equal(result.chargedAttempts.length, 1);
  assert.equal(result.unverifiedAttempts.length, 0);
});

test("legacy copies of modern event bytes add no charge, while distinct modern receipts remain independent", async t => {
  const root = await temporary(t), first = await modern(root, "runs/first", ["same paid query"]);
  await modern(root, "runs/second", ["same paid query"]);
  const record = { key: "old-style alias", startedAt: "another time", eventArtifact: "events/copy.jsonl",
    eventHash: first.record.eventHash, queries: ["same paid query"], searchCount: 1 };
  const alias = await manifest(root, "old-style-alias", { agentRuns: [record], searchQueryCount: 1 });
  await mkdir(resolve(alias, "events"));
  await copyFile(resolve(first.run, first.record.eventArtifact), resolve(alias, record.eventArtifact));
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 2);
  assert.equal(result.chargedAttempts.length, 2);
  assert.ok(result.chargedAttempts.every(attempt => attempt.receiptHash));
  assert.equal(result.unverifiedAttempts.length, 0);
});

test("both modern and legacy failed attempts retain actual query charges", async t => {
  const root = await temporary(t);
  await modern(root, "runs/modern", ["completed before failure"], { failed: true });
  await legacy(root, "runs/legacy", ["paid first", "paid second"], { failed: true, terminal: "turn.failed" });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 3);
  assert.equal(result.unverifiedAttempts.length, 0);
});

test("missing or tampered originals and invented zero-query declarations are unverified", async t => {
  const root = await temporary(t), original = await legacy(root, "runs/tampered", ["actual query"]);
  await writeFile(resolve(original.run, original.record.eventArtifact), "changed");
  await manifest(root, "runs/missing", { failedAgentRuns: [{ key: "lost", searchCount: 0, queries: [] }] });
  const modernRun = await modern(root, "runs/modern", ["paid query"]);
  await manifest(root, "runs/modern", { agentRuns: [{ ...modernRun.record, searchCount: 0, queries: [] }] });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 0);
  assert.equal(result.unverifiedAttempts.length, 3);
});

test("other markets/dates do not charge, and deep event/artifact directories are not scanned", async t => {
  const root = await temporary(t);
  await legacy(root, "runs/current", ["current"]);
  await manifest(root, "runs/china", { market: "CN", failedAgentRuns: [null] });
  await manifest(root, "runs/old", { marketAsOf: "2026-09-30", agentRuns: [null] });
  for (const name of ["artifacts", "events", "native-attempts", "a/b/c/d"]) {
    const run = await manifest(root, name, {});
    await writeFile(resolve(run, "manifest.json"), "malformed ignored file");
  }
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 1);
  assert.equal(result.unverifiedAttempts.length, 0);
});

test("damaged matching collections and unparseable manifests remain explicit unknown consumption", async t => {
  const root = await temporary(t), malformed = await manifest(root, "runs/unknown", {});
  await writeFile(resolve(malformed, "manifest.json"), "{");
  await manifest(root, "runs/damaged", { agentRuns: [null], failedAgentRuns: {} });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.unverifiedAttempts.length, 3);
  assert.equal(result.knownQueryCount, 0);
  assert.ok(result.unverifiedAttempts.every(item => typeof item.reason === "string"));
});

test("standard unrelated run names scope corrupt manifests, but ambiguous ancestors do not", async t => {
  const root = await temporary(t);
  for (const name of ["runs/CN-2026-10-01-other-market", "runs/US-2026-09-30-other-date", "runs/CN-2026-09-30-both"]) {
    const run = await manifest(root, name, {});
    await writeFile(resolve(run, "manifest.json"), "{");
  }
  const unrelated = await marketSessionQueryConsumption(root, session);
  assert.equal(unrelated.knownQueryCount, 0);
  assert.equal(unrelated.unverifiedAttempts.length, 0);
  for (const name of ["runs/US-2026-10-01-current", "CN-2026-09-30-parent/ambiguous-child"]) {
    const run = await manifest(root, name, {});
    await writeFile(resolve(run, "manifest.json"), "{");
  }
  const current = await marketSessionQueryConsumption(root, session);
  assert.equal(current.unverifiedAttempts.length, 2);
  assert.ok(current.unverifiedAttempts.some(attempt => attempt.manifest.endsWith("ambiguous-child/manifest.json")));
});

test("an empty or incomplete attempt list cannot erase declared paid queries", async t => {
  const root = await temporary(t);
  await manifest(root, "runs/empty", { searchQueryCount: 2 });
  await legacy(root, "runs/incomplete", ["verified lower bound"], { manifest: { searchQueryCount: 3 } });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.knownQueryCount, 1);
  assert.equal(result.unverifiedAttempts.length, 2);
  assert.ok(result.unverifiedAttempts.every(item => /exceed verifiable/.test(item.reason)));
});

test("initialize rejects an exhausted session before creating a fresh run or launching an agent", async t => {
  const [{ MarketWorkflow }, { fixtureInput }] = await Promise.all([
    import("../scripts/daily-workflow.mjs"), import("./daily-v10-fixture.mjs"),
  ]);
  const root = await temporary(t), workflow = new MarketWorkflow({
    input: fixtureInput(), market: "US", workRoot: root, codexBin: "/unused", completeRecap: true,
  });
  const queries = Array.from({ length: workflow.searchQueryLimit + 1 }, (_, i) => `previous paid search ${i}`);
  const historical = await modern(root, "old-version-attempt-4", queries, { failed: true });
  await manifest(root, "old-version-attempt-4", {
    marketAsOf: workflow.envelope.marketAsOf, workflowVersion: "previous-workflow-version",
    inputHash: "previous-input-hash", cutoffAt: "previous-cutoff", attempt: 4, status: "failed",
    searchQueryCount: queries.length, failedAgentRuns: [historical.record],
  });
  const paths = ["manifest.json", historical.record.eventArtifact, historical.record.receiptArtifact];
  const before = await Promise.all(paths.map(path => readFile(resolve(historical.run, path))));
  const directories = await readdir(root);
  let nativeCalls = 0;
  workflow.runAgent = async () => { nativeCalls += 1; throw new Error("Unexpected native invocation"); };
  await assert.rejects(workflow.initialize(), /本交易日资料核查已达停止条件/);
  assert.equal(nativeCalls, 0);
  assert.equal(workflow.manifest, null);
  assert.equal(workflow.searchQueryCount, 0);
  await assert.rejects(readFile(workflow.manifestPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), directories);
  for (const [i, path] of paths.entries()) assert.deepEqual(await readFile(resolve(historical.run, path)), before[i]);
});
