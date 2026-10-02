import assert from "node:assert/strict";
import test from "node:test";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { collectRecapMacroData } from "../scripts/recap-macro-data.mjs";
import { verifiedRecapRateFactors, verifiedRateFactor, mergeRecapRateFactors, auditRecapRateFactors, reportedRateFactorMatch, intradayRateComparisonCopy, selectedRecapRateComparisons } from "../scripts/recap-rate-factors.mjs";
import { recapTargets, validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { recapAttributionCandidates, validateRecapAttribution, RecapAttributionEvidenceSelectionError } from "../scripts/recap-attribution.mjs";
import { auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { assertFactsNumbersInExcerpt } from "../scripts/daily-workflow-core.mjs";

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

async function intradayFixture() {
  const f = await fixture();
  const xml = f.macroData.snapshots[0].xml.replace('<d:BC_10YEAR>5.26</d:BC_10YEAR>', '<d:BC_10YEAR>5.23</d:BC_10YEAR>');
  f.macroData = await collectRecapMacroData(f.envelope, { now: () => new Date("2026-08-21T22:00:00Z"), reader: async url => ({ rawBody: Buffer.from(xml), finalUrl: url }) });
  f.ledger = mergeRecapRateFactors(f.ledger, f.macroData, f.envelope);
  f.factor = f.ledger.sources.find(source => source.kind === "macro_observation" && source.years === 10);
  f.report.supportingExcerpt = "The S&P 500 recovered as bond yields retreated, while opposing forces limited the advance. The 10-year Treasury yield (^TNX) eased to 5.24% after climbing earlier Friday to 5.3%, a new multidecade high.";
  return f;
}

test("a named same-session retreat keeps the intraday high separate from the official prior-session observation", async () => {
  const f = await intradayFixture(), quote = f.report.supportingExcerpt;
  const comparison = reportedRateFactorMatch(f.factor, f.report, f.envelope);
  assert.equal(comparison.comparisonPeriod, "intraday");
  assert.equal(comparison.currentPercent, 5.24);
  assert.equal(comparison.intradayReferencePercent, 5.3);
  assert.equal(comparison.intradayChangeBasisPoints, -6);
  assert.equal(comparison.previousPercent, undefined);
  assert.equal(comparison.previousSession, undefined);
  assert.equal(comparison.changeBasisPoints, undefined);
  assert.equal(f.factor.values.previousPercent, 5.24);
  assert.equal(f.factor.values.changeBasisPoints, -1);
  for (const altered of [
    quote.replace("Friday", "Thursday"), quote.replace("earlier Friday", "late Thursday"),
    quote.replace("10-year", "2-year"), quote.replace("Treasury", "corporate bond"),
    quote.replace("eased", "rose"), quote.replace("climbing", "falling"),
    quote.replace("5.3%", "5.2%"), quote.replace("5.3%", "5.24%"),
    quote.replace("5.24%", "5.50%"), quote.replace("5.24%", "0%"),
    quote.replace("% after", " basis points after"), quote.replace("after climbing", ". Another bond was climbing"),
  ]) assert.equal(reportedRateFactorMatch(f.factor, { ...f.report, supportingExcerpt: altered }, f.envelope), null, altered);
  assert.equal(reportedRateFactorMatch({ ...f.factor, values: { ...f.factor.values, changeBasisPoints: 1 } }, f.report, f.envelope), null);
  assert.equal(reportedRateFactorMatch(f.factor, { ...f.report, publishedAt: "2026-08-20T20:30:00Z" }, f.envelope), null);
  const candidates = recapAttributionCandidates(f.envelope, recapTargets(f.envelope), f.ledger, { macroData: f.macroData });
  const pair = candidates.find(item => item.target === "SPX").candidatePairs.find(item => item.root === f.factor.id && item.reaction === f.report.id);
  assert.deepEqual(pair.rateComparison.requiredCopy, intradayRateComparisonCopy(comparison));
  assert.equal(pair.rateComparison.intradayReferencePercent, 5.3);
  const copy = intradayRateComparisonCopy(comparison);
  for (const facts of [copy.zh, copy.en]) assert.doesNotThrow(() => assertFactsNumbersInExcerpt({facts,supportingExcerpt:quote}));
  for (const facts of ["The 10-year Treasury yield rose to 5.24%.", "10 年期国债收益率上升至 5.24%。"]) assert.throws(() => assertFactsNumbersInExcerpt({facts,supportingExcerpt:quote}), /方向/u);
});

test("attribution and reader copy cannot turn an intraday high into the previous-session yield", async () => {
  const f = await intradayFixture();
  const entry = f.attribution.entries.find(item => item.target === "SPX");
  const comparison = reportedRateFactorMatch(f.factor, f.report, f.envelope), copy = intradayRateComparisonCopy(comparison);
  entry.basis = "inferred";
  Object.assign(entry.chains[0], { rootEvidenceId: f.factor.id, reactionEvidenceId: f.report.id, timingEvidenceId: null, mechanismEvidenceIds: [], eventAnchors: ["10-year U.S. Treasury", "2026-08-21"], expectedDirection: "positive", limitations: "This is a par observation, distinct from the nominal quote; historical publication time is unknown. " + copy.en });
  const validate = () => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { macroData: f.macroData });
  assert.doesNotThrow(validate);
  const contexts = selectedRecapRateComparisons(f.attribution, f.ledger, f.envelope);
  assert.equal(contexts.length, 1); assert.equal(contexts[0].target, "SPX");
  assert.equal(contexts[0].rootEvidenceId, f.factor.id); assert.deepEqual(contexts[0].requiredCopy, copy);
  entry.chains[0].limitations = "This is a par observation, distinct from the nominal quote; historical publication time is unknown.";
  assert.throws(validate, /日内报价比较/u);
  entry.chains[0].limitations += " " + copy.en;
  const raw = f.raw.entries.find(item => item.target === "SPX");
  raw.evidenceIds.push(f.factor.id);
  raw.why = "推断：" + raw.why + "财政部平价收益率是当日观测，与报道中的基准债报价口径不同；历史发布时间未知。";
  raw.whyEn = "Inference: " + raw.whyEn + " The Treasury par yield is an observation, distinct from the benchmark quote; historical publication time is unknown.";
  const validateCopy = () => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution, macroData: f.macroData });
  assert.throws(validateCopy, /日内报价/u);
  raw.why += copy.zh;
  assert.throws(validateCopy, /日内报价/u);
  raw.whyEn += " " + copy.en;
  assert.doesNotThrow(validateCopy);
  raw.confidence = "high";
  assert.throws(validateCopy, /中等置信/u);
});

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

