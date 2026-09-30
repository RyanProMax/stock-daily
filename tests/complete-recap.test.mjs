import assert from "node:assert/strict";
import test from "node:test";
import { fixtureInput } from "./daily-v10-fixture.mjs";
import { marketEnvelope, publicComparison, stableHash, validateResearchOutput } from "../scripts/daily-workflow-core.mjs";
import { MarketWorkflow, assertResearchBatchBudget, compatibleFeatureArgs } from "../scripts/daily-workflow.mjs";
import { RECAP_VERSION, assessRecapEvidenceCoverage, completeRecapPlan, recapTargets, recapObservations, validateCompleteRecap, validateRecapReview, verifySocialLeads } from "../scripts/complete-recap.mjs";
import { workflowMarketContentHash, preserveInactiveStoredSlice, auditWorkflowCausalEvidence } from "../scripts/daily-workflow-publish.mjs";
import { verifiedExternalSourceType } from "../scripts/source-registry.mjs";

import { recapFixture } from "./complete-recap-fixture.mjs";

test("coverage includes every industry and AI basket even if the observed move is flat", () => {
  for (const market of ["CN", "US"]) {
    const fixture = recapFixture(market);
    const targets = recapTargets(fixture.envelope);
    assert.equal(targets.length, 20);
    assert.equal(targets.filter((item) => item.kind === "sector").length, 11);
    assert.equal(targets.filter((item) => item.kind === "ai_layer").length, 8);
    fixture.envelope.sectorPerformance[0].change = "0.00%";
    fixture.envelope.sectorPerformance[0].direction = "flat";
    assert.equal(completeRecapPlan(fixture.envelope).anomalies.find((item) => item.target === fixture.envelope.sectorPerformance[0].symbol).direction, "mixed");
    assert.equal(validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social, { requireComplete: true }).status, "complete");
  }
});

test("missing, duplicated and invented target coverage cannot pass", () => {
  for (const mutate of [raw => raw.entries.pop(), raw => raw.entries[1].target = raw.entries[0].target, raw => raw.entries[0].target = "invented"]) {
    const fixture = recapFixture(); mutate(fixture.raw);
    assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social), /目标|遗漏|重复/);
  }
});

test("observations reconstruct equal-weight offsets without inventing sector weights or volatility", () => {
  const f = recapFixture();
  const basket = f.envelope.aiChainPerformance[0];
  basket.constituents.forEach((item, index) => item.change = ["+4.00%", "-3.00%", "+1.00%", "-2.00%"][index]);
  basket.change = "0.00%";
  const observations = recapObservations(f.envelope);
  const ai = observations.find(item => item.target === basket.symbol);
  assert.equal(ai.equalWeight.positiveContribution, "1.25 个百分点 (1.25 percentage points)");
  assert.equal(ai.equalWeight.negativeContribution, "-1.25 个百分点 (-1.25 percentage points)");
  assert.equal(ai.equalWeight.reconstructedReturn, "0.00%");
  assert.equal(ai.risingRepresentatives, 2);
  assert.equal(ai.fallingRepresentatives, 2);
  assert.equal(ai.representativeSpread, "7.00 个百分点 (7.00 percentage points)");
  const sector = observations.find(item => item.target === f.envelope.sectorPerformance[0].symbol);
  assert.equal(sector.equalWeight, undefined);
  assert.equal(sector.intradayRange, undefined);
  assert.equal(sector.fundFlow, undefined);
  assert.equal(sector.sectorBreadth, undefined);
  basket.change = "+0.10%";
  assert.throws(() => recapObservations(f.envelope), /成分复核/);
  basket.change = "0.00%";
  basket.constituents[0].asOf = "2026-08-20";
  assert.throws(() => recapObservations(f.envelope), /交易日/);
});

test("evidence coverage is measured before a writer can pad missing causes", () => {
  const f = recapFixture();
  assert.equal(assessRecapEvidenceCoverage(f.envelope, f.ledger).eligibleCount, 20);
  f.ledger.sources = f.ledger.sources.filter(source => source.id !== "0-causal");
  const coverage = assessRecapEvidenceCoverage(f.envelope, f.ledger);
  assert.equal(coverage.eligibleCount, 19);
  assert.ok(coverage.entries[0].gaps.includes("target_causality"));
  assert.ok(coverage.entries[0].gaps.includes("magnitude"));
});

