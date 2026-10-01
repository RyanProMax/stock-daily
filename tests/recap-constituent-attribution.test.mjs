import assert from "node:assert/strict";
import test from "node:test";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { recapTargets, completeRecapPlan, assessRecapEvidenceCoverage, validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { recapAttributionCandidates, validateRecapAttribution, attributionEvidenceIds } from "../scripts/recap-attribution.mjs";
import { validateResearchOutput, verifyResearchSources, verifiedCurrentCompanySubjects } from "../scripts/daily-workflow-core.mjs";
import { sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { snapshotFromOpenedSource, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { COMPANY_OUTLOOK_VERSION, companyOutlookDefinitions } from "../scripts/company-outlook.mjs";

// Synthetic test returns exercise assembly, not a real report acceptance.
function decomposition() {
  const f = recapFixture(), target = f.envelope.aiChainPerformance.find(item => item.layer === "servers");
  const members = [["SMCI", "Super Micro Computer", "+0.12%", "supermicro.com"], ["DELL", "Dell Technologies", "-0.30%", "dell.com"], ["HPE", "Hewlett Packard Enterprise", "+3.90%", "hpe.com"], ["VRT", "Vertiv", "-2.83%", "vertiv.com"]];
  target.change = "+0.22%";
  target.constituents.forEach((company, index) => Object.assign(company, { symbol: members[index][0], name: members[index][1], nameEn: members[index][1], change: members[index][2] }));
  const entry = f.attribution.entries.find(item => item.target === target.symbol), anomaly = completeRecapPlan(f.envelope).anomalies.find(item => item.target === target.symbol);
  entry.observedReturn = target.change; entry.chains = []; entry.counterEvidenceIds = [];
  for (const [symbol, name, change, domain] of members) {
    const quote = `${name} disclosed its factory order update. Demand and financing conditions changed for this company.`;
    const root = { ...f.ledger.sources[0], id: `${symbol}-facts`, anomalyId: anomaly.id, scope: "company", targets: [symbol], companySubjects: [symbol], companySubjectChecked: true, url: `https://www.${domain}/news/test`, supportingExcerpt: quote };
    const report = { ...f.ledger.sources[1], id: `${symbol}-causal`, anomalyId: anomaly.id, scope: "company", targets: [symbol], companySubjects: [symbol], companySubjectChecked: true, url: `https://www.reuters.com/markets/test-${symbol}`, supportingExcerpt: `${name} shares ${change.startsWith('-') ? 'fell' : 'rose'} after its factory order update changed demand expectations; other events remained possible.` };
    f.ledger.sources.push(root, report);
    entry.chains.push({ ...f.attribution.entries[0].chains[0], basis: "reported", subjectTargets: [symbol], rootEvidenceId: root.id, reactionEvidenceId: report.id, eventAnchors: [name, "factory order update"], expectedDirection: change.startsWith('-') ? "negative" : "positive" });
  }
  const rawEntry = f.raw.entries.find(item => item.target === target.symbol);
  rawEntry.evidenceIds = attributionEvidenceIds(entry);
  rawEntry.why += " SMCI 的需求变化支持上涨，DELL 的订单变化形成拖累，HPE 的需求预期改善支持上涨，VRT 的订单变化则形成相反力量。各公司的变化分别影响对应股价，等权计算仅说明它们怎样构成篮子的收盘变化，后续应逐一观察需求兑现和融资条件。";
  rawEntry.whyEn += " SMCI and HPE had positive demand reactions, while DELL and VRT had adverse company reactions. Each event applies to its own issuer, and equal weighting aggregates those distinct observed returns without identifying causal contribution.";
  return { ...f, target, entry, anomaly, rawEntry };
}

test("four separately reported company reactions can explain an equal-weight basket without widening any original subject", () => {
  const f = decomposition();
  assert.equal(validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { requireComplete: true }), f.attribution);
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { requireComplete: true, attribution: f.attribution }).status, "complete");
  const candidate = recapAttributionCandidates(f.envelope, recapTargets(f.envelope), f.ledger).find(item => item.target === f.target.symbol);
  assert.ok(candidate.constituents.every(company => company.reportedEligible));
  assert.ok(candidate.constituents.find(company => company.symbol === "HPE").reportedPairs.some(pair => pair.root === "HPE-facts" && pair.reaction === "HPE-causal"));
  assert.ok(!f.ledger.sources.find(source => source.id === "HPE-causal").targets.includes(f.target.symbol));
  assert.equal(assessRecapEvidenceCoverage(f.envelope, f.ledger).entries.find(item => item.target === f.target.symbol).status, "eligible_for_review");
});

