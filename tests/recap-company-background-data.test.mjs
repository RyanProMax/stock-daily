import assert from "node:assert/strict";
import test from "node:test";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { collectRecapCompanyBackgroundData, validateRecapCompanyBackgroundData, companyBackgroundSourceReader } from "../scripts/recap-company-background-data.mjs";
import { secCompanySubmissionTime, secFilingIssuerIdentity } from "../scripts/sec-filing-identity.mjs";
import { auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { verifyResearchSources, verifiedBackgroundExposureSubjects } from "../scripts/daily-workflow-core.mjs";
import { recapAttributionCandidates } from "../scripts/recap-attribution.mjs";
import { recapTargets } from "../scripts/complete-recap.mjs";

const registryUrl = "https://www.sec.gov/files/company_tickers.json";
const entities = [{ symbol: "NVDA", cik: "1045810", name: "NVIDIA" }, { symbol: "AMD", cik: "2488", name: "Advanced Micro Devices" }, { symbol: "AVGO", cik: "1730168", name: "Broadcom" }, { symbol: "TSM", cik: "1046179", name: "Taiwan Semiconductor" }];
const publishedAt = "2026-01-30T20:55:54.000Z";
const accession = entity => entity.cik.padStart(10, "0") + "-26-000021";
const filingUrl = entity => `https://www.sec.gov/Archives/edgar/data/${entity.cik}/${accession(entity).replaceAll("-", "")}/annual.htm`;
function profile(entity) { return { cik: entity.cik, tickers: [entity.symbol], filings: { recent: { form: ["10-K"], accessionNumber: [accession(entity)], primaryDocument: ["annual.htm"], acceptanceDateTime: [publishedAt] } } }; }
function html(entity) { return `<ix:header><ix:nonNumeric name="dei:EntityCentralIndexKey">${entity.cik}</ix:nonNumeric><ix:nonNumeric name="dei:EntityRegistrantName">${entity.name}</ix:nonNumeric><ix:nonNumeric name="dei:DocumentType">10-K</ix:nonNumeric><ix:nonNumeric name="dei:TradingSymbol">${entity.symbol}</ix:nonNumeric></ix:header><p>Our customer demand and investment spending may decline when interest rates and financing costs rise.</p><p>We carry debt at a fixed rate and have no financial statement risk associated with changes in interest rates.</p><p>Our financial condition may be affected by economic conditions, supply costs and changes in customer spending.</p>`; }
function fixture() {
  const f = recapFixture(), anomaly = f.plan.anomalies.find(item => item.kind === "ai_layer");
  const companies = anomaly.observation.constituents;
  for (let i = 0; i < companies.length; i++) Object.assign(companies[i], { symbol: entities[i].symbol, nameEn: entities[i].name });
  f.smallPlan = { ...f.plan, anomalies: [anomaly] };
  const requests = [];
  f.reader = async (url, options) => {
    requests.push(url);
    let rawBody, contentType = "application/json";
    if (url === registryUrl) rawBody = Buffer.from(JSON.stringify(Object.fromEntries(entities.map((entity, index) => [index, { ticker: entity.symbol, cik_str: Number(entity.cik), title: entity.name }]))));
    else {
      const entity = entities.find(item => url === filingUrl(item) || url === `https://data.sec.gov/submissions/CIK${item.cik.padStart(10, "0")}.json`);
      assert.ok(entity, url);
      if (url.includes("submissions")) rawBody = Buffer.from(JSON.stringify(profile(entity)));
      else { contentType = "text/html"; rawBody = Buffer.from(html(entity)); assert.equal(options.lookupPublicationMetadata, false); }
    }
    const { sourceBodyText } = await import("../scripts/daily-source-audit.mjs");
    return { finalUrl: url, status: 200, contentType, rawBody, text: sourceBodyText(rawBody, contentType), publishedAtCandidates: [], publishedDateCandidates: [] };
  };
  return { ...f, requests };
}

test("original code table, matching submissions and issuer metadata establish all four separate exposures and preserve fixed-rate qualifications", async () => {
  const f = fixture();
  const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  assert.equal(book.filings.length, 4); assert.equal(book.sources.length, 12); assert.deepEqual(book.gaps, []);
  assert.ok(book.sources.some(source => source.supportingExcerpt.includes("no financial statement risk")));
  assert.ok(book.sources.every(source => source.publishedAt === publishedAt && source.scope === "company" && !source.causalConnection));
  const ledger = await verifyResearchSources([{ sources: book.sources, alternatives: [] }], f.envelope, { reader: companyBackgroundSourceReader(book) });
  assert.equal(ledger.sources.length, 12, JSON.stringify(ledger.rejected));
  assert.deepEqual([...new Set(ledger.sources.flatMap(source => source.backgroundSubjects))].sort(), entities.map(item => item.symbol).sort());
  const originals = { version: SOURCE_SNAPSHOT_VERSION, snapshots: book.filings.map(item => item.snapshot) };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, originals, { envelope: f.envelope }));
  const changed = structuredClone(book); changed.sources[0].facts += " All companies rose because of a rate cut.";
  assert.throws(() => validateRecapCompanyBackgroundData(changed, f.envelope, f.smallPlan), /重建/);
  const owned = structuredClone(ledger); owned.sources[0].backgroundSubjects = ["AMD"];
  assert.throws(() => auditLedgerSourceSnapshots(owned, originals, { envelope: f.envelope }), /主体/);
});

