import assert from "node:assert/strict";
import test from "node:test";
import { COMPANY_OUTLOOK_VERSION, companyOutlookDefinitions, verifiedCompanyOutlooks } from "../scripts/company-outlook.mjs";
import { requiresFinancialComparisons, assertFinancialCopyIncludesMetrics, verifyResearchSources, validateAdjudication } from "../scripts/daily-workflow-core.mjs";
import { sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { auditLedgerSourceSnapshots, snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

const url = "https://www.hpe.com/news/test-outlook";
const statement = "HPE is raising its FY27 Networking segment revenue growth outlook to between high teens to low-20s percent.";
const excerpt = `${statement} The company expects Networking segment operating margin to be in the mid-to-high 20s percent range.`;
const clock = "2026-08-21T13:00:00.000Z";
function hpeFixture() {
  const f = recapFixture();
  const server = f.envelope.aiChainPerformance.find(item => item.layer === "servers");
  Object.assign(server.constituents[2], { symbol: "HPE", name: "Hewlett Packard Enterprise", nameEn: "Hewlett Packard Enterprise" });
  return f;
}
function candidate() {
  const f = hpeFixture(), anomaly = f.plan.anomalies.find(item => item.target === "AI-US-servers");
  return { originalUrl: url, title: "HPE networking outlook revision", publishedAt: clock, kind: "official", role: "facts", sourceType: "first_party", scope: "company", targets: ["HPE"], companySubjects: ["HPE"], companySubjectChecked: true, supportingExcerpt: excerpt, facts: "HPE上调FY27网络业务展望，这是对未来财年的公司预测。", anomalyId: anomaly.id, hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] };
}
function opened() {
  const html = `<html><head><meta property="article:published_time" content="${clock}"></head><body><article><h1>HPE networking outlook revision</h1><p>HPE (NYSE: HPE) updates its own Networking business outlook.</p><p>${excerpt}</p></article></body></html>`;
  const rawBody = Buffer.from(html);
  return { finalUrl: url, status: 200, contentType: "text/html", rawBody, text: sourceBodyText(rawBody), publishedAtCandidates: sourcePublishedAtCandidates(rawBody, "text/html", url), publishedDateCandidates: sourcePublishedDateCandidates(rawBody, "text/html", url), articleProvenance: sourceArticleProvenance(html, url) };
}
function definitions(source = candidate(), original = opened()) {
  return companyOutlookDefinitions(source, original);
}

test("future outlook identity comes from the issuer's exact own statement, not generated labels", () => {
  const [outlook] = definitions();
  assert.equal(outlook.issuer, "HPE"); assert.equal(outlook.fiscalYear, 2027); assert.equal(outlook.business, "Networking"); assert.equal(outlook.revision, "raised"); assert.equal(outlook.statement, statement);
  assert.ok(outlook.copyEn.includes("revenue-growth")); assert.ok(outlook.copyZh.includes("营收增长"));
  for (const change of [{ role: "causal" }, { sourceType: "publisher" }, { scope: "sector" }, { kind: "background" }, { targets: ["DELL"] }, { companySubjects: ["DELL"] }, { supportingExcerpt: excerpt.replace("FY27", "FY26") }, { supportingExcerpt: excerpt.replace("FY27", "FY33") }, { supportingExcerpt: excerpt.replace("Networking", "Servers") }, { supportingExcerpt: excerpt.replace("raising", "reporting") }]) assert.deepEqual(definitions({ ...candidate(), ...change }), [], JSON.stringify(change));
  assert.deepEqual(definitions(candidate(), { ...opened(), finalUrl: "https://www.dell.com/news/test" }), []);
  assert.deepEqual(definitions(candidate(), { ...opened(), text: opened().text.replace(statement, "The release contains no outlook revision.") }), []);
  const lower = statement.replace("raising", "lowering");
  assert.equal(definitions({ ...candidate(), supportingExcerpt: lower }, { ...opened(), text: lower })[0].revision, "lowered");
});

test("only bound, explicitly prospective bilingual copy avoids inventing realized-result comparisons", () => {
  const companyOutlooks = definitions(), outlook = companyOutlooks[0];
  const claim = { title: "HPE networking outlook revision", factSummary: outlook.copyEn, companyOutlooks, comparisons: [] };
  for (const copy of [outlook.copyEn, outlook.copyZh, `${outlook.copyEn} Improved demand may support earnings expectations.`]) {
    assert.equal(requiresFinancialComparisons(copy), true);
    assert.equal(requiresFinancialComparisons(copy, { companyOutlooks }), false);
    assert.doesNotThrow(() => assertFinancialCopyIncludesMetrics(copy, claim, "future outlook"));
  }
  for (const copy of [
    "HPE forecast revenue growth; these figures have not been realized.",
    outlook.copyEn.replace("HPE", "DELL"), outlook.copyEn.replace("FY27", "FY28"), outlook.copyEn.replace("Networking", "Servers"),
    outlook.copyEn.replace("raised", "lowered"), outlook.copyEn.replace(" and has not been realized", ""),
    `${outlook.copyEn} Revenue reached $12B.`, `${outlook.copyEn} Profit grew.`, `${outlook.copyEn} Actual EPS was $1.20.`,
    `${outlook.copyEn} It beat consensus.`, `${outlook.copyEn} The numbers were achieved.`, `${outlook.copyZh} 公司已实现利润增长。`,
    `${outlook.copyEn} It beat consensus, while shares traded ahead of earnings.`, `${outlook.copyZh} 数字高于预期，同时在下一次财报公布前交易。`,
    `${outlook.copyZh} 营收高于预期。`, `${outlook.copyZh} 业绩录得增长。`,
  ]) {
    assert.equal(requiresFinancialComparisons(copy, { companyOutlooks }), true, copy);
    assert.throws(() => assertFinancialCopyIncludesMetrics(copy, claim, "mixed or unsupported"), /实际值与基准|完整预测描述/);
  }
  assert.throws(() => assertFinancialCopyIncludesMetrics("HPE shares rose following the company announcement.", claim, "omitted revenue outlook"), /完整预测描述/);
  assert.throws(() => assertFinancialCopyIncludesMetrics(outlook.copyZh, claim, "wrong language", { language: "en" }), /完整预测描述/);
  assert.throws(() => assertFinancialCopyIncludesMetrics(outlook.copyEn, claim, "wrong language", { language: "zh" }), /完整预测描述/);
  assert.throws(() => assertFinancialCopyIncludesMetrics(outlook.copyEn, { ...claim, title: "Reported quarterly results" }, "mixed claim"), /实际值与基准/);
});

test("original admission and frozen replay reconstruct outlook scope and reject altered receipts", async () => {
  const f = hpeFixture(), research = [{ sources: [candidate()], alternatives: [] }];
  const ledger = await verifyResearchSources(research, f.envelope, { reader: async () => opened() });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  const source = ledger.sources[0];
  assert.equal(source.companyOutlookEvidenceVersion, COMPANY_OUTLOOK_VERSION);
  assert.deepEqual(verifiedCompanyOutlooks([source]), definitions());
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, opened())] };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope }));
  for (const mutate of [s => s.companyOutlooks[0].fiscalYear = 2028, s => s.companyOutlooks[0].issuer = "DELL", s => s.companyOutlooks[0].business = "Servers", s => s.companyOutlooks[0].statement += " Revenue beat consensus.", s => s.companyOutlooks[0].copyEn += " Revenue was realized.", s => s.companyOutlookEvidenceVersion = "unsupported", s => s.companyOutlooks = []]) {
    const changed = structuredClone(ledger); mutate(changed.sources[0]);
    assert.throws(() => auditLedgerSourceSnapshots(changed, book, { envelope: f.envelope }), /展望/);
  }
  const old = structuredClone(ledger); delete old.sources[0].companyOutlooks; delete old.sources[0].companyOutlookEvidenceVersion;
  assert.deepEqual(verifiedCompanyOutlooks(old.sources), []);
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(old, book, { envelope: f.envelope }));
});

