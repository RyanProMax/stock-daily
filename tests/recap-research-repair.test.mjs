import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";
import { assessRecapEvidenceCoverage, completeRecapPlan } from "../scripts/complete-recap.mjs";
import { planRecapResearchRepair } from "../scripts/recap-research-repair.mjs";
import { MarketWorkflow, agentStageFingerprint, assertResearchQueryCount, recapAttributionEvidenceHash } from "../scripts/daily-workflow.mjs";
import { validateRecapAttribution, RecapAttributionEvidenceSelectionError } from "../scripts/recap-attribution.mjs";
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

async function controlledCompleteWorkflow(root) {
  const f = recapFixture(), calls = [];
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true, workRoot: root,
    transmissionCollector: async () => f.transmissionData,
    companyBackgroundCollector: async () => f.companyBackgroundData,
    pbocNewsCollector: async () => f.pbocNewsData,
  });
  await workflow.initialize();
  for (const [name, hashKey, value] of [["social-ledger.json", "socialHash", f.social], ["recap-trading-data.json", "tradingHash", f.tradingData], ["recap-macro-data.json", "macroHash", f.macroData]]) {
    await writeFile(resolve(workflow.runDir, "artifacts", name), JSON.stringify(value));
    workflow.manifest[hashKey] = stableHash(value);
  }
  workflow.prepareRecapNewsOriginals = async () => { workflow.newsOriginalsBook = { snapshots: [] }; };
  workflow.researchPrimaryRole = async (anomaly, role, suffix = "", excludedSources = []) => suffix
    ? MarketWorkflow.prototype.researchPrimaryRole.call(workflow, anomaly, role, suffix, excludedSources)
    : { anomalyId: anomaly.id, role, sources: [], rejectedSources: [], alternatives: [] };
  workflow.verifyEvidence = async () => f.ledger;
  // Explicitly controlled accounting, not proof of actual market searches.
  workflow.searchQueryCount = 80;
  mockResearchProcesses(workflow, calls);
  return { f, workflow, calls };
}

function mockAttributionRefusal(workflow, output, onReview = () => {}) {
  // Persist controlled raw output/events just as the production stage does.
  // These records are not genuine native invocations or report acceptance.
  workflow.runValidatedAgentStage = async ({ baseKey, role, maxAttempts, validate }) => {
    assert.equal(role, "recap_attributor"); assert.equal(maxAttempts, 1); onReview();
    const key = `${baseKey}-attempt-1`, outputText = JSON.stringify(output), events = JSON.stringify({ type: "turn.completed" });
    await writeFile(resolve(workflow.runDir, "artifacts", `${key}.json`), outputText);
    await writeFile(resolve(workflow.runDir, "events", `${key}.jsonl`), events);
    workflow.manifest.stages[key] = { status: "completed", role, outputHash: stableHash(outputText), eventHash: stableHash(events) };
    try { validate(output); assert.fail("Invalid inference must not be approved"); }
    catch (error) { await workflow.invalidateAgentStage(key, error); throw error; }
  };
}

