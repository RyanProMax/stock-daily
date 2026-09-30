import assert from "node:assert/strict";
import test from "node:test";
import { stableHash } from "../scripts/daily-workflow-core.mjs";
import { assessRecapEvidenceCoverage, recapObservations, validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { hasMeasuredMagnitude, validateMagnitudeObservationIds } from "../scripts/recap-magnitude.mjs";
import { parseTradingSnapshot, tradingRequests } from "../scripts/recap-market-data.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

function measuredFixture() {
  const f = recapFixture();
  const request = tradingRequests(f.envelope).find(item => item.symbol === "SPX");
  const close = request.expectedClose, previous = close / (1 + request.expectedReturn / 100);
  const dates = [];
  let date = new Date("2026-08-21T13:30:00Z");
  while (dates.length < 24) {
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.getTime() / 1000);
    date = new Date(date.getTime() - 86_400_000);
  }
  const quote = {
    open: dates.map(() => previous), close: dates.map(() => previous),
    high: dates.map(() => previous * 1.02), low: dates.map(() => previous * 0.98), volume: dates.map(() => 100),
  };
  quote.close[23] = close;
  quote.open[23] = previous * 1.004;
  quote.high[23] = Math.max(close, quote.open[23], previous) * 1.02;
  quote.low[23] = Math.min(close, quote.open[23], previous) * 0.98;
  quote.volume[23] = 250;
  const payload = { chart: { result: [{ meta: { symbol: request.quoteSymbol }, timestamp: dates, indicators: { quote: [quote] } }] } };
  const snapshot = { symbol: "SPX", url: "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d", payload, payloadHash: stableHash(payload), fetchedAt: "2026-08-21T22:00:00Z" };
  f.tradingData.snapshots.push(snapshot);
  f.tradingData.entries.push(parseTradingSnapshot(snapshot, request, f.envelope));
  f.tradingData.gaps = f.tradingData.gaps.filter(item => item.symbol !== "SPX");
  const profile = recapObservations(f.envelope, f.tradingData)[0].magnitudeEvidence;
  const path = profile.records.find(item => item.kind === "session-path"), range = profile.records.find(item => item.kind === "session-range");
  const relation = path.values.relation === "offset" ? "方向相反，部分抵消" : "方向一致或其中一项为零";
  const relationEn = path.values.relation === "offset" ? "partly offset each other" : "reinforced the net move or included a zero component";
  f.raw.entries[0].magnitude = `开盘相对昨收的缺口为${path.values.openingGap}，开盘至收盘部分为${path.values.openToClose}，两部分${relation}，构成收盘净涨跌。实际日内振幅为${range.values.intradayRange}，它与收盘净幅度不同；这些观测不证明新闻催化或资金流向。`;
  f.raw.entries[0].magnitudeEn = `The opening gap was ${path.values.openingGap}, and the open-to-close component was ${path.values.openToClose}; these components ${relationEn}. The actual intraday range was ${range.values.intradayRange}, distinct from the net closing move. These measurements establish neither a news catalyst nor capital flows.`;
  f.raw.entries[0].magnitudeObservationIds = [path.id, range.id];
  f.raw.entries[0].magnitudeEvidenceIds = [];
  // The verified catalyst has no lexical volume/offset/range phrase.
  f.ledger.sources[1].supportingExcerpt = "SPX rose because the official announcement improved earnings expectations.";
  return { ...f, profile };
}

test("verified measured paths support magnitude while official facts and target causality remain mandatory", () => {
  const f = measuredFixture();
  const coverage = assessRecapEvidenceCoverage(f.envelope, f.ledger, { tradingData: f.tradingData });
  assert.equal(coverage.entries[0].magnitudeSupport, "measured");
  assert.equal(coverage.eligibleCount, 20);
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { tradingData: f.tradingData, requireComplete: true });
  assert.equal(recap.status, "complete");
  assert.ok(recap.entries[0].sources.some(item => item.kind === "market_data"));
  f.ledger.sources = f.ledger.sources.filter(item => item.id !== "0-causal");
  const absent = assessRecapEvidenceCoverage(f.envelope, f.ledger, { tradingData: f.tradingData });
  assert.ok(absent.entries[0].gaps.includes("target_causality"));
  assert.ok(!absent.entries[0].gaps.includes("magnitude"));
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { tradingData: f.tradingData }), /证据|因果/);
});