test("thin, ungrounded, expert-only and target-mismatched attribution cannot pass", () => {
  for (const mutate of [
    f => f.raw.entries[0].why = "市场上涨。",
    f => f.raw.entries[0].why += "资金流入9999亿美元。",
    f => f.ledger.sources[0].sourceType = "publisher",
    f => f.ledger.sources[1].targets = ["another-sector"],
    f => f.ledger.sources[1].supportingExcerpt = "The index rose and its constituents also rose.",
    f => f.ledger.sources[0].excerptHash = null,
    f => f.ledger.sources[0].url = "https://unknown.example/fake",
    f => f.ledger.sources[0].anomalyId = "other-sector",
    f => f.raw.entries[0].opinions = [{ postId: "invented", evidenceIds: ["0-facts"] }],
  ]) {
    const fixture = recapFixture(); mutate(fixture);
    assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social));
  }
});

test("magnitude needs target-specific offset, volume, range or breadth evidence", () => {
  const fixture = recapFixture();
  fixture.ledger.sources[1].supportingExcerpt = "The index rose because the official announcement improved earnings expectations.";
  assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social), /分化|相反力量/);
  fixture.raw.entries[0].status = "partial";
  fixture.raw.entries[0].confidence = "medium";
  const partial = validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social);
  assert.equal(partial.status, "partial");
  assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social, { requireComplete: true }), /覆盖不完整/);
});

test("every target and magnitude score must pass independent review", () => {
  const f = recapFixture();
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social);
  const review = { market: "US", entries: recap.entries.map(entry => ({ target: entry.target, verdict: "pass", scores: { factualAccuracy: 5, causality: 4, magnitude: 4, sourceIndependence: 5, readerUtility: 4 } })) };
  assert.equal(validateRecapReview(review, recap), review);
  review.entries[0].scores.magnitude = 3;
  assert.throws(() => validateRecapReview(review, recap), /审稿未通过/);
  review.entries[0].scores.magnitude = 4;
  review.entries[1].target = review.entries[0].target;
  assert.throws(() => validateRecapReview(review, recap), /目标重复/);
});

test("financial attributions show two actual/baseline/code-delta comparisons in both languages", () => {
  const f = recapFixture(), source = f.ledger.sources[0];
  source.comparisons = [
    { label: "EPS", unit: "usd", actualValue: 1.2, actualDisplay: "$1.20", baselineValue: 1, baselineDisplay: "$1.00", baselineLabel: "Consensus", higherIsPositive: true, note: "No non-recurring gain is included." },
    { label: "Revenue", unit: "billion_usd", actualValue: 12, actualDisplay: "$12B", baselineValue: 10, baselineDisplay: "$10B", baselineLabel: "Consensus", higherIsPositive: true, note: "Revenue as reported." },
  ];
  source.earningsContextChecked = true;
  source.supportingExcerpt = "Reported EPS was $1.20 against $1.00 consensus; revenue was $12B against $10B. No non-recurring gain is included.";
  f.raw.entries[0].why += "公司财报好于预期。";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /未展示财报/);
  const metrics = source.comparisons.map(publicComparison);
  const copy = metrics.map(item => `${item.label}: ${item.actual}, ${item.baselineLabel}: ${item.baseline}, ${item.delta}.`).join(" ");
  f.raw.entries[0].why += copy;
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /英文财报归因/);
  f.raw.entries[0].whyEn += copy;
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social).entries[0].status, "explained");
  source.comparisons[1].label = "Brent oil price";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /财报归因缺少/);
});

test("X originals bind allowlisted authors and snowflake times; future posts and mirrors are rejected", () => {
  const f = recapFixture();
  const publishedAt = "2026-08-21T19:00:00Z";
  const id = ((BigInt(Date.parse(publishedAt)) - 1288834974657n) << 22n).toString();
  const registry = [{ handle: "Analyst", label: "Analyst", authority: "expert", markets: ["US"], layers: ["chips"], identityEvidence: "https://x.com/Analyst" }];
  const post = { url: `https://x.com/Analyst/status/${id}`, authorHandle: "Analyst", publishedAt, platform: "x", facts: "Demand and financing changes could affect earnings expectations through documented orders and borrowing costs." };
  const verify = candidates => verifySocialLeads({ candidates, diagnostics: { status: "ok" } }, registry, f.envelope);
  assert.equal(verify([post]).leads.length, 1);
  assert.equal(verify([post]).leads[0].factualAuthority, false);
  const closingTime = "2026-08-21T21:00:00Z";
  const closingId = ((BigInt(Date.parse(closingTime)) - 1288834974657n) << 22n).toString();
  assert.equal(verify([{ ...post, publishedAt: closingTime, url: `https://x.com/Analyst/status/${closingId}` }]).leads.length, 1);
  for (const change of [{ publishedAt: "2026-08-22T19:00:00Z" }, { authorHandle: "Impersonator" }, { url: `https://mirror.example/Analyst/status/${id}` }, { url: `https://x.com/Analyst/status/${BigInt(id) + (86400000n << 22n)}` }]) assert.equal(verify([{ ...post, ...change }]).leads.length, 0);
});