test("a located attribution refusal reaches bounded repair and resumes without repeating an unchanged failed review", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-attribution-entry-"));
  try {
    const { f, workflow, calls } = await controlledCompleteWorkflow(root);
    const invalid = structuredClone(f.attribution);
    invalid.entries[0].basis = "inferred";
    let reviews = 0;
    mockAttributionRefusal(workflow, invalid, () => reviews++);
    const selectedTargets = [], research = workflow.researchAnomaly.bind(workflow);
    workflow.researchAnomaly = async (anomaly, feedback) => { selectedTargets.push(anomaly.target); return research(anomaly, feedback); };
    await assert.rejects(workflow.runCompleteRecap(), RecapAttributionEvidenceSelectionError);
    assert.equal(reviews, 1); assert.equal(calls.length, 6); assert.equal(workflow.searchQueryCount, 92);
    assert.deepEqual(workflow.manifest.recapResearchRepairBudget, { startQueryCount: 80, queryLimit: 92 });
    const diagnostic = JSON.parse(await readFile(resolve(workflow.runDir, "artifacts/recap-attributor-repair-only-rejection.json"), "utf8"));
    assert.equal(diagnostic.approved, false); assert.equal(diagnostic.repairOnly, true);
    assert.deepEqual(diagnostic.rejectedOutput, invalid);
    assert.equal(diagnostic.nativeOutputHash, workflow.manifest.stages["recap-attributor-attempt-1"].outputHash);
    assert.equal(selectedTargets[0], "SPX", "repair must select the located refusal before larger movers");
    const spxCalls = calls.filter(call => call.payload.anomaly.target === "SPX");
    assert.equal(spxCalls.length, 2);
    assert.ok(spxCalls.every(call => call.promptSuffix.includes(diagnostic.error)));
    assert.equal(workflow.manifest.recapApproval, undefined);
    await assert.rejects(workflow.runCompleteRecap(), RecapAttributionEvidenceSelectionError);
    assert.equal(reviews, 1, "same evidence and located refusal must not spend another native review");
    assert.equal(calls.length, 6, "exact repair checkpoints must not search twice");
    assert.equal(workflow.searchQueryCount, 92);
    assert.equal(workflow.manifest.recapResearchRepairBudget.queryLimit, 92);
    assert.throws(() => validateRecapAttribution(invalid, f.envelope, f.plan.anomalies.map(a => ({ symbol: a.target, ...a.observation, kind: a.kind })), f.ledger, { requireComplete: true }), RecapAttributionEvidenceSelectionError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a restored refusal rejects corrupted details, error, output and native records before repair", async () => {
  for (const corruption of ["details", "error", "replacement", "output", "events", "nativeHash", "stageError", "malformedRestoration"]) {
    const root = await mkdtemp(resolve(tmpdir(), "stock-daily-attribution-corruption-"));
    try {
      const { f, workflow, calls } = await controlledCompleteWorkflow(root);
      const invalid = structuredClone(f.attribution);
      invalid.entries[0].basis = "inferred";
      let reviews = 0, repairs = 0;
      mockAttributionRefusal(workflow, invalid, () => reviews++);
      const repair = workflow.repairCompleteRecapResearch.bind(workflow);
      workflow.repairCompleteRecapResearch = async args => { repairs++; return repair(args); };
      await assert.rejects(workflow.runCompleteRecap(), RecapAttributionEvidenceSelectionError);
      assert.equal(repairs, 1);
      const path = resolve(workflow.runDir, "artifacts/recap-attributor-repair-only-rejection.json");
      const diagnostic = JSON.parse(await readFile(path, "utf8"));
      const stage = workflow.manifest.stages["recap-attributor-attempt-1"];
      if (corruption === "details") Object.assign(diagnostic.details, { target: "WRONG-TARGET", selectionIsArray: false, evidenceIds: null });
      if (corruption === "error") diagnostic.error += " Altered diagnostic.";
      if (corruption === "replacement") {
        diagnostic.rejectedOutput.entries[0].counterAssessment += " Altered rejected output.";
        diagnostic.outputHash = stableHash(diagnostic.rejectedOutput);
      }
      if (corruption === "output") await writeFile(resolve(workflow.runDir, "artifacts/recap-attributor-attempt-1.json"), JSON.stringify({ ...invalid, altered: true }));
      if (corruption === "events") await writeFile(resolve(workflow.runDir, "events/recap-attributor-attempt-1.jsonl"), "Altered event stream.");
      if (corruption === "nativeHash") diagnostic.nativeOutputHash = "wrong-native-output";
      if (corruption === "stageError") stage.error += " Altered stage error.";
      if (corruption === "malformedRestoration") {
        diagnostic.rejectedOutput.entries[0].chains[0].mechanismEvidenceIds = null;
        diagnostic.outputHash = stableHash(diagnostic.rejectedOutput);
        const outputText = JSON.stringify(diagnostic.rejectedOutput);
        stage.outputHash = diagnostic.nativeOutputHash = stableHash(outputText);
        await writeFile(resolve(workflow.runDir, "artifacts/recap-attributor-attempt-1.json"), outputText);
      }
      await writeFile(path, JSON.stringify(diagnostic));
      await assert.rejects(workflow.runCompleteRecap(), /复盘补证诊断/u, corruption);
      assert.equal(repairs, 1, `${corruption} must fail before repair planning`);
      assert.equal(reviews, 1, `${corruption} must not be disguised as a fresh review`);
      assert.equal(calls.length, 6); assert.equal(workflow.searchQueryCount, 92);
      assert.equal(workflow.manifest.recapApproval, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("unchanged verified evidence reordered on resume retains the exact refusal and consumed budget", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-attribution-order-"));
  try {
    const { f, workflow, calls } = await controlledCompleteWorkflow(root);
    for (const id of ["mechanism-b", "mechanism-a"]) f.ledger.sources.push({ ...f.ledger.sources[0], id, kind: "background", scope: "market", publishedAt: "2026-01-28", targets: ["SPX"], backgroundSubjects: ["SPX"], causalConnection: false, timingChecked: true });
    const invalid = structuredClone(f.attribution);
    invalid.entries[0].basis = "inferred";
    let reviews = 0;
    mockAttributionRefusal(workflow, invalid, () => reviews++);
    await assert.rejects(workflow.runCompleteRecap(), RecapAttributionEvidenceSelectionError);
    const path = resolve(workflow.runDir, "artifacts/recap-attributor-repair-only-rejection.json");
    const prior = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(prior.details.availableApplicableMechanisms.map(source => source.id), ["mechanism-a", "mechanism-b"]);
    const hash = recapAttributionEvidenceHash(f.ledger);
    f.ledger.sources.reverse();
    assert.equal(recapAttributionEvidenceHash(f.ledger), hash);
    await assert.rejects(workflow.runCompleteRecap(), error => error instanceof RecapAttributionEvidenceSelectionError && stableHash(error.details) === stableHash(prior.details));
    assert.equal(reviews, 1); assert.equal(calls.length, 6); assert.equal(workflow.searchQueryCount, 92);
    assert.equal(workflow.manifest.recapResearchRepairBudget.queryLimit, 92);
    assert.equal(workflow.manifest.recapApproval, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("execution and other integrity failures never become evidence repair", async () => {
  for (const message of ["Native process timeout", "Workflow implementation hash mismatch", "Native receipt integrity mismatch", "Attribution schema is malformed"]) {
    const root = await mkdtemp(resolve(tmpdir(), "stock-daily-attribution-fatal-"));
    try {
      const { workflow, calls } = await controlledCompleteWorkflow(root);
      const failure = new Error(message);
      workflow.runValidatedAgentStage = async () => { throw failure; };
      await assert.rejects(workflow.runCompleteRecap(), error => error === failure);
      assert.equal(calls.length, 0);
      assert.equal(workflow.manifest.recapResearchRepairBudget, undefined);
      assert.equal(workflow.manifest.recapApproval, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("a malformed mechanism field remains fatal rather than spending the research repair allowance", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-attribution-shape-"));
  try {
    const { f, workflow, calls } = await controlledCompleteWorkflow(root);
    const invalid = structuredClone(f.attribution);
    invalid.entries[0].chains[0].mechanismEvidenceIds = null;
    workflow.runValidatedAgentStage = async ({ validate }) => validate(invalid);
    await assert.rejects(workflow.runCompleteRecap(), error => error instanceof RecapAttributionEvidenceSelectionError && error.details.selectionIsArray === false);
    assert.equal(calls.length, 0);
    assert.equal(workflow.manifest.recapResearchRepairBudget, undefined);
    assert.equal(workflow.manifest.recapApproval, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attribution retry identity ignores receipt clocks and ordering but retains substantive scope and facts", () => {
  const f = recapFixture(), same = structuredClone(f.ledger);
  same.sources.reverse();
  for (const source of same.sources) { source.verifiedAt = "2026-10-02T08:00:00Z"; source.candidateHash = "new-receipt-only"; }
  assert.equal(recapAttributionEvidenceHash(same), recapAttributionEvidenceHash(f.ledger));
  same.sources[0].scope = "company";
  assert.notEqual(recapAttributionEvidenceHash(same), recapAttributionEvidenceHash(f.ledger));
  same.sources[0].scope = f.ledger.sources.at(-1).scope;
  same.sources[0].facts = "A substantively new verified event must allow fresh review.";
  assert.notEqual(recapAttributionEvidenceHash(same), recapAttributionEvidenceHash(f.ledger));
});

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
    const changed = structuredClone(input);
    changed.attribution.entries[0].counterAssessment += " Additional unresolved qualification.";
    const next = await workflow.repairCompleteRecapResearch({ ...changed, outputs: [] });
    assert.equal(next.researched, false, "a different repair plan cannot replenish the phase allowance");
    assert.equal(calls.length, 6);
    assert.equal(workflow.manifest.recapResearchRepairBudget.queryLimit, 92);
    const diagnosticChange = await workflow.repairCompleteRecapResearch({ ...input, outputs: [], repairOnlyDiagnostics: [{ target: "SPX", reason: "A newly located refusal does not grant a fresh research budget." }] });
    assert.equal(diagnosticChange.researched, false, "changed diagnostic input cannot replenish the exhausted phase allowance");
    assert.equal(calls.length, 6); assert.equal(workflow.searchQueryCount, 92);
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
