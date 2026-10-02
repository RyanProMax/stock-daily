import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MarketWorkflow } from "../scripts/daily-workflow.mjs";
import { completeRecapPlan } from "../scripts/complete-recap.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";

function fixture() {
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true });
  workflow.manifest = { stages: {}, agentRuns: [], failedAgentRuns: [] };
  workflow.saveManifest = async () => {};
  return { workflow, plan: completeRecapPlan(workflow.envelope) };
}

test("all primary targets retain their successful peers before bounded failed-role recovery", async () => {
  const { workflow, plan } = fixture(), calls = [], outputs = [], pending = [];
  workflow.researchPrimaryRole = async (anomaly, role) => {
    const key = `${anomaly.id}-${role}`, attempt = workflow.primaryRoleAttempts(key) + 1;
    calls.push({ key, attempt }); workflow.searchQueryCount += 2;
    const record = { key, agentRunId: randomUUID(), searchCount: 2, queries: ["controlled test query A", "controlled test query B"] };
    if (anomaly.id === plan.anomalies[0].id && role === "facts") {
      workflow.manifest.failedAgentRuns.push(record); workflow.manifest.stages[key] = { status: "failed" };
      throw new Error("controlled native capacity failure");
    }
    workflow.manifest.agentRuns.push(record); workflow.manifest.stages[key] = { status: "completed" };
    return { anomalyId: anomaly.id, role, sources: [] };
  };
  for (let i = 0; i < plan.anomalies.length; i += 2) pending.push(...await workflow.researchCompleteRecapBatch(plan.anomalies.slice(i, i + 2), String(i / 2), outputs));
  assert.equal(calls.length, 40); assert.equal(outputs.length, 39); assert.equal(pending.length, 1); assert.equal(workflow.searchQueryCount, 80);
  assert.ok(outputs.some(o => o.anomalyId === plan.anomalies[0].id && o.role === "causal")); assert.ok(outputs.some(o => o.anomalyId === plan.anomalies.at(-1).id));
  const failed = await workflow.researchCompleteRecapBatch([], "0", outputs, { recovery: true, pending });
  assert.equal(failed.length, 1); assert.equal(calls.length, 41); assert.equal(workflow.searchQueryCount, 82); assert.equal(workflow.manifest.failedAgentRuns.length, 2);
  await workflow.researchCompleteRecapBatch([], "0", outputs, { recovery: true, pending });
  assert.equal(calls.length, 41, "a resumed failed role cannot get a third native invocation");
  assert.equal(workflow.searchQueryCount, 82); assert.equal(outputs.length, 39);
});

test("individual primary roles must validate actual search execution and declared/planned queries", async () => {
  const { workflow, plan } = fixture(), anomaly = plan.anomalies[0], role = "facts", key = `${anomaly.id}-${role}`;
  const queries = [...anomaly.factQueries, `${workflow.envelope.marketAsOf} US ${anomaly.target} original company facts additional search`];
  const output = { contractVersion: "stock-daily-evidence-worker-v1", market: "US", role, anomalyId: anomaly.id, outcome: "none", queries, sources: [], alternatives: [{ claim: "No verified current-session cause was found in this controlled test.", status: "unresolved", sourceUrls: [] }] };
  const events = queries.map(query => JSON.stringify({ type: "item.completed", item: { type: "web_search", action: { type: "search", queries: [query] } } })).join("\n") + '\n{"type":"turn.completed"}';
  workflow.runAgent = async () => { workflow.manifest.stages[key] = { status: "completed" }; return { output, events }; };
  assert.equal((await workflow.researchPrimaryRole(anomaly, role)).outcome, "none");
  for (const raw of ["", events.split("\n")[0], events + "\n" + events]) {
    workflow.runAgent = async () => { workflow.manifest.stages[key] = { status: "completed" }; return { output, events: raw }; };
    await assert.rejects(workflow.researchPrimaryRole(anomaly, role)); assert.equal(workflow.manifest.stages[key].status, "invalid");
  }
});

test("an unverified completed flag cannot grant a third native attempt or reserve its query cost", async () => {
  const { workflow, plan } = fixture(), anomaly = plan.anomalies[0], key = `${anomaly.id}-facts`;
  workflow.manifest.agentRuns = [{ key, agentRunId: "controlled-first" }, { key, agentRunId: "controlled-second" }];
  workflow.manifest.stages[key] = { status: "completed" };
  workflow.readAgentCheckpoint = async () => null;
  workflow.researchPrimaryRole = async () => { throw new Error("A third invocation must not be reached"); };
  const failures = await workflow.researchCompleteRecapBatch([], "0", [], { recovery: true, pending: [{ anomaly, role: "facts", batchKey: "0" }] });
  assert.equal(failures.length, 1); assert.match(workflow.manifest.recapResearchRoles[key].error, /两次原始执行机会/);
  workflow.searchQueryCount = workflow.searchQueryLimit - 2;
  assert.equal(await workflow.assertResearchCapacity([anomaly], "", [], { skipExhaustedPrimary: true }), 2);
  await assert.rejects(workflow.assertResearchCapacity([anomaly]), /预算不足/);
});
