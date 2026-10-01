import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beginNativeAgentAttempt, finishNativeAgentAttempt, auditNativeAgentAttempt, nativeSearchQueries } from "../scripts/native-agent-receipts.mjs";
import { AGENT_FILESYSTEM_ISOLATION, stableHash } from "../scripts/daily-workflow-core.mjs";
import { MarketWorkflow, persistWorkflowArtifacts, targetResearchEvidence } from "../scripts/daily-workflow.mjs";
import { auditWorkflowCausalEvidence } from "../scripts/daily-workflow-publish.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";

const schemaText = '{"type":"object"}', prompt = "Controlled test invocation; no native process was launched.";
function invocation(role = "causal") {
  const schemaHash = stableHash(schemaText);
  return { agentRunId: randomUUID(), key: "same-stage", role, startedAt: new Date().toISOString(), schemaHash, promptHash: stableHash({ prompt, schemaHash, filesystemIsolation: AGENT_FILESYSTEM_ISOLATION }) };
}
const events = queries => queries.map(query => JSON.stringify({ type: "item.completed", item: { type: "web_search", action: { type: "search", queries: [query] } } })).join("\n") + "\n";
async function capture(root, call, queries, code, outputText = null) {
  const refs = await beginNativeAgentAttempt(root, call, { prompt, schemaText });
  const stream = events(queries);
  await writeFile(resolve(root, refs.eventStreamArtifact), stream);
  const receipt = await finishNativeAgentAttempt(root, call, { events: stream, stderr: "", outputText, exitCode: code, completedAt: new Date().toISOString() });
  return { ...call, ...receipt, eventHash: stableHash(stream), queries, searchCount: queries.length, status: code ? "failed" : "completed" };
}
async function temporary(t) {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-native-receipts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a retry of the same stage preserves failed native bytes and both actual query charges", async t => {
  const root = await temporary(t);
  const failed = await capture(root, invocation(), ["first actual query", "second actual query"], 1);
  const oldBytes = await readFile(resolve(root, failed.eventArtifact), "utf8");
  const success = await capture(root, invocation(), ["retry first query", "retry second query"], 0, "{}");
  assert.notEqual(success.eventArtifact, failed.eventArtifact);
  assert.equal(await readFile(resolve(root, failed.eventArtifact), "utf8"), oldBytes);
  assert.equal((await auditNativeAgentAttempt(root, failed)).receipt.queries.length, 2);
  assert.equal((await auditNativeAgentAttempt(root, success)).outputText, "{}");
  assert.equal(failed.searchCount + success.searchCount, 4);
  await assert.rejects(beginNativeAgentAttempt(root, failed, { prompt, schemaText }), /EEXIST/);
  await assert.rejects(auditNativeAgentAttempt(root, { ...failed, searchCount: 0 }), /accounting/);
  await assert.rejects(auditNativeAgentAttempt(root, { ...success, outputArtifact: "../outside.json" }), /identity/);
});

test("actual duplicate searches retain their execution count; invented declared queries do not create credit", async t => {
  const root = await temporary(t);
  const record = await capture(root, invocation(), ["same query", "same query"], 1);
  assert.equal((await auditNativeAgentAttempt(root, record)).receipt.queries.length, 2);
  const fake = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"queries":["never executed"]}' } });
  assert.deepEqual(nativeSearchQueries(fake), []);
  assert.deepEqual(nativeSearchQueries(events(["executed"]) + '{"type":"item.completed"'), ["executed"]);
});

test("resume freezes an interrupted native stream and charges its actual searches once", async t => {
  const root = await temporary(t), options = { input: fixtureInput(), market: "US", workRoot: root };
  const first = new MarketWorkflow(options);
  await first.initialize();
  const call = invocation("facts"), refs = await beginNativeAgentAttempt(first.runDir, call, { prompt, schemaText });
  const stream = events(["completed before interruption"]) + '{"type":"item.started"';
  await writeFile(resolve(first.runDir, refs.eventStreamArtifact), stream);
  first.manifest.stages[call.key] = { ...call, ...refs, status: "running", timeoutMs: 1000 };
  await first.saveManifest();
  const resumed = new MarketWorkflow(options);
  await resumed.initialize();
  assert.equal(resumed.searchQueryCount, 1);
  const record = resumed.manifest.failedAgentRuns[0];
  assert.equal((await auditNativeAgentAttempt(resumed.runDir, record)).receipt.capture, "interrupted");
  const again = new MarketWorkflow(options);
  await again.initialize();
  assert.equal(again.searchQueryCount, 1);
  await writeFile(resolve(first.runDir, refs.eventStreamArtifact), stream + "later child output");
  await assert.rejects(new MarketWorkflow(options).initialize(), /advanced after capture/);
});