test("old positive company caches cannot bypass the new original-bound outlook classification", async () => {
  const f = hpeFixture(), source = candidate(), first = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: async () => opened() });
  const old = structuredClone(first.sources[0]); delete old.companyOutlooks; delete old.companyOutlookEvidenceVersion;
  let reads = 0;
  const cache = new Map([[old.candidateHash, old]]);
  const replay = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { verifiedCache: cache, reader: async () => { reads++; return opened(); } });
  assert.equal(reads, 1); assert.equal(replay.sources[0].companyOutlooks.length, 1);
  await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { verifiedCache: new Map([[replay.sources[0].candidateHash, replay.sources[0]]]), reader: async () => { throw new Error("new verified cache need not reopen"); } });
});

test("facts corrected to public-event scope carry no company-outlook exemption or invalid replay receipt", async () => {
  const f = recapFixture(), raw = candidate();
  delete raw.companySubjects; delete raw.companySubjectChecked; delete raw.sourceType;
  const ledger = await verifyResearchSources([{ sources: [raw], alternatives: [] }], f.envelope, { reader: async () => opened() });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  const source = ledger.sources[0];
  assert.equal(source.scope, "event_only");
  assert.equal(source.companyOutlookEvidenceVersion, undefined); assert.equal(source.companyOutlooks, undefined);
  auditLedgerSourceSnapshots(ledger, { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, opened())] }, { envelope: f.envelope });
  const replay = await verifyResearchSources([{ sources: [raw], alternatives: [] }], f.envelope, { verifiedCache: new Map([[source.candidateHash, source]]), reader: async () => { throw new Error("unchanged event-only cache need not reopen"); } });
  assert.equal(replay.sources.length, 1, JSON.stringify(replay.rejected));
});