test("a common rate reaction can support a qualified sector inference without becoming direct sector reporting", async () => {
  const f = await fixture();
  const sector = f.envelope.sectorPerformance.find(item => item.symbol === "XLU");
  sector.change = "-0.68%";
  const targets = recapTargets(f.envelope), target = targets.find(item => item.symbol === "XLU");
  const background = { ...f.ledger.sources.find(source => source.id === "0-facts"), id: "utility-inverse-exposure", kind: "background", publishedAt: "2026-01-28", targets: ["XLU"], scope: "sector", causalConnection: false, backgroundSubjects: ["XLU"], supportingExcerpt: "Utilities Sector Risk: The value of regulated utility equity securities may tend to have an inverse relationship to the movement of interest rates." };
  f.ledger.sources.push(background);
  const entry = {
    target: "XLU", basis: "inferred", observedReturn: target.change,
    counterAssessment: "Company-specific effects remain unverified; this directionally consistent common factor does not identify the dominant cause or exact contribution.", counterEvidenceIds: [],
    chains: [{ rootEvidenceId: f.factor.id, reactionEvidenceId: f.report.id, timingEvidenceId: null, mechanismEvidenceIds: [background.id], eventAnchors: ["10-year U.S. Treasury", "2026-08-21"], expectedDirection: "negative", transmission: "The observed long yield increased, and the independent broad-market passage links higher yields with valuation pressure. The utility fund's own disclosure states an inverse interest-rate relationship, supplying the separate target mechanism for a possible negative contribution.", limitations: "This is a par-yield observation, distinct from the benchmark quotation. Historical publication time is unknown, and neither dominance nor an exact contribution is established." }],
  };
  const assessment = { ...f.attribution, entries: targets.map(item => item.symbol === "XLU" ? entry : { target: item.symbol, basis: "unresolved", observedReturn: item.change, counterAssessment: "No complete independently supported transmission chain was selected for this separate target.", counterEvidenceIds: [], chains: [] }) };
  const validate = () => validateRecapAttribution(assessment, f.envelope, targets, f.ledger, { macroData: f.macroData });
  const originalTargets = [...f.report.targets];
  assert.ok(!originalTargets.includes("XLU"));
  assert.doesNotThrow(validate);
  assert.deepEqual(f.report.targets, originalTargets);
  entry.basis = "reported";
  assert.throws(validate, /观测不能伪装/);
  entry.basis = "inferred"; entry.chains[0].mechanismEvidenceIds = [];
  assert.throws(validate, /背景传导/);
  entry.chains[0].mechanismEvidenceIds = [background.id];
  target.change = "+0.68%"; entry.observedReturn = target.change;
  assert.throws(validate, /实际涨跌/);
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


test("a MU-scoped macro reaction returns typed SPX mechanism-selection feedback without widening its scope", async () => {
  const f = await intradayFixture();
  f.report.scope = "company"; f.report.targets = ["MU"];
  f.report.supportingExcerpt += " Micron (MU) shares took a leg higher after the memory giant reported fourth-quarter results and raised its Q1 outlook.";
  const entry = f.attribution.entries.find(item => item.target === "SPX");
  entry.basis = "inferred";
  const copy = intradayRateComparisonCopy(reportedRateFactorMatch(f.factor, f.report, f.envelope));
  Object.assign(entry.chains[0], {
    rootEvidenceId: f.factor.id, reactionEvidenceId: f.report.id, timingEvidenceId: null,
    mechanismEvidenceIds: [], eventAnchors: ["10-year U.S. Treasury", f.envelope.marketAsOf],
    expectedDirection: "positive",
    limitations: "This is a par observation, distinct from the nominal quote; historical publication time is unknown. " + copy.en,
  });
  const unrelated = { ...f.ledger.sources.find(source => source.id === "0-facts"), id: "xlu-only-background", kind: "background", publishedAt: "2026-01-28", targets: ["XLU"], scope: "sector", causalConnection: false, backgroundSubjects: ["XLU"] };
  f.ledger.sources.push(unrelated);
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { macroData: f.macroData }), error => {
    assert.ok(error instanceof RecapAttributionEvidenceSelectionError);
    assert.equal(error.name, "RecapAttributionEvidenceSelectionError");
    assert.equal(error.code, "recap_attribution_evidence_selection");
    assert.deepEqual(error.details, {
      target: "SPX", chainIndex: 0,
      rootEvidenceId: f.factor.id, reactionEvidenceId: f.report.id,
      reactionScope: "company", reactionTargets: ["MU"], directMarketFactor: false,
      availableApplicableMechanisms: [], label: "背景传导", min: 1, max: 8,
      selectionIsArray: true, actualCount: 0, evidenceIds: [], missingEvidenceIds: [], duplicateEvidenceIds: [],
    });
    assert.match(error.message, /SPX.*chainIndex.*reactionScope.*company.*MU.*directMarketFactor.*false/u);
    return true;
  });
  assert.deepEqual(f.report.targets, ["MU"]);
  assert.deepEqual(entry.chains[0].mechanismEvidenceIds, []);
});