test("a frozen filing is reused without refetching company identity, history or the original annual report", async () => {
  const f = fixture();
  const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  const resumed = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { resumeBook: book, reader: () => { throw new Error("network must not run"); } });
  assert.deepEqual(resumed.sources, book.sources); assert.deepEqual(resumed.gaps, []);
});

test("submission timestamps bind CIK, accession and exact primary filename, never a fiscal end date or a made-up offset", () => {
  const entity = entities[0], url = filingUrl(entity), data = profile(entity);
  assert.deepEqual(secCompanySubmissionTime(JSON.stringify(data), url), [publishedAt]);
  for (const mutate of [
    value => value.cik = 2488, value => value.filings.recent.accessionNumber[0] = accession(entities[1]),
    value => value.filings.recent.primaryDocument[0] = "exhibit.htm", value => value.filings.recent.acceptanceDateTime[0] = "2026-01-30T20:55:54",
    value => value.filings.recent.acceptanceDateTime[0] = "2026-02-30T20:55:54Z", value => value.filings.recent.acceptanceDateTime[0] = "2026-01-30T24:00:00Z", value => value.filings.recent.primaryDocument = [],
  ]) { const changed = structuredClone(data); mutate(changed); assert.deepEqual(secCompanySubmissionTime(JSON.stringify(changed), url), []); }
  assert.deepEqual(secCompanySubmissionTime(JSON.stringify(data), url.replace("www.sec.gov", "mirror.example")), []);
});

test("corrupted frozen originals and substituted timing receipts are invalid input, not ordinary missing evidence", async () => {
  const f = fixture(), book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  const corrupt = structuredClone(book); corrupt.filings[0].snapshot.bodyHash = "0".repeat(64);
  assert.throws(() => validateRecapCompanyBackgroundData(corrupt, f.envelope, f.smallPlan), /原始字节哈希/);
  const wrongClock = structuredClone(book);
  wrongClock.filings[0].snapshot.metadataReceipts[0] = structuredClone(book.filings[1].snapshot.metadataReceipts[0]);
  assert.throws(() => validateRecapCompanyBackgroundData(wrongClock, f.envelope, f.smallPlan), /元数据不对应/);
  const outside = structuredClone(book); outside.profiles[0].symbol = "FAKE";
  assert.throws(() => validateRecapCompanyBackgroundData(outside, f.envelope, f.smallPlan), /计划外/);
  const missingRegistry = { ...book, registry: null, profiles: [], filings: [], sources: [], gaps: entities.map(() => ({ symbol: "NVDA", reason: "unavailable" })) };
  assert.throws(() => validateRecapCompanyBackgroundData(missingRegistry, f.envelope, f.smallPlan), /缺口不完整/);
});

