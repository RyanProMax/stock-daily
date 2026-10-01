import assert from "node:assert/strict";
import test from "node:test";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { collectRecapMacroData } from "../scripts/recap-macro-data.mjs";
import { verifiedRecapRateFactors, verifiedRateFactor, mergeRecapRateFactors, auditRecapRateFactors, reportedRateFactorMatch } from "../scripts/recap-rate-factors.mjs";
import { recapTargets, validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { recapAttributionCandidates, validateRecapAttribution } from "../scripts/recap-attribution.mjs";
import { auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";

async function fixture(market = "US") {
  const f = recapFixture(market);
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><title>DailyTreasuryYieldCurveRateData</title><updated>2026-08-21T21:00:00Z</updated>${[
    ["2026-08-19", 4.8, 5.2, 5.5], ["2026-08-20", 4.81, 5.24, 5.56], ["2026-08-21", 4.79, 5.26, 5.59],
  ].map(([date, two, ten, thirty]) => `<entry><content type="application/xml"><m:properties><d:NEW_DATE>${date}T00:00:00</d:NEW_DATE><d:BC_2YEAR>${two}</d:BC_2YEAR><d:BC_10YEAR>${ten}</d:BC_10YEAR><d:BC_30YEAR>${thirty}</d:BC_30YEAR></m:properties></content></entry>`).join("")}</feed>`;
  f.macroData = await collectRecapMacroData(f.envelope, { now: () => new Date("2026-08-21T22:00:00Z"), reader: async url => ({ rawBody: Buffer.from(xml), finalUrl: url }) });
  f.ledger = mergeRecapRateFactors(f.ledger, f.macroData, f.envelope);
  f.factor = f.ledger.sources.find(source => source.kind === "macro_observation" && source.years === 10);
  f.report = f.ledger.sources.find(source => source.id === "0-causal");
  f.report.supportingExcerpt = "Stocks fell because higher long-term Treasury yields pressured valuations, while opposing forces limited the net decline. The 10-year Treasury rose to 5.25% from 5.24% late Thursday.";
  return f;
}

test("official observations are reconstructed from original XML without a fabricated publication clock", async () => {
  const f = await fixture();
  assert.equal(verifiedRecapRateFactors(f.macroData, f.envelope).length, 3);
  assert.equal(f.factor.publishedAt, "2026-08-21");
  assert.equal(f.factor.publicationTimeKnown, false);
  assert.equal(f.factor.timingChecked, false);
  assert.equal(f.factor.values.actualPercent, 5.26);
  assert.equal(f.factor.values.changeBasisPoints, 2);
  assert.equal(f.factor.excerptType, "derived_data");
  assert.equal(f.factor.targets[0], "US-Treasury-10Y-par");
  assert.ok(verifiedRateFactor(f.factor, f.macroData, f.envelope));
  assert.doesNotThrow(() => auditRecapRateFactors(f.ledger, f.macroData, f.envelope));
  const observed = { sources: f.ledger.sources.filter(source => source.kind === "macro_observation") };
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [] };
  assert.throws(() => auditLedgerSourceSnapshots(observed, book), /原始财政部/);
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(observed, book, { envelope: f.envelope, macroData: f.macroData }));
  for (const mutate of [source => source.publishedAt += "T00:00:00Z", source => source.timingChecked = true, source => source.targets = ["SPX"], source => source.values.actualPercent = 9.99, source => source.sourceLabel = "Breaking news"]) {
    const changed = structuredClone(f.factor); mutate(changed);
    assert.equal(verifiedRateFactor(changed, f.macroData, f.envelope), false);
    const ledger = structuredClone(f.ledger); ledger.sources[ledger.sources.findIndex(source => source.id === changed.id)] = changed;
    assert.throws(() => auditRecapRateFactors(ledger, f.macroData, f.envelope));
  }
});

test("the exact maturity, prior session and rate direction must agree; distinct quote definitions remain distinct", async () => {
  const f = await fixture();
  const match = reportedRateFactorMatch(f.factor, f.report, f.envelope);
  assert.equal(match.currentPercent, 5.25);
  assert.equal(match.changeBasisPoints, 1);
  assert.equal(f.factor.values.changeBasisPoints, 2);
  for (const rewrite of [
    text => text.replace("10-year", "2-year"), text => text.replaceAll("Treasury", "corporate bond"),
    text => text.replace("Thursday", "Wednesday"), text => text.replace("rose", "fell"),
    text => text.replace("5.25%", "5.23%"), text => text.replace("5.25%", "5.24%"),
    text => text.replace("5.25%", "5.40%"), text => text.replace("%", " basis points"),
  ]) assert.equal(reportedRateFactorMatch(f.factor, { ...f.report, supportingExcerpt: rewrite(f.report.supportingExcerpt) }, f.envelope), null, rewrite.toString());
  assert.equal(reportedRateFactorMatch(f.factor, { ...f.report, publishedAt: "2026-08-20T20:30:00Z" }, f.envelope), null);
  const cn = await fixture("CN");
  assert.equal(cn.factor, undefined);
  assert.deepEqual(verifiedRecapRateFactors(cn.macroData, cn.envelope), []);
});

test("an observed market variable supplies ingredients but no target-specific attribution or missing basket exposure", async () => {
  const f = await fixture();
  f.ledger.sources = f.ledger.sources.filter(source => source.kind === "macro_observation" || source.id === f.report.id);
  let candidates = recapAttributionCandidates(f.envelope, recapTargets(f.envelope), f.ledger, { macroData: f.macroData });
  assert.equal(candidates.find(item => item.target === "SPX").reportedEligible, false);
  assert.equal(candidates.find(item => item.target === "SPX").inferredIngredientsPresent, true);
  assert.equal(candidates.find(item => item.target === "XLU").inferredIngredientsPresent, false);
  assert.ok(candidates.filter(item => item.target.startsWith("AI-")).every(item => !item.inferredIngredientsPresent));
  f.ledger.sources = f.ledger.sources.filter(source => source.kind === "macro_observation");
  candidates = recapAttributionCandidates(f.envelope, recapTargets(f.envelope), f.ledger, { macroData: f.macroData });
  assert.ok(candidates.every(item => !item.inferredIngredientsPresent));
});

test("a bounded explanatory clause and climbed preserve the exact maturity and prior-session rate comparison", async () => {
  const f = await fixture(), factor = f.ledger.sources.find(source => source.kind === "macro_observation" && source.years === 30);
  const quote = "The 30-year Treasury yield, which takes into account expectations for inflation and economic growth many years down the line, climbed to 5.59% from 5.56% late Thursday.";
  assert.equal(reportedRateFactorMatch(factor, { ...f.report, supportingExcerpt: quote }, f.envelope).changeBasisPoints, 3);
  for (const altered of [quote.replace("climbed", "fell"), quote.replace("30-year", "10-year"), quote.replace("Thursday", "Wednesday"), quote.replace("5.59%", "5.54%"), quote.replace("which takes", "after the 10-year yield, which takes"), quote.replace("many years down the line, climbed", "many years down the line. Separately, another yield climbed")]) assert.equal(reportedRateFactorMatch(factor, { ...f.report, supportingExcerpt: altered }, f.envelope), null);
});

test("observed factors cannot be promoted to a reported event or omit anchors and unknown publication limitations", async () => {
  const f = await fixture();
  f.envelope.markets.find(item => item.symbol === "SPX").change = "-0.17%";
  const entry = f.attribution.entries.find(item => item.target === "SPX");
  entry.basis = "inferred"; entry.observedReturn = "-0.17%";
  Object.assign(entry.chains[0], { rootEvidenceId: f.factor.id, reactionEvidenceId: f.report.id, timingEvidenceId: null, mechanismEvidenceIds: [], eventAnchors: ["10-year U.S. Treasury", "2026-08-21"], expectedDirection: "negative", limitations: "This observation is an interpolated par yield, distinct from the reported benchmark quote. Historical publication time is unknown; no exact contribution is identified." });
  const validate = () => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { macroData: f.macroData });
  assert.doesNotThrow(validate);
  for (const mutate of [
    value => value.basis = "reported", value => value.chains[0].timingEvidenceId = "0-facts",
    value => value.chains[0].eventAnchors = ["10-year U.S. Treasury", "2026-08-20"],
    value => value.chains[0].eventAnchors = ["rates", "demand"],
    value => value.chains[0].limitations = "The publication and Treasury par observation are confirmed, so this is a known intraday catalyst.",
    value => value.chains[0].limitations = "The Treasury par observation has a precise publication time. The size of the equity contribution is unknown.",
  ]) { const changed = structuredClone(f.attribution); mutate(changed.entries.find(item => item.target === "SPX")); assert.throws(() => validateRecapAttribution(changed, f.envelope, recapTargets(f.envelope), f.ledger, { macroData: f.macroData })); }
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), /原始观测/);
  const raw = f.raw.entries.find(item => item.target === "SPX");
  raw.evidenceIds.push(f.factor.id);
  raw.why = "推断：" + raw.why;
  raw.whyEn = "Inference: " + raw.whyEn;
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution, macroData: f.macroData }), /观测口径/);
  raw.why += "财政部平价收益率是当日观测，与报道中的基准债报价口径不同；历史发布时间未知。";
  raw.whyEn += " The Treasury par yield is an observation, distinct from the benchmark quote; historical publication time is unknown.";
  assert.doesNotThrow(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution, macroData: f.macroData }));
  raw.confidence = "high";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution, macroData: f.macroData }), /中等置信/);
});
