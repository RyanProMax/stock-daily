import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";
import { assessRecapEvidenceCoverage, completeRecapPlan } from "../scripts/complete-recap.mjs";
import { planRecapResearchRepair } from "../scripts/recap-research-repair.mjs";
import { MarketWorkflow, agentStageFingerprint, assertResearchQueryCount } from "../scripts/daily-workflow.mjs";
import { stableHash, parseAgentEvents } from "../scripts/daily-workflow-core.mjs";

function fixture() {
  const f = recapFixture();
  for (const [index, sector] of f.envelope.sectorPerformance.entries()) sector.change = `${index < 3 ? -4 + index : 0.01}%`;
  f.plan = completeRecapPlan(f.envelope);
  f.coverage = assessRecapEvidenceCoverage(f.envelope, f.ledger);
  for (const entry of f.attribution.entries) if (f.envelope.sectorPerformance.slice(0, 3).some(sector => sector.symbol === entry.target)) {
    entry.basis = "unresolved"; entry.chains = [];
    entry.counterAssessment = "The available current facts do not establish a signed target transmission; independently verify a specific event and test contrary explanations.";
  }
  return f;
}

test("bounded repair selects unresolved targets deterministically, retaining flat targets and semantic objections", () => {
  const f = fixture();
  const plan = () => planRecapResearchRepair(f.plan, f.ledger, f.coverage, f.attribution, { remainingQueries: 12 });
  const one = plan();
  assert.deepEqual(one, plan());
  assert.deepEqual(one.jobs.map(job => job.target), f.envelope.sectorPerformance.slice(0, 3).map(sector => sector.symbol));
  assert.ok(one.jobs.every(job => job.feedback.includes("signed target transmission") && job.feedback.includes("not instructions") && job.queryAllowance === 4));
  assert.equal(one.queryAllowance, 12);
  for (const entry of f.attribution.entries) entry.basis = "reported";
  const flat = f.attribution.entries.find(entry => entry.target === f.envelope.sectorPerformance[3].symbol);
  flat.basis = "unresolved"; flat.chains = [];
  f.plan.anomalies.find(anomaly => anomaly.target === flat.target).observation.change = "+0.00%";
  assert.deepEqual(plan().jobs.map(job => job.target), [flat.target]);
  flat.basis = "reported";
  assert.equal(plan().jobs.length, 0);
});

test("repair never allocates an incomplete research pair or replenishes the fixed twelve-query allowance", () => {
  const f = fixture();
  for (const [remainingQueries, count] of [[0, 0], [3, 0], [4, 1], [7, 1], [8, 2], [12, 3], [100, 3]]) {
    const result = planRecapResearchRepair(f.plan, f.ledger, f.coverage, f.attribution, { remainingQueries });
    assert.equal(result.jobs.length, count);
    assert.equal(result.queryAllowance, count * 4);
  }
  for (const remainingQueries of [-1, NaN, 2.5]) assert.throws(() => planRecapResearchRepair(f.plan, f.ledger, f.coverage, f.attribution, { remainingQueries }));
  f.coverage.entries.pop();
  assert.throws(() => planRecapResearchRepair(f.plan, f.ledger, f.coverage, null, { remainingQueries: 12 }), /覆盖检查/);
});

test("near-flat baskets with large opposing company moves retain research priority and exclude already reviewed company causes", () => {
  const f = fixture();
  for (const entry of f.attribution.entries) entry.basis = "reported";
  const basket = f.plan.anomalies.find(anomaly => anomaly.kind === "ai_layer" && anomaly.observation.benchmarkKind === "equal_weight_basket");
  const sector = f.plan.anomalies.find(anomaly => anomaly.kind === "sector");
  Object.assign(basket.observation, { change: "+0.01%", constituents: [
    { symbol: "A", change: "+4.00%" }, { symbol: "B", change: "-3.96%" }, { symbol: "C", change: "+0.00%" }, { symbol: "D", change: "+0.00%" },
  ] });
  sector.observation.change = "-0.50%";
  const reviewed = f.attribution.entries.find(entry => entry.target === basket.target);
  reviewed.basis = "unresolved"; reviewed.chains = [{ basis: "reported", subjectTargets: ["A"] }];
  f.attribution.entries.find(entry => entry.target === sector.target).basis = "unresolved";
  const result = planRecapResearchRepair(f.plan, f.ledger, f.coverage, f.attribution, { remainingQueries: 4 });
  assert.equal(result.jobs[0].target, basket.target);
  assert.equal(result.jobs[0].absoluteClosingReturn, 0.01);
  assert.equal(result.jobs[0].priorityMagnitude, 0.99);
  assert.deepEqual(result.jobs[0].unresolvedConstituents, ["B", "C", "D"]);
  assert.match(result.jobs[0].feedback, /Missing constituent causes: B, C, D/);
  assert.match(result.jobs[0].feedback, /numeric offsets as causes/);
  assert.deepEqual(result, planRecapResearchRepair(f.plan, f.ledger, f.coverage, f.attribution, { remainingQueries: 4 }));
});

