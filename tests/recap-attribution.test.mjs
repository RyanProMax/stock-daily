import assert from "node:assert/strict";
import test from "node:test";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { recapTargets, validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { recapAttributionCandidates, validateRecapAttribution } from "../scripts/recap-attribution.mjs";

function inferredFixture() {
  const f = recapFixture();
  const target = recapTargets(f.envelope).find(item => item.symbol === "XLU");
  const entry = f.attribution.entries.find(item => item.target === target.symbol);
  const root = f.ledger.sources.find(item => item.id === "0-facts");
  const report = f.ledger.sources.find(item => item.id === "0-causal");
  const background = { ...root, id: "xlu-background", kind: "background", publishedAt: "2026-01-28", targets: [target.symbol], anomalyId: f.plan.anomalies.find(item => item.target === target.symbol).id, scope: "sector", causalConnection: false, backgroundSubjects: [target.symbol], supportingExcerpt: "Utilities Sector Risk: financing costs and changes in regulated demand may affect utilities earnings and performance." };
  f.ledger.sources.push(background);
  entry.basis = "inferred";
  Object.assign(entry.chains[0], { rootEvidenceId: root.id, reactionEvidenceId: report.id, mechanismEvidenceIds: [background.id] });
  entry.counterEvidenceIds = [];
  const raw = f.raw.entries.find(item => item.target === target.symbol);
  raw.evidenceIds = [root.id, report.id, background.id];
  raw.why = "推断：" + raw.why;
  raw.whyEn = "Inference: " + raw.whyEn;
  // Magnitude retains the independent original directly about XLU.
  return { ...f, entry, root, report, background, rawEntry: raw };
}

test("an inferred exposure chain keeps broad originals separate and requires explicit medium-confidence copy", () => {
  const f = inferredFixture();
  assert.ok(!f.report.targets.includes("XLU"));
  assert.equal(validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { requireComplete: true }), f.attribution);
  const options = { attribution: f.attribution, requireComplete: true };
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, options).status, "complete");
  f.rawEntry.confidence = "high";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, options), /中等置信/);
  f.rawEntry.confidence = "medium";
  f.rawEntry.whyEn = f.rawEntry.whyEn.replace("Inference: ", "");
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, options), /两种语言/);
  f.rawEntry.whyEn = "Inference: " + f.rawEntry.whyEn;
  f.rawEntry.evidenceIds.pop();
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, options), /完整的已审查/);
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /其他目标/);
});

test("unrelated, generic, misdated, unverified and direction-contradicted chains cannot complete attribution", () => {
  for (const mutate of [
    f => f.entry.chains[0].eventAnchors = ["interest rates", "demand"],
    f => f.root.supportingExcerpt = "The authority released an unrelated tax announcement.",
    f => f.root.publishedAt = "2026-08-21T21:00:00Z",
    f => f.report.publishedAt = "2026-08-22T21:00:00Z",
    f => f.root.timingChecked = false,
    f => f.report.url = "https://www.sec.gov/Archives/same-official",
    f => f.entry.observedReturn = "+99.99%",
    f => f.entry.chains[0].expectedDirection = Number(f.entry.observedReturn.slice(0, -1)) > 0 ? "negative" : "positive",
    f => f.background.backgroundSubjects = ["unrelated-company"],
    f => f.entry.chains[0].mechanismEvidenceIds = [],
  ]) {
    const f = inferredFixture(); mutate(f);
    assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { requireComplete: true }));
  }
});

test("date-only roots require the exact timed event value before close, never a later market wrap", () => {
  const f = inferredFixture();
  f.root.publishedAt = "2026-08-21";
  f.root.supportingExcerpt += " Consumer Confidence Expectations Index was 68.4 points.";
  f.report.supportingExcerpt += " Consumer Confidence Expectations Index was 68.4 points.";
  f.entry.chains[0].eventAnchors = ["Consumer Confidence Expectations Index", "68.4 points"];
  f.attribution.entries[0].chains[0].eventAnchors = ["Consumer Confidence Expectations Index", "68.4 points"];
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), /时间先后/);
  f.report.publishedAt = "2026-08-21T19:30:00Z";
  assert.doesNotThrow(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger));
  f.entry.chains[0].eventAnchors = ["Acme Robotics", "factory order recovery"];
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), /具体数值/);
  f.entry.chains[0].eventAnchors = ["Consumer Confidence Expectations Index", "68.4 points"];
  f.report.supportingExcerpt = f.report.supportingExcerpt.replace("68.4 points", "88.6 points");
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), /锚点/);
});

test("one issuer exposure cannot establish an entire AI basket's transmission", () => {
  const f = inferredFixture(), target = recapTargets(f.envelope).find(item => item.kind === "ai_layer");
  f.entry.basis = "unresolved"; f.entry.chains = [];
  const entry = f.attribution.entries.find(item => item.target === target.symbol);
  entry.basis = "inferred";
  Object.assign(entry.chains[0], { rootEvidenceId: f.root.id, reactionEvidenceId: f.report.id, mechanismEvidenceIds: [f.background.id] });
  f.background.targets = [target.symbol];
  f.background.backgroundSubjects = [target.constituents[0].symbol];
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), /全部适用对象/);
  f.background.backgroundSubjects = target.constituents.map(item => item.symbol);
  assert.doesNotThrow(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger));
});

test("background-only and unresolved targets remain incomplete even when measured or plausible", () => {
  const f = inferredFixture();
  const onlyBackground = { sources: [f.background] };
  assert.ok(recapAttributionCandidates(f.envelope, recapTargets(f.envelope), onlyBackground).every(item => !item.inferredIngredientsPresent));
  f.entry.basis = "unresolved"; f.entry.chains = [];
  assert.doesNotThrow(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger));
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { requireComplete: true }), /未完成/);
});