test("comprehensive research has a deterministic query budget and frozen plan", () => {
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true });
  assert.equal(workflow.searchQueryLimit, 92);
  assert.equal(assertResearchBatchBudget(12, completeRecapPlan(workflow.envelope).anomalies, {}, "", workflow.searchQueryLimit), 80);
  assert.throws(() => assertResearchBatchBudget(13, completeRecapPlan(workflow.envelope).anomalies, {}, "", workflow.searchQueryLimit), /预算不足/);
  assert.deepEqual(completeRecapPlan(workflow.envelope), completeRecapPlan(workflow.envelope));
});

test("recap content participates in readback hashes", () => {
  const f = recapFixture();
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social);
  const report = { recaps: { US: recap } };
  const hash = workflowMarketContentHash(report, "US");
  report.recaps.US.entries[0].why += " altered";
  assert.notEqual(workflowMarketContentHash(report, "US"), hash);
});

test("single-market updates preserve the approved inactive recap exactly", () => {
  const f = recapFixture("CN");
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social);
  const empty = { marketAsOf: { CN: f.envelope.marketAsOf, US: f.envelope.marketAsOf }, marketViews: {}, aiChainViews: {}, markets: [], marketSessions: [], sectorPerformance: [], aiChainPerformance: [], sectorHeat: [], drivers: [], aiChainUpdates: [], translations: { en: { marketViews: {}, aiChainViews: {}, drivers: [], aiChainUpdates: [] } } };
  const merged = preserveInactiveStoredSlice(empty, { ...empty, recaps: { CN: recap } }, "US");
  assert.deepEqual(merged.recaps.CN, recap);
});

test("known sector ETF queries retain market context; abstract baskets do not", () => {
  const f = recapFixture();
  const anomaly = f.plan.anomalies.find(item => item.kind === "sector");
  const output = { contractVersion: "stock-daily-evidence-worker-v1", role: "causal", market: "US", anomalyId: anomaly.id, outcome: "none", queries: [...anomaly.causalQueries, `${anomaly.target} August 21 2026 market close demand`], sources: [], alternatives: [{ claim: "Demand changes may affect this sector.", status: "unresolved", sourceUrls: [] }] };
  assert.doesNotThrow(() => validateResearchOutput(output, "causal", anomaly, f.envelope));
  output.queries[1] = "August 21 2026 mystery market demand";
  assert.throws(() => validateResearchOutput(output, "causal", anomaly, f.envelope), /市场或跨市场标记/);
  const layer = f.plan.anomalies.find(item => item.kind === "ai_layer");
  f.envelope.aiChainPerformance.find(item => item.symbol === layer.target).constituents[0].symbol = "LITE";
  const layerOutput = { ...output, anomalyId: layer.id, queries: [...layer.causalQueries, "LITE August 21 2026 earnings price reaction"] };
  assert.doesNotThrow(() => validateResearchOutput(layerOutput, "causal", layer, f.envelope));
  layerOutput.queries[1] = "UNKNOWN August 21 2026 earnings price reaction";
  assert.throws(() => validateResearchOutput(layerOutput, "causal", layer, f.envelope), /市场或跨市场标记/);
});

test("CLI compatibility passes only feature switches present in the installed binary", () => {
  assert.deepEqual(compatibleFeatureArgs("plugins stable true\napps stable true\ntui_app_server removed true\n"), ["--disable", "plugins", "--disable", "apps", "--disable", "tui_app_server"]);
  assert.ok(!compatibleFeatureArgs("plugins stable true\n").includes("recommended_plugins"));
});

test("publication cannot bypass comprehensive artifact verification", async () => {
  const f = recapFixture();
  await assert.rejects(auditWorkflowCausalEvidence({ manifest: { coverageRequired: true }, report: {}, manifestPath: "/tmp/missing-recap/manifest.json", input: fixtureInput() }), /ENOENT/);
  await assert.rejects(auditWorkflowCausalEvidence({ manifest: { coverageRequired: true }, report: {}, manifestPath: "/tmp/missing-recap/manifest.json" }), /行情输入/);
});

test("an exchange-hosted article cannot masquerade as an official issuer disclosure", () => {
  assert.equal(verifiedExternalSourceType("https://www.nasdaq.com/articles/company-earnings-commentary"), "publisher");
  assert.equal(verifiedExternalSourceType("https://www.nasdaq.com/market-activity/etf/xlk/historical"), "first_party");
});