test("volume alone, unreferenced data, fake IDs and cross-target measurements cannot complete magnitude", () => {
  for (const change of [
    f => f.raw.entries[0].magnitudeObservationIds = [],
    f => f.raw.entries[0].magnitudeObservationIds = [f.profile.records.find(item => item.kind === "volume-baseline").id],
    f => f.raw.entries[0].magnitudeObservationIds.push("measure-invented-session-range"),
    f => f.raw.entries[0].magnitudeObservationIds.push(recapObservations(f.envelope).at(-1).magnitudeEvidence.records[0].id),
    f => f.raw.entries[0].magnitudeObservationIds.push(f.raw.entries[0].magnitudeObservationIds[0]),
  ]) {
    const f = measuredFixture(); change(f);
    assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { tradingData: f.tradingData }), /幅度|观测|引用/);
  }
});

test("both language versions must display the selected measured values with correct units", () => {
  for (const change of [
    f => f.raw.entries[0].magnitudeEn = "The intraday range differed from the closing return, but no original measurement is shown in this translated paragraph.",
    f => f.raw.entries[0].magnitude = f.raw.entries[0].magnitude.replace(f.profile.records[1].values.intradayRange, f.profile.records[1].values.intradayRange.replace("%", "个百分点")),
    f => f.raw.entries[0].magnitudeEn = f.raw.entries[0].magnitudeEn.replace(f.profile.records[1].values.intradayRange, "999.00%"),
    f => f.raw.entries[0].magnitudeEn = f.raw.entries[0].magnitudeEn.replace("0.40%", "-0.40%"),
  ]) {
    const f = measuredFixture(); change(f);
    assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { tradingData: f.tradingData }), /实际观测|数字/);
  }
});

test("four-stock equal-weight offset measurements never create synthetic basket range or sector weights", () => {
  const f = recapFixture(), basket = f.envelope.aiChainPerformance[0];
  basket.constituents.forEach((item, i) => item.change = ["+4.00%", "-3.00%", "+1.00%", "-2.00%"][i]);
  basket.change = "0.00%";
  const observations = recapObservations(f.envelope), profile = observations.find(item => item.target === basket.symbol).magnitudeEvidence;
  assert.equal(profile.records.length, 1);
  assert.equal(profile.records[0].kind, "basket-offset");
  assert.equal(profile.records[0].values.positiveContribution, "1.25 个百分点 (1.25 percentage points)");
  assert.equal(profile.records[0].values.negativeContribution, "-1.25 个百分点 (-1.25 percentage points)");
  assert.ok(hasMeasuredMagnitude(profile));
  assert.ok(!hasMeasuredMagnitude(observations[1].magnitudeEvidence));
  const copy = "等权上涨贡献1.25个百分点，下跌贡献-1.25个百分点，彼此抵消。";
  const copyEn = "The equal-weight basket's 1.25 percentage points of positive contributions offset -1.25 percentage points of negative contributions.";
  assert.equal(validateMagnitudeObservationIds([profile.records[0].id], profile, { copy, copyEn }).length, 1);
  assert.throws(() => validateMagnitudeObservationIds([profile.records[0].id], profile, { copy: copy.replaceAll("个百分点", "%"), copyEn }), /实际观测/);
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile);
});

test("missing daily history cannot supply measured instrument range or volume", () => {
  const f = recapFixture();
  const profiles = recapObservations(f.envelope, f.tradingData).map(item => item.magnitudeEvidence);
  assert.equal(profiles[0].records.length, 0);
  assert.equal(profiles.filter(profile => hasMeasuredMagnitude(profile)).length, 8);
});
