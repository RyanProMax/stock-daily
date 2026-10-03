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
  const run = await manifest(root, name, {}), prompt = options.target
    ? `<task_input_json>${JSON.stringify({ ...session, anomaly: { id: options.anomalyId ?? "recap-fixture", target: options.target } })}</task_input_json>`
    : "Controlled query-budget fixture; no native process.", schemaText = '{}';
  const schemaHash = stableHash(schemaText), call = { agentRunId: options.agentRunId ?? randomUUID(), key: options.key ?? (options.target ? `${options.anomalyId ?? "recap-fixture"}-${options.role ?? "facts"}` : "facts"), role: options.role ?? "facts", ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    schemaHash, promptHash: stableHash({ prompt, schemaHash, filesystemIsolation: AGENT_FILESYSTEM_ISOLATION }) };
  const refs = await beginNativeAgentAttempt(run, call, { prompt, schemaText }), raw = events(queries, options.failed ? "turn.failed" : "turn.completed");
  await writeFile(resolve(run, refs.eventStreamArtifact), raw);
  const receipt = await finishNativeAgentAttempt(run, call, { events: raw, completedAt: options.completedAt ?? "2026-10-02T00:00:00Z", exitCode: options.failed ? 1 : 0 });
  const record = { ...call, ...receipt, eventHash: stableHash(raw), queries, searchCount: queries.length };
  await manifest(root, name, { [options.failed ? "failedAgentRuns" : "agentRuns"]: [record], ...options.manifest });
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

test("a changed input/version cannot reset the frozen trading-session time ceilings", async t => {
  const root = await temporary(t);
  await manifest(root, "runs/old", { workflowVersion: "old", inputHash: "old", coverageRequired: true,
    workflowBudgetMs: 3_300_000, workflowElapsedMs: 3_258_508,
    workflowSessions: [{ startedAt: "2026-10-02T01:01:10.485Z", elapsedMs: 3_258_508, budgetMs: 3_300_000 }],
    researchBudgetMs: 2_100_000, researchElapsedMs: 2_090_559,
    researchSessions: [{ startedAt: "2026-10-02T01:02:24.069Z", elapsedMs: 2_090_559, budgetMs: 2_100_000 }] });
  await manifest(root, "runs/new", { workflowVersion: "new", inputHash: "new", coverageRequired: true,
    workflowBudgetMs: 9_000_000, workflowElapsedMs: 50_000,
    workflowSessions: [{ startedAt: "2026-10-02T02:01:12.206Z", elapsedMs: 50_000, budgetMs: 9_000_000 }],
    researchBudgetMs: 9_000_000, researchElapsedMs: 10_000,
    researchSessions: [{ startedAt: "2026-10-02T02:12:29.798Z", elapsedMs: 10_000, budgetMs: 9_000_000 }] });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.unverifiedAttempts.length, 0);
  assert.equal(result.timeBudgets.workflow.limitMs, 3_300_000);
  assert.equal(result.timeBudgets.workflow.elapsedMs, 3_308_508);
  assert.equal(result.timeBudgets.research.limitMs, 2_100_000);
  assert.equal(result.timeBudgets.research.elapsedMs, 2_100_559);
});

test("copied time sessions charge once and retain the greatest elapsed checkpoint and smallest ceiling", async t => {
  const root = await temporary(t), startedAt = "2026-10-02T01:00:00Z";
  await manifest(root, "runs/original", { researchBudgetMs: 90_000, researchElapsedMs: 40_000,
    researchSessions: [{ startedAt, elapsedMs: 40_000, budgetMs: 90_000 }] });
  await manifest(root, "backup", { researchBudgetMs: 900_000, researchElapsedMs: 50_000,
    researchSessions: [{ startedAt: "2026-10-02T01:00:00.000Z", elapsedMs: 50_000, budgetMs: 900_000 }] });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.unverifiedAttempts.length, 0);
  assert.equal(result.timeBudgets.research.elapsedMs, 50_000);
  assert.equal(result.timeBudgets.research.limitMs, 90_000);
  assert.equal(result.timeBudgets.research.sessions.length, 1);
  assert.equal(result.timeBudgets.research.sessions[0].budgetMs, 90_000);
});

test("legacy elapsed clocks migrate conservatively and damaged time declarations fail closed", async t => {
  const root = await temporary(t);
  await manifest(root, "runs/legacy", { coverageRequired: true, startedAt: "2026-10-02T01:00:00Z", updatedAt: "2026-10-02T01:50:00Z",
    researchStartedAt: "2026-10-02T01:10:00Z", researchElapsedMs: 2_090_559 });
  const migrated = await marketSessionQueryConsumption(root, session);
  assert.equal(migrated.unverifiedAttempts.length, 0);
  assert.equal(migrated.timeBudgets.workflow.elapsedMs, 3_000_000);
  assert.equal(migrated.timeBudgets.workflow.limitMs, 3_300_000);
  assert.equal(migrated.timeBudgets.research.elapsedMs, 2_090_559);
  assert.equal(migrated.timeBudgets.research.limitMs, 2_100_000);
  await manifest(root, "runs/damaged", { researchBudgetMs: 90_000, researchElapsedMs: 50_000,
    researchSessions: [{ startedAt: "2026-10-02T02:00:00Z", elapsedMs: 1_000 }] });
  const damaged = await marketSessionQueryConsumption(root, session);
  assert.ok(damaged.unverifiedAttempts.some(attempt => /exceeds retained sessions/.test(attempt.reason)));
});

test("role attempts follow audited target/role across runs, including zero-search invalid attempts and receipt copies", async t => {
  const root = await temporary(t);
  const first = await modern(root, "runs/first", [], { target: "AI-US-applications", failed: true });
  await manifest(root, "runs/first", { failedAgentRuns: [{ ...first.record, status: "invalid" }] });
  const second = await modern(root, "runs/second", ["paid before timeout"], { target: "AI-US-applications", anomalyId: "recap-upgraded-fixture", failed: true });
  const copy = await manifest(root, "backup", { failedAgentRuns: [first.record] });
  await cp(resolve(first.run, "native-attempts"), resolve(copy, "native-attempts"), { recursive: true });
  await modern(root, "runs/causal", [], { target: "AI-US-applications", role: "causal" });
  await modern(root, "runs/directed-repair", ["new targeted support"], { target: "AI-US-applications", key: "recap-fixture-facts-repair-abcdef" });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.unverifiedAttempts.length, 0);
  const facts = result.roleAttempts.find(role => role.target === "AI-US-applications" && role.role === "facts");
  assert.equal(facts.attemptCount, 2);
  assert.equal(facts.scope, "primary");
  assert.deepEqual(new Set(facts.agentRunIds), new Set([first.record.agentRunId, second.record.agentRunId]));
  assert.equal(result.roleAttempts.find(role => role.role === "causal").attemptCount, 1);
});

test("next trading day and another market retain independent time and role budgets", async t => {
  const root = await temporary(t);
  await manifest(root, "runs/other-day", { marketAsOf: "2026-09-30", researchBudgetMs: 1, researchSessions: [null] });
  await manifest(root, "runs/other-market", { market: "CN", workflowBudgetMs: 1, workflowSessions: [null] });
  const result = await marketSessionQueryConsumption(root, session);
  assert.equal(result.unverifiedAttempts.length, 0);
  assert.deepEqual(result.timeBudgets, { workflow: { elapsedMs: 0, limitMs: null, sessions: [] }, research: { elapsedMs: 0, limitMs: null, sessions: [] } });
  assert.deepEqual(result.roleAttempts, []);
});