test("changed prompt, schema, output and raw events cannot reuse a native receipt", async t => {
  const root = await temporary(t), record = await capture(root, invocation(), ["first", "second"], 0, "{}");
  for (const field of ["promptArtifact", "schemaArtifact", "outputArtifact", "eventArtifact"]) {
    const path = resolve(root, record[field]), bytes = await readFile(path, "utf8");
    await writeFile(path, bytes + "changed");
    await assert.rejects(auditNativeAgentAttempt(root, record), /changed/);
    await writeFile(path, bytes);
  }
});

test("publication auditing and latest-run artifact copies retain and recheck failed attempts", async t => {
  const root = await temporary(t), record = await capture(root, invocation(), ["paid first", "paid second"], 1);
  const ledger = { sources: [], rejected: [], alternatives: [] };
  const manifest = { agentRuns: [], failedAgentRuns: [record], stages: { evidence: { role: "deterministic_source_verification", status: "completed", outputHash: stableHash(ledger) } } };
  const manifestPath = resolve(root, "manifest.json"), reportPath = resolve(root, "report.json");
  await mkdir(resolve(root, "artifacts"));
  await Promise.all([
    writeFile(resolve(root, "artifacts/evidence-ledger.json"), JSON.stringify(ledger)),
    writeFile(resolve(root, "artifacts/review-final.json"), "{}"),
    writeFile(manifestPath, JSON.stringify(manifest)),
    writeFile(reportPath, "{}"),
  ]);
  await auditWorkflowCausalEvidence({ manifest, report: { drivers: [], aiChainUpdates: [] }, manifestPath });
  const project = resolve(root, "alias-project"), aliasRoot = resolve(project, "work");
  await persistWorkflowArtifacts({ manifestPath, reportPath }, project);
  assert.equal((await auditNativeAgentAttempt(aliasRoot, record)).receipt.queries.length, 2);
  await writeFile(resolve(aliasRoot, record.eventArtifact), "changed alias");
  await assert.rejects(persistWorkflowArtifacts({ manifestPath, reportPath }, project), /changed/);
  assert.equal((await auditNativeAgentAttempt(root, record)).receipt.queries.length, 2);
  await writeFile(resolve(root, record.eventArtifact), "changed original");
  await assert.rejects(auditWorkflowCausalEvidence({ manifest, report: { drivers: [], aiChainUpdates: [] }, manifestPath }), /changed/);
});

test("research retains exact target backgrounds and all current competing leads without changing scope", () => {
  const sources = [
    { id: "local", kind: "background", targets: ["XLRE"], supportingExcerpt: "Complete exact source passage" },
    { id: "member", kind: "background", targets: ["other-basket"], backgroundSubjects: ["AMT"] },
    { id: "unrelated", kind: "background", targets: ["XLK"] },
    { id: "factor", kind: "observation", targets: ["DGS10"] },
    { id: "competing", kind: "official", targets: ["XLE"], scope: "event_only" },
  ];
  const before = stableHash(sources), result = targetResearchEvidence(sources, { target: "XLRE", observation: { constituents: [{ symbol: "AMT" }] } });
  assert.deepEqual(result.map(x => x.id), ["local", "member", "factor", "competing"]);
  assert.equal(stableHash(sources), before);
  assert.equal(result[0].supportingExcerpt, sources[0].supportingExcerpt);
  assert.deepEqual(result[3].targets, ["XLE"]);
  result[0].targets.push("tampered");
  assert.equal(stableHash(sources), before);
});