test("two tool operations with batched extra queries cannot masquerade as the two-query research contract", () => {
  const events = batches => batches.map((queries, index) => JSON.stringify({ type: "item.completed", item: { id: `search-${index}`, type: "web_search", action: { type: "search", queries } } })).concat(JSON.stringify({ type: "turn.completed" })).join("\n");
  const valid = parseAgentEvents(events([["initial focused query"], ["adaptive focused query"]]), { requireSearch: true });
  assert.doesNotThrow(() => assertResearchQueryCount(valid, "causal"));
  const invalid = parseAgentEvents(events([["initial", "AP", "Reuters", "Yahoo"], ["adaptive"]]), { requireSearch: true });
  assert.equal(invalid.searchCount, 5);
  assert.throws(() => assertResearchQueryCount(invalid, "causal"), /实际 5 条/);
});

function mockResearchProcesses(workflow, calls) {
  // Controlled process records test checkpoint and cumulative-budget behavior;
  // they are not external searches or market/report acceptance.
  workflow.runAgent = async ({ key, role, payload, promptSuffix }) => {
    const fingerprint = await agentStageFingerprint(role, payload, promptSuffix);
    const checkpoint = await workflow.readAgentCheckpoint({ key, ...fingerprint });
    if (checkpoint) return checkpoint;
    if (workflow.searchQueryCount + 2 > workflow.searchQueryLimit) throw new Error("Mock research exceeded cumulative query capacity");
    calls.push({ key, role, payload: structuredClone(payload), promptSuffix });
    const queries = [0, 1].map(index => `${payload.marketAsOf} US ${payload.anomaly.target} ${role} repair ${index} original event explanation`);
    const output = { contractVersion: "stock-daily-evidence-worker-v1", role, market: "US", anomalyId: payload.anomaly.id, outcome: "none", queries, sources: [], alternatives: [{ claim: "A competing company-specific event remains unverified.", status: "unresolved", sourceUrls: [] }] };
    const outputText = JSON.stringify(output);
    const events = [...queries.map(query => JSON.stringify({ type: "item.completed", item: { type: "web_search", action: { type: "search", queries: [query] } } })), JSON.stringify({ type: "turn.completed" })].join("\n");
    await writeFile(resolve(workflow.runDir, "artifacts", `${key}.json`), outputText);
    await writeFile(resolve(workflow.runDir, "events", `${key}.jsonl`), events);
    workflow.manifest.stages[key] = { status: "completed", role, ...fingerprint, outputHash: stableHash(outputText), eventHash: stableHash(events) };
    workflow.manifest.agentRuns.push({ key, role, searchCount: 2, queries });
    workflow.searchQueryCount += 2;
    await workflow.saveManifest();
    return { output, events, resumed: false };
  };
}

