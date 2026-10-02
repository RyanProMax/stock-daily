import { workflowImplementationSnapshot } from "../scripts/workflow-implementation.mjs";
const implementation = await workflowImplementationSnapshot();
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  AGENT_FILESYSTEM_ISOLATION,
  WORKFLOW_VERSION,
  marketInputHash,
  stableHash,
  trimReaderSummary,
} from "../scripts/daily-workflow-core.mjs";
import {
  preserveInactiveStoredSlice,
  publishWorkflowReport,
  publishPreparedWorkflowReport,
  refreshInactiveAnalysis,
  reportAtOrBeforeDate,
  verifyWorkflowReadback,
  workflowCompletedSql,
  workflowIngestionCompletedSql,
  workflowIngestionFailedSql,
  workflowMarketContentHash,
} from "../scripts/daily-workflow-publish.mjs";
import { checkWorkflowArtifacts } from "../scripts/daily-workflow-check.mjs";
import {
  buildReportContent,
  validateReport,
} from "../scripts/daily-publish.mjs";
import {
  finalizePublishedWorkflowBatch,
  persistWorkflowArtifacts,
  recordedSeedHashesForMarket,
  recoverPendingPublications,
} from "../scripts/daily-workflow.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { validateCompleteRecap } from "../scripts/complete-recap.mjs";