test("adjudicated cards retain only selected code-verified outlooks, including their original fiscal period", async () => {
  const f = hpeFixture(), source = candidate(), verified = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: async () => opened() });
  const root = verified.sources[0], outlook = root.companyOutlooks[0];
  f.envelope.sectorPerformance[0].constituents.push({ symbol: "HPE", name: "Hewlett Packard Enterprise" });
  const hypothesisId = root.hypothesisIds[0], anomaly = { id: root.anomalyId, target: "HPE", kind: "company", direction: "positive", hypotheses: [{ id: hypothesisId }] };
  const plan = { market: f.envelope.market, marketAsOf: f.envelope.marketAsOf, anomalies: [anomaly] };
  const reaction = { id: "independent-test-reaction", role: "causal", anomalyId: anomaly.id, hypothesisIds: [hypothesisId], causalConnection: true, scope: "company", targets: ["HPE"], supportingExcerpt: "HPE rose because its Networking revenue forecast increased.", excerptHash: "different-test-excerpt", comparisons: [] };
  const ledger = { sources: [root, reaction], alternatives: [{ anomalyId: anomaly.id, role: "causal" }] };
  const card = { anomalyId: anomaly.id, hypothesisId, scope: "company", targets: ["HPE"], evidenceIds: [root.id, reaction.id], comparisonIds: [], title: "HPE展望上调", factSummary: outlook.copyZh, causalStatement: "专业报道将公司的网络业务预测上调与当日股价反应联系起来；未来增长目标能否兑现仍然需要继续观察订单和公司后续披露。", publishedAs: "market_driver", sectorSymbols: [f.envelope.sectorPerformance[0].symbol], direction: "positive", basis: "event", alternativeAssessment: "其他市场消息仍可能同时影响股价，不能推算精确因果贡献。" };
  const result = { contractVersion: "stock-daily-adjudication-v1", market: plan.market, decisions: [{ anomalyId: anomaly.id, verdict: "accepted", publishedAs: "market_driver", reason: "Test fixture connects the same prospective company outlook and price reaction." }], claimCards: [card] };
  const normalized = validateAdjudication(result, plan, ledger, f.envelope);
  assert.deepEqual(normalized.claimCards[0].companyOutlooks, [outlook]);
  assert.deepEqual(normalized.claimCards[0].comparisons, []);
  result.claimCards[0].factSummary += " 公司营收高于一致预期。";
  assert.throws(() => validateAdjudication(result, plan, ledger, f.envelope), /财报归因缺少/);
});