test("repair reuses exact completed pairs after budget exhaustion and keeps failed evidence unresolved", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-recap-repair-"));
  try {
    const f = fixture(), calls = [];
    const create = async () => {
      const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true, workRoot: root });
      await workflow.initialize();
      mockResearchProcesses(workflow, calls);
      workflow.verifyEvidence = async outputs => {
        assert.equal(outputs.length, 6);
        assert.ok(outputs.every(output => output.outcome === "none"));
        return f.ledger;
      };
      return workflow;
    };
    const workflow = await create();
    workflow.searchQueryCount = 80;
    workflow.manifest.agentRuns.push({ key: "controlled-primary-research", searchCount: 80, queries: [] });
    await workflow.saveManifest();
    const input = { plan: f.plan, outputs: [], ledger: f.ledger, coverage: f.coverage, attribution: f.attribution };
    const result = await workflow.repairCompleteRecapResearch(input);
    assert.equal(result.researched, true);
    assert.equal(calls.length, 6);
    assert.equal(workflow.searchQueryCount, 92);
    assert.deepEqual(result.ledger, f.ledger);
    assert.equal(f.attribution.entries.filter(entry => entry.basis === "unresolved").length, 3);
    assert.ok(calls.every(call => call.payload.sharedEvidence.length === f.ledger.sources.length));
    const resumed = await create();
    assert.equal(resumed.searchQueryCount, 92);
    await resumed.repairCompleteRecapResearch({ ...input, outputs: [] });
    assert.equal(calls.length, 6, "resume must not issue new queries after cumulative exhaustion");
    const proof = Object.values(resumed.manifest.recapResearchRepairPlans)[0];
    const contextPath = resolve(resumed.runDir, "artifacts", proof.contextArtifact);
    const context = JSON.parse(await readFile(contextPath, "utf8"));
    context.sharedEvidence[0].facts = "Altered evidence must not invalidate and replace a trusted checkpoint silently.";
    await writeFile(contextPath, JSON.stringify(context));
    await assert.rejects(() => resumed.repairCompleteRecapResearch({ ...input, outputs: [] }), /冻结输入重建/);
    assert.equal(calls.length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a changed repair payload cannot reuse completed flags to overspend the cumulative search budget", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-recap-repair-budget-"));
  try {
    const f = fixture(), calls = [];
    const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true, workRoot: root });
    await workflow.initialize(); mockResearchProcesses(workflow, calls);
    workflow.searchQueryCount = 80; workflow.verifyEvidence = async () => f.ledger;
    const input = { plan: f.plan, outputs: [], ledger: f.ledger, coverage: f.coverage, attribution: f.attribution };
    await workflow.repairCompleteRecapResearch(input);
    const key = calls[0].key;
    workflow.manifest.stages[key].promptHash = "changed-prompt";
    await workflow.saveManifest();
    await assert.rejects(() => workflow.repairCompleteRecapResearch({ ...input, outputs: [] }), /预算不足/);
    assert.equal(calls.length, 6);
    assert.equal(workflow.searchQueryCount, 92);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("three repair targets keep at most four isolated native roles active", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-recap-repair-concurrency-"));
  try {
    const f = fixture(), calls = [];
    const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true, workRoot: root });
    await workflow.initialize(); mockResearchProcesses(workflow, calls);
    const run = workflow.runAgent;
    let active = 0, peak = 0;
    workflow.runAgent = async input => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 10)); return await run(input); }
      finally { active--; }
    };
    workflow.searchQueryCount = 80; workflow.verifyEvidence = async () => f.ledger;
    await workflow.repairCompleteRecapResearch({ plan: f.plan, outputs: [], ledger: f.ledger, coverage: f.coverage, attribution: f.attribution });
    assert.equal(calls.length, 6); assert.equal(peak, 4); assert.equal(active, 0); assert.equal(workflow.searchQueryCount, 92);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed repair target does not skip later targets or discard their verified ledger and coverage", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-recap-repair-partial-"));
  try {
    const f = fixture(), calls = [];
    const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true, workRoot: root });
    await workflow.initialize(); mockResearchProcesses(workflow, calls);
    const plan = planRecapResearchRepair(f.plan, f.ledger, f.coverage, f.attribution, { remainingQueries: 12 });
    const failed = plan.jobs[1].target, research = workflow.researchAnomaly.bind(workflow), targets = [];
    workflow.researchAnomaly = async (anomaly, feedback) => { targets.push(anomaly.target); if (anomaly.target === failed) throw new Error("Controlled unavailable worker"); return research(anomaly, feedback); };
    workflow.searchQueryCount = 80;
    workflow.verifyEvidence = async outputs => { assert.equal(outputs.length, 4); return f.ledger; };
    await assert.rejects(() => workflow.repairCompleteRecapResearch({ plan: f.plan, outputs: [], ledger: f.ledger, coverage: f.coverage, attribution: f.attribution }), /补证未完成/);
    assert.deepEqual(targets, plan.jobs.map(job => job.target)); assert.equal(calls.length, 4); assert.equal(workflow.searchQueryCount, 88);
    assert.equal(workflow.manifest.recapResearchRepair.status, "incomplete");
    assert.deepEqual(workflow.manifest.recapResearchRepair.failures, [{ target: failed, reason: "Controlled unavailable worker" }]);
    const ledger = JSON.parse(await readFile(resolve(workflow.runDir, "artifacts/recap-ledger.json"), "utf8"));
    const coverage = JSON.parse(await readFile(resolve(workflow.runDir, "artifacts/recap-coverage.json"), "utf8"));
    assert.equal(stableHash(ledger), workflow.manifest.recapLedgerHash);
    assert.deepEqual(coverage, workflow.manifest.recapCoverage); assert.deepEqual(ledger, f.ledger);
  } finally { await rm(root, { recursive: true, force: true }); }
});