test("mentioning another company does not make that company the filing issuer or permit whole-sector scope", async () => {
  const f = fixture(), entity = entities[1];
  const ownHtml = html(entity).replace("Our customer demand", "Our NVIDIA customer demand");
  const identity = secFilingIssuerIdentity({ finalUrl: filingUrl(entity), rawBody: Buffer.from(ownHtml) });
  assert.deepEqual(identity.symbols, ["AMD"]);
  assert.equal(secFilingIssuerIdentity({ finalUrl: filingUrl(entities[0]), rawBody: Buffer.from(ownHtml) }), null);
  const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  const source = { ...book.sources.find(item => item.originalUrl === filingUrl(entity)), supportingExcerpt: "Our NVIDIA customer demand and investment spending may decline when interest rates and financing costs rise." };
  const reader = async () => ({ finalUrl: filingUrl(entity), rawBody: Buffer.from(ownHtml), text: ownHtml.replace(/<[^>]+>/gu, " "), publishedAtCandidates: [publishedAt] });
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader });
  assert.deepEqual(ledger.sources[0].backgroundSubjects, ["AMD"]);
  const ownedDocument = await reader();
  assert.throws(() => verifiedBackgroundExposureSubjects({ ...source, supportingExcerpt: "US interest rates and financing costs can reduce NVIDIA customer demand and investment spending." }, ownedDocument, f.envelope), /自身敞口/);
  const sector = f.plan.anomalies.find(item => item.kind === "sector");
  const broadened = { ...source, scope: "sector", targets: [sector.target], anomalyId: sector.id, supportingExcerpt: source.supportingExcerpt + " Technology Sector Risk: financing can affect the industry." };
  const rejected = await verifyResearchSources([{ sources: [broadened], alternatives: [] }], f.envelope, { reader: async () => ({ ...(await reader()), text: ownHtml.replace(/<[^>]+>/gu, " ") + broadened.supportingExcerpt }) });
  assert.equal(rejected.sources.length, 0); assert.match(rejected.rejected[0].reason, /不能自动扩大/);
});

test("a verified shared constituent keeps its original quote scope when used in another basket, while the other three still need exposure", async () => {
  const f = fixture(), other = f.envelope.aiChainPerformance.find(item => item.layer === "interconnect");
  other.constituents[0].symbol = "AVGO";
  const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  const ledger = await verifyResearchSources([{ sources: book.sources, alternatives: [] }], f.envelope, { reader: companyBackgroundSourceReader(book) });
  const broadcom = ledger.sources.filter(item => item.backgroundSubjects.includes("AVGO"));
  const all = { sources: [...f.ledger.sources, ...ledger.sources] };
  const candidate = recapAttributionCandidates(f.envelope, recapTargets(f.envelope), all).find(item => item.target === other.symbol);
  assert.ok(broadcom.every(source => candidate.mechanismEvidenceIds.includes(source.id) && !source.targets.includes(other.symbol)));
  assert.equal(candidate.inferredIngredientsPresent, false);
});

test("future or wrong-issuer annuals and access failures remain gaps without becoming background evidence", async () => {
  for (const mode of ["future", "wrong_issuer", "blocked"]) {
    const f = fixture();
    const reader = async (url, options) => {
      if (mode === "blocked" && url === registryUrl) throw new Error("HTTP 403");
      const result = await f.reader(url, options);
      if (mode === "future" && url.includes("submissions")) { const value = JSON.parse(result.rawBody); value.filings.recent.acceptanceDateTime[0] = "2026-09-30T20:55:54Z"; result.rawBody = Buffer.from(JSON.stringify(value)); }
      if (mode === "wrong_issuer" && url.includes("annual.htm")) result.rawBody = Buffer.from(html(entities[0]));
      return result;
    };
    const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader });
    assert.ok(book.gaps.length >= (mode === "wrong_issuer" ? 3 : 4));
    assert.doesNotThrow(() => validateRecapCompanyBackgroundData(book, f.envelope, f.smallPlan));
    if (mode !== "wrong_issuer") assert.deepEqual(book.sources, []);
  }
});