test("a future company outlook keeps its prospective wording at the recap gate without fabricated result metrics", () => {
  const f = decomposition(), source = f.ledger.sources.find(item => item.id === "HPE-facts"), reaction = f.ledger.sources.find(item => item.id === "HPE-causal");
  source.supportingExcerpt = "HPE is raising its FY27 Networking segment revenue growth outlook to between high teens to low-20s percent.";
  source.causalConnection = false;
  source.companyOutlookEvidenceVersion = COMPANY_OUTLOOK_VERSION;
  source.companyOutlooks = companyOutlookDefinitions(source, { finalUrl: source.url, text: source.supportingExcerpt });
  assert.equal(source.companyOutlooks.length, 1);
  reaction.supportingExcerpt = "Hewlett Packard Enterprise rose because its Networking revenue outlook increased; other events remained possible.";
  f.entry.chains[2].eventAnchors = ["Networking", "revenue"];
  const outlook = source.companyOutlooks[0];
  f.rawEntry.why += outlook.copyZh; f.rawEntry.whyEn += ` ${outlook.copyEn}`;
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }).status, "complete");
  f.rawEntry.whyEn += " Reported quarterly revenue grew.";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /财报归因缺少/);
  f.rawEntry.whyEn = f.rawEntry.whyEn.replace(" Reported quarterly revenue grew.", "");
  delete source.companyOutlooks; delete source.companyOutlookEvidenceVersion;
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /财报归因缺少/);
});

test("missing, contradictory, wrong-subject and wrong-date company explanations cannot hide inside a matching net basket", () => {
  for (const mutate of [
    f => f.entry.chains.shift(),
    f => f.entry.chains[3].expectedDirection = "positive",
    f => f.entry.chains[2].subjectTargets = ["HPE", "VRT"],
    f => f.entry.chains[2].subjectTargets = ["OTHER"],
    f => f.entry.chains[2].subjectTargets = ["HPE", "HPE"],
    f => delete f.ledger.sources.find(source => source.id === "HPE-causal").companySubjectChecked,
    f => f.ledger.sources.find(source => source.id === "HPE-facts").companySubjects = ["VRT"],
    f => f.target.constituents[0].asOf = "2026-08-20",
    f => { f.target.change = "+0.30%"; f.entry.observedReturn = f.target.change; },
    f => f.target.benchmarkKind = "sector_index",
  ]) { const f = decomposition(); mutate(f); assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger)); }
  const flat = decomposition(); flat.target.constituents[0].change = "0.00%"; flat.target.change = "+0.19%"; flat.entry.observedReturn = flat.target.change;
  assert.throws(() => validateRecapAttribution(flat.attribution, flat.envelope, recapTargets(flat.envelope), flat.ledger), /SMCI.*实际涨跌/);
  const zero = decomposition(); zero.target.constituents[0].change = "0.00%"; zero.target.change = "+0.19%"; zero.entry.observedReturn = zero.target.change; zero.entry.chains[0].expectedDirection = "flat";
  assert.doesNotThrow(() => validateRecapAttribution(zero.attribution, zero.envelope, recapTargets(zero.envelope), zero.ledger));
});

test("a market or sector chain cannot select its own index or representative companies as component subjects", () => {
  for (const symbol of ["SPX", "XLF"]) {
    for (const subjects of [[symbol], ["banking"], ["HPE"]]) {
      const f = recapFixture(), entry = f.attribution.entries.find(e => e.target === symbol);
      entry.chains[0].subjectTargets = subjects;
      assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), error => error.message.startsWith(symbol) && /subjectTargets: \[\]/u.test(error.message));
      // The validator preserves rejected output; no automatic scope widening.
      assert.deepEqual(entry.chains[0].subjectTargets, subjects);
    }
  }
});