test("typed mechanism feedback preserves XLU inference and the existing missing, duplicate and cardinality gates", async () => {
  const f = await intradayFixture();
  f.report.scope = "company"; f.report.targets = ["MU"];
  const target = recapTargets(f.envelope).find(item => item.symbol === "XLU");
  target.change = "+0.61%";
  const background = { ...f.ledger.sources.find(source => source.id === "0-facts"), id: "utility-inverse-exposure", kind: "background", publishedAt: "2026-01-28", targets: ["XLU"], scope: "sector", causalConnection: false, backgroundSubjects: ["XLU"], supportingExcerpt: "Utilities Sector Risk: The value of regulated utility equity securities may tend to have an inverse relationship to the movement of interest rates." };
  f.ledger.sources.push(background);
  const copy = intradayRateComparisonCopy(reportedRateFactorMatch(f.factor, f.report, f.envelope));
  const entry = {
    target: "XLU", basis: "inferred", observedReturn: target.change,
    counterAssessment: "Company-specific effects remain unverified; this directionally consistent common factor does not identify the dominant cause or exact contribution.", counterEvidenceIds: [],
    chains: [{ rootEvidenceId: f.factor.id, reactionEvidenceId: f.report.id, timingEvidenceId: null, mechanismEvidenceIds: [background.id], eventAnchors: ["10-year U.S. Treasury", f.envelope.marketAsOf], expectedDirection: "positive", transmission: "The observed long yield decreased, and the independent broad-market passage links lower yields with the market recovery. The utility fund's own disclosure states an inverse interest-rate relationship, supplying the separate target mechanism for a possible positive contribution.", limitations: "This is a par observation, distinct from the nominal quote; historical publication time is unknown. " + copy.en }],
  };
  const assessment = { ...f.attribution, entries: [entry] };
  const validate = () => validateRecapAttribution(assessment, f.envelope, [target], f.ledger, { requireComplete: true, macroData: f.macroData });
  assert.equal(validate(), assessment);
  const available = [{ id: background.id, scope: "sector", targets: ["XLU"], backgroundSubjects: ["XLU"] }];
  for (const selection of [null, [], ["missing-background"], [background.id, background.id]]) {
    entry.chains[0].mechanismEvidenceIds = selection;
    assert.throws(validate, error => {
      assert.ok(error instanceof RecapAttributionEvidenceSelectionError);
      assert.equal(error.details.target, "XLU"); assert.equal(error.details.chainIndex, 0);
      assert.equal(error.details.min, 1); assert.equal(error.details.max, 8);
      assert.equal(error.details.actualCount, Array.isArray(selection) ? selection.length : null);
      assert.deepEqual(error.details.evidenceIds, selection);
      assert.deepEqual(error.details.missingEvidenceIds, selection?.filter(id => id === "missing-background") ?? []);
      assert.deepEqual(error.details.duplicateEvidenceIds, selection?.length === 2 ? [background.id] : []);
      assert.deepEqual(error.details.availableApplicableMechanisms, available);
      assert.equal(error.details.reactionScope, "company"); assert.deepEqual(error.details.reactionTargets, ["MU"]);
      assert.equal(error.details.directMarketFactor, false);
      return true;
    });
  }
  const cardinalitySources = Array.from({ length: 8 }, (_unused, index) => ({ ...background, id: `extra-utility-exposure-${index}` }));
  f.ledger.sources.push(...cardinalitySources);
  entry.chains[0].mechanismEvidenceIds = [background.id, ...cardinalitySources.map(source => source.id)];
  assert.throws(validate, error => error instanceof RecapAttributionEvidenceSelectionError && error.details.actualCount === 9 && error.details.max === 8 && error.details.missingEvidenceIds.length === 0 && error.details.duplicateEvidenceIds.length === 0);
  entry.chains[0].mechanismEvidenceIds = entry.chains[0].mechanismEvidenceIds.slice(0, 8);
  assert.equal(validate(), assessment);
  entry.chains[0].mechanismEvidenceIds = [background.id];
  entry.chains[0].rootEvidenceId = "missing-root";
  assert.throws(validate, error => !(error instanceof RecapAttributionEvidenceSelectionError) && /事件与市场反应.*缺失/u.test(error.message));
});
