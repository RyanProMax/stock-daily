import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertWorkflowImplementation, workflowImplementationSnapshot } from "../scripts/workflow-implementation.mjs";
import { MarketWorkflow } from "../scripts/daily-workflow.mjs";
import { auditWorkflowCausalEvidence } from "../scripts/daily-workflow-publish.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";

test("the scheduler's persisted source receipt is checked before research loads the collected input", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-scheduled-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "implementation.json"), execute = promisify(execFile);
  await execute(process.execPath, [resolve("scripts/workflow-implementation.mjs"), "--snapshot", path]);
  await execute(process.execPath, [resolve("scripts/workflow-implementation.mjs"), "--check", path]);
  await writeFile(path, JSON.stringify({ ...(await workflowImplementationSnapshot()), hash: "different-collector-source" }));
  await assert.rejects(execute(process.execPath, ["--input-type=module", "-e", `import {MarketWorkflow} from './scripts/daily-workflow.mjs'; import {fixtureInput} from './tests/daily-v10-fixture.mjs'; await new MarketWorkflow({input:fixtureInput(),market:'US',codexBin:'/unused',workRoot:${JSON.stringify(resolve(root, "runs"))}}).initialize();`], { env: { ...process.env, STOCK_DAILY_IMPLEMENTATION_SNAPSHOT: path } }), /源码.*变更/);
});

test("workflow source receipts reject changed code, data, prompts, dependencies and newly added runtime files", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-implementation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originals = { "AGENTS.md": "Reader quality rules", "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: '9.0'", "scripts/research.mjs": "export const date = '2026-10-01';", "data/tickers.json": '["MU"]', "docs/daily-agents/researcher.md": "Verify the original source." };
  for (const [path, text] of Object.entries(originals)) { await mkdir(resolve(root, path, ".."), { recursive: true }); await writeFile(resolve(root, path), text); }
  const receipt = await workflowImplementationSnapshot(root);
  await assertWorkflowImplementation(receipt, root);
  for (const [path, text] of Object.entries(originals)) {
    await writeFile(resolve(root, path), `${text}\nchanged`);
    await assert.rejects(assertWorkflowImplementation(receipt, root), /源码.*变更/);
    await writeFile(resolve(root, path), text);
  }
  await writeFile(resolve(root, "scripts/new-parser.mjs"), "export default true;");
  await assert.rejects(assertWorkflowImplementation(receipt, root), /源码.*变更/);
  await rm(resolve(root, "scripts/new-parser.mjs"));
  await assertWorkflowImplementation(receipt, root);
  const forged = structuredClone(receipt); forged.files["data/tickers.json"] = "invented";
  await assert.rejects(assertWorkflowImplementation(forged, root), /源码.*变更/);
});

test("a changed runtime fingerprint prevents another native invocation and publication validation", async t => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-guard-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", codexBin: "/unused", workRoot });
  await workflow.initialize();
  assert.ok(Object.keys(workflow.manifest.implementation.files).length > 90);
  workflow.manifest.implementation.hash = "different-runtime";
  await assert.rejects(workflow.runAgent({ key: "planner", role: "planner", payload: workflow.envelope, inputArtifacts: [] }), /源码.*变更/);
  assert.equal(workflow.manifest.agentRuns.length, 0);
  assert.deepEqual(workflow.manifest.stages, {});
  await assert.rejects(auditWorkflowCausalEvidence({ manifest: workflow.manifest, report: {}, manifestPath: workflow.manifestPath, input: workflow.input }), /源码.*变更/);
});

test("resumption refuses a missing or replaced implementation receipt before reusing checkpoints", async t => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-resume-guard-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const options = { input: fixtureInput(), market: "US", codexBin: "/unused", workRoot };
  const first = new MarketWorkflow(options); await first.initialize();
  const manifest = structuredClone(first.manifest);
  for (const receipt of [undefined, { ...manifest.implementation, hash: "replaced" }]) {
    await writeFile(first.manifestPath, JSON.stringify({ ...manifest, implementation: receipt }));
    const resumed = new MarketWorkflow(options);
    await assert.rejects(resumed.initialize(), /源码.*变更/);
  }
});