test("an unresolved basket may retain a verified company chain for further research but still cannot enter complete publication", () => {
  const f = decomposition(); f.entry.basis = "unresolved"; f.entry.chains = [f.entry.chains[2]];
  assert.doesNotThrow(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger));
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger, { requireComplete: true }), /未完成/);
  f.rawEntry.status = "explained";
  f.rawEntry.evidenceIds = attributionEvidenceIds(f.entry);
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /已审查传导/);
  f.entry.chains[0].expectedDirection = "negative";
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), /HPE.*实际涨跌/);
});

test("literal event-anchor failures identify the exact company pair and reject composed labels or absent company aliases", () => {
  const f = decomposition(), chain = f.entry.chains[2];
  chain.eventAnchors = ["HPE factory order update", "Hewlett Packard Enterprise (HPE)"];
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), error => /AI-US-servers/.test(error.message) && /HPE-facts/.test(error.message) && /HPE-causal/.test(error.message) && /eventAnchors/.test(error.message) && /两段引文/.test(error.message));
});

test("mixed reported/inferred companies need their own exposure, explicit medium confidence and complete bilingual company copy", () => {
  const f = decomposition(), chain = f.entry.chains[3];
  const exposure = { ...f.ledger.sources.find(source => source.id === "VRT-facts"), id: "VRT-background", kind: "background", publishedAt: "2026-01-28", backgroundSubjects: ["VRT"], subjectIdentityChecked: true, causalConnection: false };
  f.ledger.sources.push(exposure); chain.basis = "inferred"; chain.mechanismEvidenceIds = [exposure.id]; f.entry.basis = "inferred";
  f.rawEntry.why = "推断：" + f.rawEntry.why; f.rawEntry.whyEn = "Inference: " + f.rawEntry.whyEn; f.rawEntry.evidenceIds = attributionEvidenceIds(f.entry);
  assert.doesNotThrow(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger));
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }).status, "complete");
  f.rawEntry.confidence = "high";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /中等置信/);
  f.rawEntry.confidence = "medium"; f.rawEntry.whyEn = f.rawEntry.whyEn.replaceAll("VRT", "another company");
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /所有成分股/);
  exposure.backgroundSubjects = ["HPE"];
  assert.throws(() => validateRecapAttribution(f.attribution, f.envelope, recapTargets(f.envelope), f.ledger), /全部适用对象/);
});

test("two reporting origins elsewhere in the basket cannot raise another company's single-origin explanation to high confidence", () => {
  const f = decomposition(); f.rawEntry.confidence = "high";
  for (const source of f.ledger.sources.filter(source => source.id.endsWith('-causal'))) Object.assign(source, { provenanceChecked: true, reportingOrigin: { key: source.id.startsWith('HPE') ? "agency:associated_press" : "agency:reuters", identified: true } });
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /逐公司独立报道/);
});

test("component target evidence stays within the supplied membership and cannot be retagged as a company claim about the whole ETF/basket", () => {
  const f = decomposition(), seed = f.anomaly.factQueries[0];
  const output = { contractVersion: "stock-daily-evidence-worker-v1", role: "facts", market: "US", anomalyId: f.anomaly.id, outcome: "found", queries: [seed, "US August 21 2026 HPE official networking release"], sources: [{ url: "https://www.hpe.com/news/test", sourceLabel: "HPE", title: "HPE official company announcement", publishedAt: "2026-08-21T13:00:00Z", kind: "official", scope: "company", targets: ["HPE"], supportingExcerpt: "HPE disclosed its current networking forecast, which remains a forward-looking company prediction.", facts: "HPE发布网络业务预测；这属于前瞻性公司信息，实际能否兑现仍不确定。", hypothesisIds: [f.anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] }], alternatives: [] };
  assert.equal(validateResearchOutput(output, "facts", f.anomaly, f.envelope).sources[0].targets[0], "HPE");
  for (const symbol of [f.anomaly.target, "OTHER"]) {
    const changed = structuredClone(output); changed.sources[0].targets = [symbol];
    assert.equal(validateResearchOutput(changed, "facts", f.anomaly, f.envelope).sources.length, 0);
  }
});

