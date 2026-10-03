import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { MarketWorkflow } from "../scripts/daily-workflow.mjs";
import { AGENT_FILESYSTEM_ISOLATION, stableHash } from "../scripts/daily-workflow-core.mjs";
import { beginNativeAgentAttempt, finishNativeAgentAttempt } from "../scripts/native-agent-receipts.mjs";
import { marketSessionQueryConsumption } from "../scripts/market-session-query-budget.mjs";
import { workflowImplementationSnapshot } from "../scripts/workflow-implementation.mjs";

const session = { market: "US", marketAsOf: "2026-10-01" };
const stopped = /本交易日资料核查已达停止条件/;
function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-budget-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = Object.create(MarketWorkflow.prototype);
  Object.assign(workflow, {
    workRoot: root, runDir: resolve(root, "current"), market: session.market,
    envelope: { marketAsOf: session.marketAsOf }, searchQueryCount: 0,
    reservedSearchQueryCount: 0, searchQueryLimit: 6,
    manifest: { ...session, implementation: await workflowImplementationSnapshot(), agentRuns: [], failedAgentRuns: [] },
    readAgentCheckpoint: async () => null, saveManifest: async () => {},
    finishResearchBudget: async () => {},
  });
  return { root, workflow };
}
async function original(root, name, queries, { failed = false, target = null, anomalyId = null } = {}) {
  const run = resolve(root, name), prompt = target
    ? `<task_input_json>${JSON.stringify({ ...session, anomaly: { id: anomalyId, target } })}</task_input_json>`
    : "Local budget test; no process is launched.", schemaText = "{}";
  await mkdir(run, { recursive: true });
  const schemaHash = stableHash(schemaText), call = {
    agentRunId: randomUUID(), key: anomalyId ? `${anomalyId}-facts` : name, role: "facts", schemaHash,
    promptHash: stableHash({ prompt, schemaHash, filesystemIsolation: AGENT_FILESYSTEM_ISOLATION }),
  };
  const refs = await beginNativeAgentAttempt(run, call, { prompt, schemaText });
  const raw = [...queries.map(query => ({ type: "item.completed", item: { type: "web_search", action: { type: "search", query } } })),
    { type: failed ? "turn.failed" : "turn.completed" }].map(event => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(resolve(run, refs.eventStreamArtifact), raw);
  const receipt = await finishNativeAgentAttempt(run, call, { events: raw, completedAt: "2026-10-02T00:00:00Z", exitCode: failed ? 1 : 0 });
  const record = { ...call, ...receipt, eventHash: stableHash(raw), queries, searchCount: queries.length };
  await writeFile(resolve(run, "manifest.json"), JSON.stringify({ ...session,
    agentRuns: failed ? [] : [record], failedAgentRuns: failed ? [record] : [], searchQueryCount: queries.length }));
  return record;
}
function invoke(workflow, key) {
  return workflow.runAgent({ key, role: "facts", payload: {}, inputArtifacts: [] });
}

test("a call completed during budget I/O cannot reopen spent capacity at the real search entry", async t => {
  const { root, workflow } = await fixture(t);
  await original(root, "previous-version", ["old one", "old two", "old three", "old four"]);
  workflow.reservedSearchQueryCount = 2;
  let researchEntries = 0;
  workflow.startResearchBudget = async () => { researchEntries += 1; throw new Error("Unexpected research entry"); };
  workflow.saveManifest = async () => {
    const completed = await original(root, "current", ["finishing one", "finishing two"]);
    workflow.manifest.agentRuns = [completed];
    workflow.searchQueryCount = 2;
    workflow.reservedSearchQueryCount = 0;
  };
  await assert.rejects(invoke(workflow, "next"), stopped);
  assert.equal(researchEntries, 0);
  assert.equal(workflow.reservedSearchQueryCount, 0);
  assert.equal((await marketSessionQueryConsumption(root, session)).knownQueryCount, 6);
});

async function clockHistory(root, name, { researchElapsedMs, workflowElapsedMs = 0, researchBudgetMs = 2_100_000, workflowBudgetMs = 3_300_000 }) {
  const run = resolve(root, name);
  await mkdir(run, { recursive: true });
  await writeFile(resolve(run, "manifest.json"), JSON.stringify({
    ...session, status: "failed", workflowVersion: "prior-version", inputHash: "prior-input",
    researchBudgetMs, workflowBudgetMs, researchElapsedMs, workflowElapsedMs,
    researchSessions: [{ startedAt: "2026-10-02T01:00:00Z", elapsedMs: researchElapsedMs, budgetMs: researchBudgetMs }],
    workflowSessions: [{ startedAt: "2026-10-02T00:50:00Z", elapsedMs: workflowElapsedMs, budgetMs: workflowBudgetMs }],
    agentRuns: [], searchQueryCount: 0,
  }));
}

test("a changed input and larger configuration cannot restart a session with only nine seconds of research left", async t => {
  const { root, workflow } = await fixture(t);
  await clockHistory(root, "prior-cutoff", { researchElapsedMs: 2_090_559 });
  workflow.researchBudgetMs = 4_200_000;
  workflow.workflowTimeoutMs = 6_600_000;
  let nativeEntries = 0;
  workflow.startResearchBudget = async () => { nativeEntries += 1; throw new Error("Unexpected native entry"); };
  await assert.rejects(invoke(workflow, "new-input"), /本交易日研究时间已达停止条件/);
  assert.equal(nativeEntries, 0);
  assert.equal(workflow.reservedSearchQueryCount, 0);
});

test("a verified search checkpoint still returns after the session clock is exhausted", async t => {
  const { root, workflow } = await fixture(t);
  await clockHistory(root, "spent-clock", { researchElapsedMs: 2_100_000 });
  const checkpoint = { output: { retained: true }, events: "verified original", resumed: true };
  workflow.readAgentCheckpoint = async () => checkpoint;
  workflow.startResearchBudget = async () => { throw new Error("Unexpected new research"); };
  assert.equal(await invoke(workflow, "completed"), checkpoint);
  assert.equal(workflow.reservedSearchQueryCount, 0);
});

test("a call completed during history I/O cannot restore time to the trading session", async t => {
  const { root, workflow } = await fixture(t);
  await clockHistory(root, "current", { researchElapsedMs: 2_040_000 });
  workflow.researchBudgetMs = 2_100_000;
  workflow.saveManifest = async () => {
    workflow.manifest.researchSessions = [{ startedAt: "2026-10-02T01:00:00Z", elapsedMs: 2_090_559, budgetMs: 2_100_000 }];
  };
  await assert.rejects(invoke(workflow, "finishing-clock"), /本交易日研究时间已达停止条件/);
  assert.equal(workflow.reservedSearchQueryCount, 0);
});

test("a fresh local clock cannot lengthen the remaining frozen session deadline", async t => {
  const { root, workflow } = await fixture(t);
  await clockHistory(root, "nearly-spent", { researchElapsedMs: 2_040_000, workflowElapsedMs: 3_240_000 });
  workflow.workflowTimeoutMs = 6_600_000;
  workflow.researchBudgetMs = 4_200_000;
  await workflow.assertSessionSearchBudget();
  workflow.deadline = Date.now() + workflow.workflowTimeoutMs;
  workflow.now = () => new Date();
  workflow.researchDeadline = null;
  workflow.workflowSessionIndex = null;
  workflow.researchSessionIndex = null;
  await workflow.startResearchBudget();
  assert.ok(workflow.remainingTime() > 30_000 && workflow.remainingTime() <= 60_000);
  assert.ok(workflow.remainingResearchTime() > 30_000 && workflow.remainingResearchTime() <= 60_000);
});

test("zero-search invalid and failed original calls prevent a third primary role after an input change", async t => {
  const { root, workflow } = await fixture(t);
  const target = "AI-US-applications", anomalyId = "recap-original-target";
  await original(root, "invalid-zero", [], { failed: true, target, anomalyId });
  await original(root, "failed-recovery", ["paid one", "paid two"], { failed: true, target, anomalyId });
  await assert.rejects(workflow.runAgent({ key: `${anomalyId}-facts`, role: "facts", payload: { anomaly: { id: anomalyId, target } }, inputArtifacts: [] }), /该交易日研究角色已用完两次/);
  assert.equal(workflow.reservedSearchQueryCount, 0);
  assert.equal(workflow.reservedPrimaryRoleCounts?.size ?? 0, 0);
});

test("concurrent original calls cannot share the last primary-role execution opportunity", async t => {
  const { root, workflow } = await fixture(t);
  const target = "AI-US-applications", anomalyId = "recap-original-target";
  await original(root, "previous-role", [], { failed: true, target, anomalyId });
  const bothScanned = deferred(), releaseResearch = deferred();
  let saves = 0, researchEntries = 0;
  workflow.saveManifest = async () => { if (++saves === 2) bothScanned.resolve(); await bothScanned.promise; };
  workflow.startResearchBudget = async () => { researchEntries += 1; await releaseResearch.promise; throw new Error("Stop before native invocation"); };
  const call = () => workflow.runAgent({ key: `${anomalyId}-facts`, role: "facts", payload: { anomaly: { id: anomalyId, target } }, inputArtifacts: [] });
  const calls = [call(), call()].map(promise => promise.then(() => null, error => error));
  try {
    assert.match((await Promise.race(calls)).message, /该交易日研究角色已用完两次/);
    assert.equal(researchEntries, 1);
  } finally { releaseResearch.resolve(); }
  await Promise.all(calls);
  assert.equal(workflow.reservedSearchQueryCount, 0);
  assert.equal(workflow.reservedPrimaryRoleCounts.size, 0);
});

test("two real search entries compete for the final two slots and only one reserves them", async t => {
  const { root, workflow } = await fixture(t);
  await original(root, "previous-cutoff", ["old one", "old two", "old three", "old four"]);
  const bothScanned = deferred(), releaseResearch = deferred();
  let saves = 0, researchEntries = 0;
  workflow.saveManifest = async () => {
    if (++saves === 2) bothScanned.resolve();
    await bothScanned.promise;
  };
  workflow.startResearchBudget = async () => {
    researchEntries += 1;
    assert.equal(workflow.reservedSearchQueryCount, 2);
    await releaseResearch.promise;
    throw new Error("Test stops before any native process");
  };
  const calls = [invoke(workflow, "first"), invoke(workflow, "second")]
    .map(promise => promise.then(() => null, error => error));
  try {
    const firstFinished = await Promise.race(calls);
    assert.match(firstFinished.message, stopped);
    assert.equal(researchEntries, 1);
    assert.equal(workflow.reservedSearchQueryCount, 2);
  } finally {
    releaseResearch.resolve();
  }
  const errors = await Promise.all(calls);
  assert.equal(errors.filter(error => stopped.test(error.message)).length, 1);
  assert.equal(errors.filter(error => /Test stops before any native process/.test(error.message)).length, 1);
  assert.equal(workflow.reservedSearchQueryCount, 0);
});

test("verified current-run consumption is charged once alongside historical failed queries", async t => {
  const { root, workflow } = await fixture(t);
  await original(root, "failed-old-attempt", ["old paid one", "old paid two"], { failed: true });
  const current = await original(root, "current", ["current paid one", "current paid two"]);
  workflow.manifest.agentRuns = [current];
  workflow.searchQueryCount = 2;
  await workflow.assertSessionSearchBudget(2, { reserve: true });
  assert.equal(workflow.reservedSearchQueryCount, 2);
  await assert.rejects(workflow.assertSessionSearchBudget(2, { reserve: true }), stopped);
  assert.equal(workflow.reservedSearchQueryCount, 2);
  assert.equal((await marketSessionQueryConsumption(root, session)).knownQueryCount, 4);
});

test("a current legacy event with an agent identity still leaves the final two slots available", async t => {
  const { root, workflow } = await fixture(t);
  await original(root, "previous-version", ["historical one", "historical two"]);
  const queries = ["legacy current one", "legacy current two"];
  const raw = [...queries.map(query => ({ type: "item.completed", item: { type: "web_search", action: { type: "search", query } } })),
    { type: "turn.completed" }].map(event => JSON.stringify(event)).join("\n") + "\n";
  const record = {
    agentRunId: randomUUID(), key: "current-legacy", role: "facts",
    eventArtifact: "events/current-legacy.jsonl", eventHash: stableHash(raw),
    queries, searchCount: queries.length,
  };
  await mkdir(resolve(workflow.runDir, "events"), { recursive: true });
  await writeFile(resolve(workflow.runDir, record.eventArtifact), raw);
  await writeFile(resolve(workflow.runDir, "manifest.json"), JSON.stringify({
    ...session, agentRuns: [record], searchQueryCount: queries.length,
  }));
  workflow.manifest.agentRuns = [record];
  workflow.searchQueryCount = queries.length;
  await workflow.assertSessionSearchBudget(2, { reserve: true });
  assert.equal(workflow.reservedSearchQueryCount, 2);
  assert.equal((await marketSessionQueryConsumption(root, session)).knownQueryCount, 4);
});