test("standalone publisher reaches recovery readback without a circular module deadlock", async () => {
  const fixture = await completePublicationFixture();
  const entry = resolve("scripts/daily-workflow-publish.mjs");
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    process.argv = [process.execPath, ${JSON.stringify(entry)}, '--manifest', ${JSON.stringify(fixture.manifestPath)}];
    globalThis.fetch = async () => { process.stdout.write('readback-started'); process.exit(0); };
    await import(${JSON.stringify(new URL(`file://${entry}`).href)});
  `], { timeout: 10_000 });
  assert.equal(stdout, "readback-started");
});

test("combined report summaries end at a complete sentence instead of cutting a word or figure", () => {
  const first = "Oil eased by 1.4%, supporting stocks. ";
  const second = "Rate expectations formed the concurrent external backdrop.";
  assert.equal(trimReaderSummary(first + second, first.length + 20), first.trim());
  assert.equal(trimReaderSummary("油价回落，支持股市上涨。市场同时消化利率预期的变化。", 20), "油价回落，支持股市上涨。");
  assert.equal(trimReaderSummary("Unchanged short summary.", 100), "Unchanged short summary.");
  assert.equal(trimReaderSummary("市场消化利率预期变化后指数反弹", 8), "市场消化利率预…");
});

async function publicationFixture(
  directory = null,
  market = "US",
  batchMarkets = [market],
) {
  directory ??= await mkdtemp(resolve(tmpdir(), "stock-daily-publish-"));
  await mkdir(directory, { recursive: true });
  const input = fixtureInput();
  const report = fixtureReport(input);
  const ledger = { sources: [...report.drivers, ...report.aiChainUpdates].map((item) => ({
    role: "causal", causalConnection: true,
    url: item.evidence.find((source) => source.kind !== "market_data").source,
    supportingExcerpt: item.mechanism ?? item.implication,
  })) };
  const inputPath = resolve(directory, "input.json");
  const reportPath = resolve(directory, "report.json");
  const manifestPath = resolve(directory, "manifest.json");
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const inputHash = marketInputHash(input, market);
  const roles = ["planner", "facts", "causal", "adjudicator", "writer", "reviewer", "translator"];
  const review = {
    contractVersion: "stock-daily-market-review-v1",
    market,
    verdict: "pass",
    summary: "All active-market claims passed the isolated final review gate.",
    claimReviews: [{
      claimId: "fixture-claim",
      verdict: "pass",
      defectCodes: [],
      repairStage: "none",
      summary: "The fixture claim has grounded facts, direct causality and reader value.",
      scores: {
        factualAccuracy: 5,
        causalLogic: 4,
        evidenceDirectness: 5,
        readerUtility: 4,
      },
    }],
  };
  const manifest = {
    workflowVersion: WORKFLOW_VERSION,
    implementation,
    status: "ready",
    market,
    marketAsOf: "2026-08-21",
    reportDate: input.reportDate,
    inputHash,
    marketInputHash: inputHash,
    batchRunId: input.runId,
    batchMarkets,
    reportHash: stableHash(reportText),
    inputPath,
    reportPath,
    claimCount: 1,
    deliveryMode: "publish",
    stages: { "evidence-verification": { role: "deterministic_source_verification", status: "completed", outputHash: stableHash(ledger) } },
    evidence: { verifiedSourceCount: 2, rejectedSourceCount: 0 },
    approval: {
      verdict: "pass",
      reviewArtifact: "artifacts/review-final.json",
      reviewHash: stableHash(review),
      claimIds: ["fixture-claim"],
      scores: [{ claimId: "fixture-claim", ...review.claimReviews[0].scores }],
    },
    agentRuns: roles.map((role, index) => ({
      agentRunId: `agent-${index}`,
      role,
      ephemeral: true,
      filesystemIsolation: AGENT_FILESYSTEM_ISOLATION,
      status: "completed",
      promptHash: `prompt-${index}`,
      outputHash: `output-${index}`,
      inputArtifacts: role === "reviewer" ? ["draft.json"] : [],
    })),
  };
  const reviewPath = resolve(directory, "artifacts/review-final.json");
  await mkdir(resolve(directory, "artifacts"), { recursive: true });
  await Promise.all([
    writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8"),
    writeFile(reportPath, reportText, "utf8"),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "artifacts/evidence-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8"),
  ]);
  // Production stores the validator's canonical output, not the raw draft.
  const content = JSON.parse(buildReportContent(input, validateReport(report, input)));
  content.reportDate = input.reportDate;
  return { inputPath, reportPath, manifestPath, content, report };
}

test("latest workflow alias retains evidence and can be checked independently", async () => {
  const fixture = await publicationFixture();
  const projectDir = await mkdtemp(resolve(tmpdir(), "stock-daily-alias-"));
  await persistWorkflowArtifacts(fixture, projectDir);
  const result = await checkWorkflowArtifacts({
    manifestPath: resolve(projectDir, "work/daily-workflow-manifest.json"),
  });
  assert.equal(result.status, "valid");
  assert.deepEqual(
    JSON.parse(await readFile(resolve(projectDir, "work/artifacts/evidence-ledger.json"), "utf8")),
    JSON.parse(await readFile(resolve(fixture.manifestPath, "../artifacts/evidence-ledger.json"), "utf8")),
  );
});

async function completePublicationFixture() {
  const fixture = await publicationFixture();
  const f = recapFixture();
  const { snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } = await import("../scripts/evidence-source-snapshots.mjs");
  const { normalizedEvidenceText, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } = await import("../scripts/daily-source-audit.mjs");
  const { verifiedExternalSourceType } = await import("../scripts/source-registry.mjs");
  const headlines = JSON.parse(await readFile(resolve(fixture.manifestPath, "../artifacts/evidence-ledger.json"), "utf8"));
  for (const source of headlines.sources) Object.assign(source, { sourceType: verifiedExternalSourceType(source.url), status: 200, publishedAt: "2026-08-21T20:30:00Z", excerptHash: stableHash(normalizedEvidenceText(source.supportingExcerpt)) });
  const snapshots = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [...f.ledger.sources, ...headlines.sources].map(source => {
    const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    const rawBody = Buffer.from(`<html><head><meta property="article:published_time" content="${source.publishedAt}"></head><body>${escape(source.supportingExcerpt)}<footer>Additional original context for this isolated test publication source.</footer></body></html>`);
    return snapshotFromOpenedSource(source.url, { finalUrl: source.url, status: 200, contentType: "text/html", rawBody, text: sourceBodyText(rawBody), publishedAtCandidates: sourcePublishedAtCandidates(rawBody, "text/html", source.url), publishedDateCandidates: sourcePublishedDateCandidates(rawBody, "text/html", source.url) });
  }) };
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { requireComplete: true, attribution: f.attribution });
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.stages["evidence-verification"].outputHash = stableHash(headlines);
  const report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  const review = { market: "US", entries: recap.entries.map((entry) => ({ target: entry.target, verdict: "pass", scores: { factualAccuracy: 5, causality: 4, magnitude: 4, sourceIndependence: 5, readerUtility: 4 } })) };
  report.recaps = { US: recap };
  const reportText = JSON.stringify(report) + "\n";
  manifest.reportHash = stableHash(reportText);
  manifest.coverageRequired = true;
  manifest.recapLedgerHash = stableHash(f.ledger);
  manifest.tradingHash = stableHash(f.tradingData);
  manifest.macroHash = stableHash(f.macroData);
  manifest.socialHash = stableHash(f.social);
  manifest.recapAttributionHash = stableHash(f.attribution);
  manifest.transmissionHash = stableHash(f.transmissionData);
  manifest.companyBackgroundHash = stableHash(f.companyBackgroundData);
  manifest.pbocNewsHash = stableHash(f.pbocNewsData);
  manifest.sourceSnapshotsHash = stableHash(snapshots);
  manifest.recapApproval = { recapHash: stableHash(recap), draftHash: stableHash(f.raw), reviewHash: stableHash(review), attributionStage: "recap-attributor-attempt-1", writerStage: "recap-writer-attempt-1", reviewerStage: "recap-reviewer-attempt-1", status: "complete" };
  manifest.stages["recap-verification"] = { role: "deterministic_source_verification", status: "completed", outputHash: stableHash(f.ledger) };
  for (const [i, role, value, field] of [[0, "recap_writer", f.raw, "writerStage"], [1, "recap_reviewer", review, "reviewerStage"], [2, "recap_attributor", f.attribution, "attributionStage"]]) {
    const key = manifest.recapApproval[field];
    const run = { ...manifest.agentRuns[0], key, role, agentRunId: `recap-agent-${i}`, outputHash: stableHash(JSON.stringify(value) + "\n") };
    manifest.agentRuns.push(run);
    manifest.stages[key] = run;
  }
  const root = resolve(fixture.manifestPath, "../artifacts");
  await writeFile(resolve(root, "evidence-ledger.json"), JSON.stringify(headlines) + "\n");
  await writeFile(resolve(root, "recap-source-snapshots.json"), JSON.stringify(snapshots) + "\n");
  for (const [name, value] of Object.entries({ "recap-ledger.json": f.ledger, "recap-attribution.json": f.attribution, "recap-transmission-data.json": f.transmissionData, "recap-company-background-data.json": f.companyBackgroundData, "recap-pboc-news-data.json": f.pbocNewsData, "social-ledger.json": f.social, "recap-trading-data.json": f.tradingData, "recap-macro-data.json": f.macroData, "recap-draft.json": f.raw, "recap-review.json": review })) await writeFile(resolve(root, name), JSON.stringify(value) + "\n");
  await writeFile(resolve(root, `${manifest.recapApproval.attributionStage}.json`), JSON.stringify(f.attribution) + "\n");
  await writeFile(resolve(root, `${manifest.recapApproval.writerStage}.json`), JSON.stringify(f.raw) + "\n");
  await writeFile(resolve(root, `${manifest.recapApproval.reviewerStage}.json`), JSON.stringify(review) + "\n");
  await writeFile(fixture.reportPath, reportText);
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  return { ...fixture, report, manifest, review, root };
}

test("comprehensive publication and readback include all sector explanations", async () => {
  const fixture = await completePublicationFixture();
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  const prepared = refreshInactiveAnalysis(validateReport(fixture.report, input, { requireResearchAudit: false, activeMarket: "US" }), null, "US");
  const production = { ...JSON.parse(buildReportContent(input, prepared)), reportDate: input.reportDate, headline: prepared.headline, summary: prepared.summary, agentModel: "openai/codex-multi-agent" };
  let writes = 0;
  const result = await publishWorkflowReport(fixture, { comparisonRead: async () => null, execute: async () => { writes++; }, readback: async () => ({ report: production }) });
  assert.equal(result.status, "published");
  assert.equal(writes, 1);
  assert.equal(production.recaps.US.entries.length, 20);
  assert.equal((await verifyWorkflowReadback(fixture, { readback: async () => ({ report: production }) })).status, "published");
  production.recaps.US.entries[0].magnitude += " altered";
  await assert.rejects(verifyWorkflowReadback(fixture, { readback: async () => ({ report: production }), retryEqualMarketAsOfMismatch: true }), /不一致/);
});

test("the comprehensive latest alias retains exact independent writer and review artifacts", async () => {
  const fixture = await completePublicationFixture();
  const projectDir = await mkdtemp(resolve(tmpdir(), "stock-daily-complete-alias-"));
  await persistWorkflowArtifacts(fixture, projectDir);
  const result = await checkWorkflowArtifacts({ manifestPath: resolve(projectDir, "work/daily-workflow-manifest.json") });
  assert.equal(result.status, "valid");
  assert.equal(result.completeRecap, true);
  assert.equal(result.recapTargetCount, 20);
  assert.deepEqual(JSON.parse(await readFile(resolve(projectDir, "work/artifacts/recap-pboc-news-data.json"), "utf8")), recapFixture().pbocNewsData);
});

test("recap evidence, low review scores and rewritten reader claims stop before network writes", async () => {
  for (const mutation of ["ledger", "review", "report", "trading", "macro", "attribution", "transmission", "pboc-news", "source-snapshots"]) {
    const f = await completePublicationFixture();
    if (mutation === "ledger") await writeFile(resolve(f.root, "recap-ledger.json"), '{"sources":[]}');
    if (mutation === "trading") await writeFile(resolve(f.root, "recap-trading-data.json"), '{"entries":[]}');
    if (mutation === "macro") await writeFile(resolve(f.root, "recap-macro-data.json"), '{"context":{"rates":{"tenYear":999}}}');
    if (mutation === "attribution") await writeFile(resolve(f.root, "recap-attribution.json"), '{"entries":[]}');
    if (mutation === "transmission") await writeFile(resolve(f.root, "recap-transmission-data.json"), '{"sources":[]}');
    if (mutation === "pboc-news") await writeFile(resolve(f.root, "recap-pboc-news-data.json"), '{"articles":[]}');
    if (mutation === "source-snapshots") await writeFile(resolve(f.root, "recap-source-snapshots.json"), '{"snapshots":[]}');
    if (mutation === "review") {
      f.review.entries[0].scores.magnitude = 3;
      f.manifest.recapApproval.reviewHash = stableHash(f.review);
      await writeFile(resolve(f.root, "recap-review.json"), JSON.stringify(f.review));
    }
    if (mutation === "report") {
      f.report.recaps.US.entries[0].why += " another claim";
      const reportText = JSON.stringify(f.report) + "\n";
      f.manifest.reportHash = stableHash(reportText);
      await writeFile(f.reportPath, reportText);
    }
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    let writes = 0;
    await assert.rejects(publishWorkflowReport(f, { comparisonRead: async () => null, execute: async () => { writes++; } }), /哈希|审稿|不一致/);
    assert.equal(writes, 0);
  }
});

test("scheduled recovery excludes old reports without full coverage", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "stock-daily-old-recovery-"));
  await publicationFixture(resolve(directory, "old-run"));
  let writes = 0;
  const result = await recoverPendingPublications(directory, { requireCompleteRecap: true, verify: async () => { writes++; }, publishApproved: async () => { writes++; } });
  assert.deepEqual(result, []);
  assert.equal(writes, 0);
});

test("published canonical content passes independent readback and an idempotent retry", async () => {
  const fixture = await publicationFixture();
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  assert.equal(fixture.report.aiChainViews.US.mechanism, null);
  assert.equal(fixture.content.aiChainViews.US.mechanism, undefined);
  assert.notEqual(
    workflowMarketContentHash(JSON.parse(buildReportContent(input, fixture.report)), "US"),
    workflowMarketContentHash(fixture.content, "US"),
  );
  const reportForPublish = refreshInactiveAnalysis(
    validateReport(fixture.report, input, { requireResearchAudit: false, activeMarket: "US" }),
    null,
    "US",
  );
  const production = {
    ...JSON.parse(buildReportContent(input, reportForPublish)),
    reportDate: input.reportDate,
    headline: reportForPublish.headline,
    summary: reportForPublish.summary,
    agentModel: "openai/codex-multi-agent",
  };
  let writes = 0;
  const published = await publishWorkflowReport(fixture, {
    comparisonRead: async () => null,
    execute: async () => { writes += 1; return { ok: true }; },
    readback: async () => ({ report: production }),
  });
  const recovered = await verifyWorkflowReadback(fixture, {
    readback: async () => ({ report: production }),
    retryEqualMarketAsOfMismatch: true,
  });
  const retried = await publishWorkflowReport(fixture, {
    comparisonRead: async () => production,
    execute: async () => { writes += 1; },
  });
  assert.equal(writes, 1);
  for (const result of [published, recovered, retried]) {
    assert.equal(result.status, "published");
    assert.equal(result.marketContentHash, workflowMarketContentHash(production, "US"));
  }
});

test("artifact and publication gates reject price-only causal evidence even with an intact approval", async () => {
  const fixture = await publicationFixture();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  const ledgerPath = resolve(fixture.manifestPath, "../artifacts/evidence-ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  for (const source of ledger.sources) source.supportingExcerpt = "The index rose 1.7%. Semiconductor constituents rose 3%.";
  // Keep the source-stage digest intact: the defect is semantic, not tampering.
  manifest.stages["evidence-verification"].outputHash = stableHash(ledger);
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => checkWorkflowArtifacts(fixture), /已核验原文缺少因果联系/u);
  let writes = 0;
  await assert.rejects(() => publishWorkflowReport(fixture, { execute: async () => { writes += 1; } }), /已核验原文缺少因果联系/u);
  assert.equal(writes, 0);
});

test("production recovery compares only the active market slice", async () => {
  const fixture = await publicationFixture();
  const production = structuredClone(fixture.content);
  production.agentModel = "openai/codex-multi-agent";
  production.headline = fixture.report.headline;
  production.summary = fixture.report.summary;
  production.marketViews.CN.summary = "A newer China recap may coexist safely.";
  const result = await verifyWorkflowReadback(fixture, {
    readback: async () => ({ report: production }),
  });
  assert.equal(result.status, "published");
  assert.equal(result.market, "US");
  assert.equal(result.productionReport, production);
  assert.equal(
    result.marketContentHash,
    workflowMarketContentHash(fixture.content, "US"),
  );

  production.drivers.find((item) => item.market === "US").summary += " changed";
  const superseded = await verifyWorkflowReadback(fixture, {
    readback: async () => ({ report: production }),
  });
  assert.equal(superseded.status, "superseded");
  await assert.rejects(
    () =>
      verifyWorkflowReadback(fixture, {
        readback: async () => ({ report: production }),
        retryEqualMarketAsOfMismatch: true,
      }),
    /同交易日切片与当前待恢复稿不一致/u,
  );
});

test("production recovery rejects a fallback report from another date", async () => {
  const fixture = await publicationFixture();
  const stale = structuredClone(fixture.content);
  stale.reportDate = "2026-08-20";
  await assert.rejects(
    () =>
      verifyWorkflowReadback(fixture, {
        readback: async () => ({ report: stale }),
      }),
    new RegExp(`生产回读未返回目标日期 ${fixture.content.reportDate} 的日报`, "u"),
  );
});

test("a different-date comparison cannot short-circuit publication", async () => {
  const fixture = await publicationFixture();
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  const stale = structuredClone(fixture.content);
  stale.reportDate = "2026-08-20";
  stale.agentModel = "openai/codex-multi-agent";
  const reportForPublish = refreshInactiveAnalysis(
    validateReport(fixture.report, input, {
      requireResearchAudit: false,
      activeMarket: "US",
    }),
    stale,
    "US",
  );
  const expectedContent = preserveInactiveStoredSlice(
    JSON.parse(buildReportContent(input, reportForPublish)),
    stale,
    "US",
  );
  const productionAfter = {
    ...expectedContent,
    reportDate: input.reportDate,
    agentModel: "openai/codex-multi-agent",
    headline: reportForPublish.headline,
    summary: reportForPublish.summary,
  };
  let executed = false;
  const result = await publishWorkflowReport(fixture, {
    comparisonRead: async () => stale,
    execute: async () => {
      executed = true;
      return { ok: true };
    },
    readback: async () => ({ report: productionAfter }),
  });
  assert.equal(executed, true);
  assert.equal(result.status, "published");
});

test("a historical publication never inherits a future report slice", async () => {
  const fixture = await publicationFixture();
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  const future = structuredClone(fixture.content);
  future.reportDate = "2026-08-30";
  future.marketViews.CN.summary = "future China analysis must not leak backward";
  assert.equal(reportAtOrBeforeDate(future, input.reportDate), null);
  assert.equal(reportAtOrBeforeDate(fixture.content, input.reportDate), fixture.content);

  const reportForPublish = validateReport(fixture.report, input, {
    requireResearchAudit: false,
    activeMarket: "US",
  });
  const expectedContent = JSON.parse(buildReportContent(input, reportForPublish));
  const productionAfter = {
    ...expectedContent,
    reportDate: input.reportDate,
    agentModel: "openai/codex-multi-agent",
    headline: reportForPublish.headline,
    summary: reportForPublish.summary,
  };
  let executed = false;
  const result = await publishWorkflowReport(fixture, {
    comparisonRead: async () => future,
    execute: async () => {
      executed = true;
      return { ok: true };
    },
    readback: async () => ({ report: productionAfter }),
  });
  assert.equal(executed, true);
  assert.equal(result.status, "published");
  assert.notEqual(
    productionAfter.marketViews.CN.summary,
    future.marketViews.CN.summary,
  );
});

test("pending approved publication retries directly without workflow budget", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-pending-publish-"),
  );
  const fixture = await publicationFixture(resolve(workRoot, "approved-run"));
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  const baseMarketContentHash = workflowMarketContentHash({}, "US");
  manifest.publication = {
    status: "failed",
    attempt: { baseMarketContentHash },
  };
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  let publishCalls = 0;
  let finalizeCalls = 0;
  const result = await recoverPendingPublications(workRoot, {
    verify: async () => {
      throw new Error("生产回读的 US 市场切片不一致");
    },
    publishApproved: async (paths, options) => {
      publishCalls += 1;
      assert.equal(paths.manifestPath, fixture.manifestPath);
      assert.equal(
        options.expectedBaseMarketContentHash,
        baseMarketContentHash,
      );
      assert.equal(options.ingestionStatus, "running");
      return {
        status: "published",
        market: "US",
        marketAsOf: manifest.marketAsOf,
      };
    },
    finalize: async (input) => {
      finalizeCalls += 1;
      assert.equal(input.runId, manifest.batchRunId);
      return { status: "completed" };
    },
  });
  assert.equal(publishCalls, 1);
  assert.equal(finalizeCalls, 1);
  assert.equal(result[0].status, "published");
  assert.equal(result[0].ingestion.status, "completed");
  const saved = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(saved.publication.status, "published");
  assert.equal(saved.ingestionFinalization.status, "completed");
});

test("manual publication persists readback and completion for only the selected manifest", async () => {
  const workRoot=await mkdtemp(resolve(tmpdir(),"stock-daily-manual-publish-"));
  const selected=await completePublicationFixture();
  const other=await publicationFixture(resolve(workRoot,"other"),"CN");
  let writes=0;let finalizations=0;
  const result=await publishPreparedWorkflowReport({manifestPath:selected.manifestPath},{
    verify:async()=>{throw new Error("not published yet");},
    publishApproved:async(paths)=>{writes++;assert.equal(paths.manifestPath,selected.manifestPath);return {status:"published",market:"US",marketAsOf:"2026-08-21"};},
    finalize:async()=>{finalizations++;return {status:"completed"};},
  });
  assert.equal(result.status,"published");assert.equal(writes,1);assert.equal(finalizations,1);
  const saved=JSON.parse(await readFile(selected.manifestPath));
  assert.equal(saved.publication.status,"published");assert.equal(saved.ingestionFinalization.status,"completed");
  assert.equal(JSON.parse(await readFile(other.manifestPath)).publication,undefined);
});

test("manual production publication rejects a thin legacy report before any write or readback", async () => {
  const fixture = await publicationFixture();
  let externalCalls = 0;
  await assert.rejects(() => publishPreparedWorkflowReport(fixture, {
    verify: async () => { externalCalls++; },
    publishApproved: async () => { externalCalls++; },
    finalize: async () => { externalCalls++; },
  }), /完整板块复盘验收/);
  assert.equal(externalCalls, 0);
  const result = await checkWorkflowArtifacts(fixture);
  assert.equal(result.completeRecap, false);
  assert.equal(result.recapTargetCount, 0);
  await assert.rejects(() => checkWorkflowArtifacts({ ...fixture, requireComplete: true }), /完整板块复盘验收/);
});

test("publication recovery ignores incompatible workflow checkpoints", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-old-workflow-recovery-"),
  );
  const fixture = await publicationFixture(resolve(workRoot, "old-run"));
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.workflowVersion = "stock-daily-multi-agent-v21";
  manifest.publication = { status: "failed" };
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  let calls = 0;
  const results = await recoverPendingPublications(workRoot, {
    verify: async () => {
      calls += 1;
      throw new Error("old workflow must not be recovered");
    },
    publishApproved: async () => {
      calls += 1;
      throw new Error("old workflow must not be published");
    },
    finalize: async () => {
      calls += 1;
      throw new Error("old workflow must not be finalized");
    },
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("readback-only recovery finalizes the completed ingestion batch", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-readback-finalize-"),
  );
  const fixture = await publicationFixture(resolve(workRoot, "approved-run"));
  let publishCalls = 0;
  let finalizeCalls = 0;
  const results = await recoverPendingPublications(workRoot, {
    verify: async () => ({
      status: "published",
      market: "US",
      marketAsOf: "2026-08-21",
    }),
    publishApproved: async () => {
      publishCalls += 1;
      throw new Error("publication retry should not run");
    },
    finalize: async () => {
      finalizeCalls += 1;
      return { status: "completed" };
    },
  });
  assert.equal(publishCalls, 0);
  assert.equal(finalizeCalls, 1);
  assert.equal(results[0].status, "published");
  assert.equal(results[0].ingestion.status, "completed");
});

test("recovery retires an incomplete multi-market batch", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-incomplete-recovery-"),
  );
  const fixture = await publicationFixture(resolve(workRoot, "approved-run"));
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.batchMarkets = ["CN", "US"];
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  let finalizeCalls = 0;
  let retireCalls = 0;
  const results = await recoverPendingPublications(workRoot, {
    verify: async () => ({
      status: "published",
      market: "US",
      marketAsOf: manifest.marketAsOf,
    }),
    finalize: async () => {
      finalizeCalls += 1;
      return { status: "completed" };
    },
    retire: async (input, error) => {
      retireCalls += 1;
      assert.equal(input.runId, manifest.batchRunId);
      assert.match(error, /未形成可发布归因/u);
      return { status: "failed" };
    },
  });
  assert.equal(finalizeCalls, 0);
  assert.equal(retireCalls, 1);
  assert.equal(results[0].status, "published");
  assert.equal(results[0].ingestionFinalization.status, "abandoned");
  assert.equal(results[0].ingestionFinalization.phase, "batch_retirement");
  const saved = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(saved.ingestionFinalization.status, "abandoned");

  const repeated = await recoverPendingPublications(workRoot, {
    verify: async () => {
      throw new Error("abandoned batches must leave the recovery queue");
    },
    retire: async () => {
      throw new Error("abandoned batches must not be retired twice");
    },
  });
  assert.deepEqual(repeated, []);
});

test("failed ingestion finalization remains recoverable", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-finalize-retry-"),
  );
  const fixture = await publicationFixture(resolve(workRoot, "approved-run"));
  const verify = async () => ({
    status: "published",
    market: "US",
    marketAsOf: "2026-08-21",
  });
  const first = await recoverPendingPublications(workRoot, {
    verify,
    finalize: async () => {
      throw new Error("temporary finalization failure");
    },
  });
  assert.equal(first[0].status, "published");
  assert.equal(first[0].ingestionFinalization.status, "failed");
  assert.equal(
    first[0].ingestionFinalization.phase,
    "ingestion_finalization",
  );
  let saved = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(saved.publication.status, "published");
  assert.equal(saved.ingestionFinalization.status, "failed");

  const second = await recoverPendingPublications(workRoot, {
    verify,
    finalize: async () => ({ status: "completed" }),
  });
  assert.equal(second[0].status, "published");
  assert.equal(second[0].ingestion.status, "completed");
  saved = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(saved.ingestionFinalization.status, "completed");
});

test("normal batch finalization failure is checkpointed for recovery", async () => {
  const fixture = await publicationFixture();
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  const result = await finalizePublishedWorkflowBatch(
    input,
    [{
      status: "ready",
      market: "US",
      manifestPath: fixture.manifestPath,
      publication: { status: "published" },
    }],
    {
      finalize: async () => {
        throw new Error("temporary D1 finalization failure");
      },
    },
  );
  assert.equal(result.status, "failed");
  const saved = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(saved.publication, undefined);
  assert.equal(saved.ingestionFinalization.status, "failed");
  assert.match(saved.ingestionFinalization.error, /temporary D1/u);
});

test("publication recovery lets the newest approved attempt win", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-pending-order-"),
  );
  const older = await publicationFixture(resolve(workRoot, "z-older-run"));
  const newer = await publicationFixture(resolve(workRoot, "a-newer-run"));
  const [olderManifest, newerManifest] = await Promise.all(
    [older.manifestPath, newer.manifestPath].map(async (manifestPath) =>
      JSON.parse(await readFile(manifestPath, "utf8")),
    ),
  );
  olderManifest.completedAt = "2026-08-29T10:00:00.000Z";
  newerManifest.completedAt = "2026-08-29T10:05:00.000Z";
  await Promise.all([
    writeFile(
      older.manifestPath,
      `${JSON.stringify(olderManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      newer.manifestPath,
      `${JSON.stringify(newerManifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  let activeManifestPath = null;
  const publishCalls = [];
  const results = await recoverPendingPublications(workRoot, {
    verify: async (paths, options) => {
      assert.equal(options.retryEqualMarketAsOfMismatch, true);
      if (!activeManifestPath) throw new Error("no matching production report");
      return {
        status: paths.manifestPath === activeManifestPath
          ? "published"
          : "superseded",
        market: "US",
        marketAsOf: newerManifest.marketAsOf,
      };
    },
    publishApproved: async (paths, options) => {
      publishCalls.push(paths.manifestPath);
      if (paths.manifestPath === newer.manifestPath) {
        assert.equal(options.replaceableSameMarketContentHashes.length, 1);
      }
      activeManifestPath = paths.manifestPath;
      return {
        status: "published",
        market: "US",
        marketAsOf: newerManifest.marketAsOf,
      };
    },
    finalize: async () => ({ status: "completed" }),
  });
  assert.deepEqual(publishCalls, [newer.manifestPath]);
  assert.deepEqual(results.map((item) => item.status), ["published", "superseded"]);
});

test("a pending newest recovery defers older attempts from the same session", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-pending-blocks-older-"),
  );
  const older = await publicationFixture(resolve(workRoot, "older-run"));
  const newer = await publicationFixture(resolve(workRoot, "newer-run"));
  const [olderManifest, newerManifest] = await Promise.all(
    [older.manifestPath, newer.manifestPath].map(async (manifestPath) =>
      JSON.parse(await readFile(manifestPath, "utf8")),
    ),
  );
  olderManifest.completedAt = "2026-08-29T10:00:00.000Z";
  newerManifest.completedAt = "2026-08-29T10:05:00.000Z";
  await Promise.all([
    writeFile(
      older.manifestPath,
      `${JSON.stringify(olderManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      newer.manifestPath,
      `${JSON.stringify(newerManifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  const publishCalls = [];
  const results = await recoverPendingPublications(workRoot, {
    verify: async () => {
      throw new Error("production has no matching slice");
    },
    publishApproved: async (paths) => {
      publishCalls.push(paths.manifestPath);
      throw new Error("temporary publication failure");
    },
  });
  assert.deepEqual(publishCalls, [newer.manifestPath]);
  assert.deepEqual(results.map((item) => item.status), ["pending", "deferred"]);
  assert.equal(results[1].reason, "newer_attempt_pending");
});

test("newest recovery may replace a known older same-session slice", async () => {
  const fixture = await publicationFixture();
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  const olderProduction = structuredClone(fixture.content);
  olderProduction.agentModel = "openai/codex-multi-agent";
  olderProduction.drivers.find((item) => item.market === "US").summary +=
    " Older approved attempt.";
  const reportForPublish = refreshInactiveAnalysis(
    validateReport(fixture.report, input, {
      requireResearchAudit: false,
      activeMarket: "US",
    }),
    olderProduction,
    "US",
  );
  const expectedContent = preserveInactiveStoredSlice(
    JSON.parse(buildReportContent(input, reportForPublish)),
    olderProduction,
    "US",
  );
  const productionAfter = {
    ...expectedContent,
    reportDate: input.reportDate,
    agentModel: "openai/codex-multi-agent",
    headline: reportForPublish.headline,
    summary: reportForPublish.summary,
  };
  let executed = false;
  const result = await publishWorkflowReport(fixture, {
    comparisonRead: async () => olderProduction,
    replaceableSameMarketContentHashes: [
      workflowMarketContentHash(olderProduction, "US"),
    ],
    execute: async () => {
      executed = true;
      return { ok: true };
    },
    readback: async () => ({ report: productionAfter }),
  });
  assert.equal(executed, true);
  assert.equal(result.status, "published");
});

test("separate first-run market batches replace the recorded inactive slice", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-separate-seeds-"),
  );
  const first = await publicationFixture(
    resolve(workRoot, "first-us"),
    "US",
    ["US"],
  );
  const firstInput = JSON.parse(await readFile(first.inputPath, "utf8"));
  const firstReportForPublish = refreshInactiveAnalysis(
    validateReport(first.report, firstInput, {
      requireResearchAudit: false,
      activeMarket: "US",
    }),
    null,
    "US",
  );
  const firstExpectedContent = JSON.parse(
    buildReportContent(firstInput, firstReportForPublish),
  );
  const firstProduction = {
    ...firstExpectedContent,
    reportDate: firstInput.reportDate,
    agentModel: "openai/codex-multi-agent",
    headline: firstReportForPublish.headline,
    summary: firstReportForPublish.summary,
  };
  const firstResult = await publishWorkflowReport(first, {
    comparisonRead: async () => null,
    execute: async () => ({ ok: true }),
    readback: async () => ({ report: firstProduction }),
  });
  assert.equal(firstResult.seededInactiveSlice.market, "CN");
  assert.equal(
    firstResult.seededInactiveSlice.marketContentHash,
    workflowMarketContentHash(firstProduction, "CN"),
  );
  const firstManifest = JSON.parse(
    await readFile(first.manifestPath, "utf8"),
  );
  firstManifest.publication = firstResult;
  await writeFile(
    first.manifestPath,
    `${JSON.stringify(firstManifest, null, 2)}\n`,
    "utf8",
  );
  const recordedSeedHashes = await recordedSeedHashesForMarket(workRoot, {
    market: "CN",
    marketAsOf: firstResult.seededInactiveSlice.marketAsOf,
    reportDate: firstInput.reportDate,
  });
  assert.deepEqual(recordedSeedHashes, [
    firstResult.seededInactiveSlice.marketContentHash,
  ]);

  const second = await publicationFixture(
    resolve(workRoot, "second-cn"),
    "CN",
    ["CN"],
  );
  const secondInput = JSON.parse(await readFile(second.inputPath, "utf8"));
  const secondReport = JSON.parse(await readFile(second.reportPath, "utf8"));
  secondReport.drivers.find((item) => item.market === "CN").summary +=
    " 这条补充说明代表第二个隔离市场任务已经形成了不同的正式归因。";
  const secondReportText = `${JSON.stringify(secondReport, null, 2)}\n`;
  const secondManifest = JSON.parse(
    await readFile(second.manifestPath, "utf8"),
  );
  secondManifest.reportHash = stableHash(secondReportText);
  await Promise.all([
    writeFile(second.reportPath, secondReportText, "utf8"),
    writeFile(
      second.manifestPath,
      `${JSON.stringify(secondManifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  const reportForPublish = refreshInactiveAnalysis(
    validateReport(secondReport, secondInput, {
      requireResearchAudit: false,
      activeMarket: "CN",
    }),
    firstProduction,
    "CN",
  );
  const expectedContent = preserveInactiveStoredSlice(
    JSON.parse(buildReportContent(secondInput, reportForPublish)),
    firstProduction,
    "CN",
  );
  const productionAfter = {
    ...expectedContent,
    reportDate: secondInput.reportDate,
    agentModel: "openai/codex-multi-agent",
    headline: reportForPublish.headline,
    summary: reportForPublish.summary,
  };
  let executed = false;
  const secondResult = await publishWorkflowReport(second, {
    comparisonRead: async () => firstProduction,
    replaceableSameMarketContentHashes: recordedSeedHashes,
    execute: async () => {
      executed = true;
      return { ok: true };
    },
    readback: async () => ({ report: productionAfter }),
  });
  assert.equal(executed, true);
  assert.equal(secondResult.status, "published");
  assert.equal(
    secondResult.marketContentHash,
    workflowMarketContentHash(productionAfter, "CN"),
  );
});

test("publication recovery carries a seed across separate market batches", async () => {
  const workRoot = await mkdtemp(
    resolve(tmpdir(), "stock-daily-seeded-recovery-"),
  );
  const first = await publicationFixture(
    resolve(workRoot, "first-us"),
    "US",
    ["US"],
  );
  const second = await publicationFixture(
    resolve(workRoot, "second-cn"),
    "CN",
    ["CN"],
  );
  const firstManifest = JSON.parse(
    await readFile(first.manifestPath, "utf8"),
  );
  const seededHash = workflowMarketContentHash(first.content, "CN");
  firstManifest.publication = {
    status: "published",
    seededInactiveSlice: {
      market: "CN",
      marketAsOf: firstManifest.marketAsOf,
      marketContentHash: seededHash,
    },
  };
  firstManifest.publicationCompletedAt = "2026-08-29T10:00:00.000Z";
  firstManifest.ingestionFinalization = {
    status: "completed",
    completedAt: "2026-08-29T10:01:00.000Z",
  };
  await writeFile(
    first.manifestPath,
    `${JSON.stringify(firstManifest, null, 2)}\n`,
    "utf8",
  );
  let published = false;
  const results = await recoverPendingPublications(workRoot, {
    verify: async () => {
      throw new Error("active CN slice is still the seeded placeholder");
    },
    publishApproved: async (_paths, options) => {
      assert.deepEqual(options.replaceableSameMarketContentHashes, [
        seededHash,
      ]);
      published = true;
      return {
        status: "published",
        market: "CN",
        marketAsOf: firstManifest.marketAsOf,
      };
    },
    finalize: async () => ({ status: "completed" }),
  });
  assert.equal(published, true);
  assert.equal(results[0].status, "published");
  assert.equal(results[0].manifestPath, second.manifestPath);
});

test("publication retry refuses to overwrite a changed active-market base", async () => {
  const fixture = await publicationFixture();
  let executed = false;
  await assert.rejects(
    () =>
      publishWorkflowReport(fixture, {
        expectedBaseMarketContentHash: workflowMarketContentHash({}, "US"),
        comparisonRead: async () => fixture.content,
        execute: async () => {
          executed = true;
        },
      }),
    /市场切片已在失败后变化/,
  );
  assert.equal(executed, false);
});

test("an older same-date manifest cannot overwrite a different published slice", async () => {
  const fixture = await publicationFixture();
  const newerProduction = structuredClone(fixture.content);
  newerProduction.agentModel = "openai/codex-multi-agent";
  newerProduction.drivers.find((item) => item.market === "US").summary +=
    " Newer independently approved analysis.";
  let executed = false;
  const result = await publishWorkflowReport(fixture, {
    comparisonRead: async () => newerProduction,
    execute: async () => {
      executed = true;
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal(executed, false);

  const recovered = await verifyWorkflowReadback(fixture, {
    readback: async () => ({ report: newerProduction }),
  });
  assert.equal(recovered.status, "superseded");
});

test("a legacy production slice with a later market date supersedes recovery", async () => {
  const fixture = await publicationFixture();
  const newerProduction = structuredClone(fixture.content);
  newerProduction.agentModel = "openai/codex-v10";
  newerProduction.marketAsOf.US = "2026-08-22";
  let executed = false;
  const result = await publishWorkflowReport(fixture, {
    comparisonRead: async () => newerProduction,
    execute: async () => {
      executed = true;
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal(executed, false);
});

test("shadow artifacts cannot cross the production publication boundary", async () => {
  const fixture = await publicationFixture();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.deliveryMode = "shadow";
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () =>
      verifyWorkflowReadback(fixture, {
        readback: async () => ({ report: {} }),
      }),
    /未授权进入生产发布模式/,
  );
});

test("publication recomputes the active market input hash", async () => {
  const fixture = await publicationFixture();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.inputHash = "forged-input-hash";
  manifest.marketInputHash = "forged-input-hash";
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () =>
      verifyWorkflowReadback(fixture, {
        readback: async () => ({ report: fixture.content }),
      }),
    /发布输入与多 Agent 运行清单不一致/u,
  );
});

test("production merge preserves the exact inactive market slice", async () => {
  const fixture = await publicationFixture();
  const candidate = structuredClone(fixture.content);
  const production = structuredClone(fixture.content);
  production.marketAsOf.CN = "2026-08-22";
  production.marketViews.CN.summary = "Latest independently published CN analysis.";
  production.markets.find((item) => item.region === "CN").value = "9999.99";
  production.drivers.find((item) => item.market === "CN").summary += " current";
  const merged = preserveInactiveStoredSlice(candidate, production, "US");
  assert.equal(
    workflowMarketContentHash(merged, "CN"),
    workflowMarketContentHash(production, "CN"),
  );
  assert.equal(
    workflowMarketContentHash(merged, "US"),
    workflowMarketContentHash(candidate, "US"),
  );
});

test("inactive-slice refresh preserves the approved active overview", async () => {
  const fixture = await publicationFixture();
  const prepared = structuredClone(fixture.report);
  const production = structuredClone(fixture.content);
  const activeHeadline = "AI demand and verified market catalysts shaped the session";
  const activeSummary =
    "Verified market and AI-chain catalysts jointly explain the active-market session without reducing the recap to the narrower broad-market view.";
  prepared.headline = `${activeHeadline}；${prepared.marketViews.CN.headline}`;
  prepared.summary = `${activeSummary} ${prepared.marketViews.CN.summary}`;
  prepared.translations.en.headline =
    `${activeHeadline}; ${prepared.translations.en.marketViews.CN.headline}`;
  prepared.translations.en.summary =
    `${activeSummary} ${prepared.translations.en.marketViews.CN.summary}`;
  prepared.workflowOverview = {
    market: "US",
    headline: activeHeadline,
    summary: activeSummary,
    headlineEn: activeHeadline,
    summaryEn: activeSummary,
  };
  prepared.headline = prepared.headline.slice(0, 65);
  prepared.summary = prepared.summary.slice(0, 90);
  prepared.translations.en.headline =
    prepared.translations.en.headline.slice(0, 65);
  prepared.translations.en.summary =
    prepared.translations.en.summary.slice(0, 90);
  production.marketViews.CN.headline = "New production CN headline";
  production.marketViews.CN.summary = "New production CN summary.";
  production.translations.en.marketViews.CN.headline =
    "New production China headline";
  production.translations.en.marketViews.CN.summary =
    "New production China summary.";
  const refreshed = refreshInactiveAnalysis(prepared, production, "US");
  assert.equal(
    refreshed.headline,
    `${activeHeadline}；${production.marketViews.CN.headline}`,
  );
  assert.equal(
    refreshed.summary,
    `${activeSummary} ${production.marketViews.CN.summary}`,
  );
  assert.equal(
    refreshed.translations.en.headline,
    `${activeHeadline}; ${production.translations.en.marketViews.CN.headline}`,
  );
  assert.equal(
    refreshed.translations.en.summary,
    `${activeSummary} ${production.translations.en.marketViews.CN.summary}`,
  );
});

test("publication restores the deterministic report gate before SQL", async () => {
  const fixture = await publicationFixture();
  const report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  report.drivers.find((item) => item.market === "US").summary = "发生了什么";
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.reportHash = stableHash(reportText);
  await Promise.all([
    writeFile(fixture.reportPath, reportText, "utf8"),
    writeFile(
      fixture.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  let executed = false;
  await assert.rejects(
    () =>
      publishWorkflowReport(fixture, {
        comparisonRead: async () => fixture.content,
        execute: async () => {
          executed = true;
        },
        readback: async () => ({ report: fixture.content }),
      }),
    /少于|长度|空洞栏目词/,
  );
  assert.equal(executed, false);
});

test("artifact check binds the manifest to the exact market input", async () => {
  const fixture = await publicationFixture();
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  input.markets.find((item) => item.region === "US").value = "99999.99";
  await writeFile(
    fixture.inputPath,
    `${JSON.stringify(input, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => checkWorkflowArtifacts(fixture),
    /检查输入与多 Agent 运行清单不一致/,
  );
});

test("publication rejects an input snapshot from another ingestion batch", async () => {
  const fixture = await publicationFixture();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.batchRunId = "another-ingestion-batch";
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => verifyWorkflowReadback(fixture),
    /发布输入与多 Agent 运行清单不一致/,
  );
});

test("artifact check accepts a complete V11 shadow report", async () => {
  const fixture = await publicationFixture();
  const result = await checkWorkflowArtifacts(fixture);
  assert.equal(result.status, "valid");
  assert.equal(result.market, "US");
});

test("artifact check resolves immutable input and report paths from manifest", async () => {
  const fixture = await publicationFixture();
  const result = await checkWorkflowArtifacts({
    manifestPath: fixture.manifestPath,
  });
  assert.equal(result.status, "valid");
  assert.equal(result.market, "US");
});

test("active-market artifact validation does not re-ground the preserved inactive slice", async () => {
  const fixture = await publicationFixture();
  const report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  const inactive = report.drivers.find((item) => item.market === "CN");
  inactive.direction = inactive.direction === "positive" ? "negative" : "positive";
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.reportHash = stableHash(reportText);
  await Promise.all([
    writeFile(fixture.reportPath, reportText, "utf8"),
    writeFile(
      fixture.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  const result = await checkWorkflowArtifacts(fixture);
  assert.equal(result.status, "valid");
});

test("successful publication SQL retains only ninety days of run history", () => {
  const input = fixtureInput();
  const report = fixtureReport(input);
  assert.match(
    workflowCompletedSql(input, report),
    /DELETE FROM ingestion_runs[\s\S]*-90 days/u,
  );
});

test("per-market writes remain running until batch finalization", () => {
  const input = fixtureInput();
  const report = fixtureReport(input);
  const partialSql = workflowCompletedSql(input, report, null, {
    ingestionStatus: "running",
  });
  const defaultSql = workflowCompletedSql(input, report);
  assert.match(partialSql, /'running'/u);
  assert.match(defaultSql, /'running'/u);
  assert.match(partialSql, /status = excluded\.status/u);
  const completedSql = workflowIngestionCompletedSql(input);
  assert.match(completedSql, /status = 'completed'/u);
  const failedSql = workflowIngestionFailedSql(input, "incomplete batch");
  assert.match(failedSql, /status = 'failed'/u);
  assert.match(failedSql, /incomplete batch/u);
});