test("current company subject identity rederives from frozen originals and rejects a primary issuer's competitor mention", async () => {
  const f = decomposition();
  const make = (url, quote, targets) => ({ originalUrl: url, sourceLabel: "HPE", title: "HPE original networking announcement", publishedAt: "2026-08-21T13:00:00Z", kind: "official", supportingExcerpt: quote, facts: "公司发布网络业务预测，实际兑现结果仍然具有不确定性。", scope: "company", targets, hypothesisIds: [], causalConnection: false, comparisons: [], role: "facts", anomalyId: f.anomaly.id });
  const url = "https://www.hpe.com/news/test", quote = "HPE disclosed its networking forecast and discussed Vertiv's separate equipment sales.";
  const body = Buffer.from(`<meta property="article:published_time" content="2026-08-21T13:00:00Z"><p>${quote}</p>`);
  const opened = { finalUrl: url, status: 200, contentType: "text/html", rawBody: body, metadataReceipts: [], text: sourceBodyText(body), publishedAtCandidates: sourcePublishedAtCandidates(body, "text/html", url), publishedDateCandidates: sourcePublishedDateCandidates(body, "text/html", url), articleProvenance: sourceArticleProvenance(body.toString(), url) };
  const ledger = await verifyResearchSources([{ sources: [make(url, quote, ["HPE"])], alternatives: [] }], f.envelope, { reader: async () => opened });
  assert.deepEqual(ledger.sources[0].companySubjects, ["HPE"]);
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, opened)] };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope }));
  for (const mutate of [s => delete s.companySubjectChecked, s => delete s.companySubjects, s => s.companySubjects = ["VRT"], s => s.targets = ["VRT"]]) {
    const changed = structuredClone(ledger); mutate(changed.sources[0]); assert.throws(() => auditLedgerSourceSnapshots(changed, book, { envelope: f.envelope }));
  }
  const wrong = await verifyResearchSources([{ sources: [make(url, quote, ["VRT"])], alternatives: [] }], f.envelope, { reader: async () => opened });
  assert.equal(wrong.sources.length, 0); assert.match(wrong.rejected[0].reason, /原始发行人/);
});

test("native registry labels and SEC archive ownership cannot turn competitor mentions into current company facts", () => {
  const f = decomposition();
  const source = { kind: "official", role: "facts", scope: "company", targets: ["VRT"], supportingExcerpt: "Vertiv and AMD discussed separate equipment demand." };
  const opened = finalUrl => ({ finalUrl, rawBody: Buffer.from('<p>Original announcement without inline filing identity.</p>'), contentType: "text/html" });
  assert.throws(() => verifiedCurrentCompanySubjects(source, opened("https://www.amd.com/news/test"), f.envelope), /原始发行人/);
  assert.throws(() => verifiedCurrentCompanySubjects(source, opened("https://www.sec.gov/Archives/edgar/data/1645590/000164559026000001/ex99.htm"), f.envelope), /原始发行人/);
  assert.throws(() => verifiedCurrentCompanySubjects(source, opened("https://www.sec.gov/Archives/edgar/data/123456/000123456026000001/ex99.htm"), f.envelope), /原始发行人/);
  assert.deepEqual(verifiedCurrentCompanySubjects(source, opened("https://www.sec.gov/Archives/edgar/data/1674101/000167410126000001/ex99.htm"), f.envelope), ["VRT"]);
  Object.assign(f.envelope.aiChainPerformance.find(item => item.layer === "chips").constituents[0], { symbol: "AMD", name: "Advanced Micro Devices", nameEn: "Advanced Micro Devices" });
  const nativeAmd = { ...source, targets: ["AMD"], supportingExcerpt: "AMD discussed its own equipment demand." };
  assert.deepEqual(verifiedCurrentCompanySubjects(nativeAmd, opened("https://www.amd.com/news/test"), f.envelope), ["AMD"]);
});
