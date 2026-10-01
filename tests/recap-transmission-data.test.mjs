import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { collectRecapTransmissionData, validateRecapTransmissionData, transmissionSourceReader } from "../scripts/recap-transmission-data.mjs";
import { verifyResearchSources, stableHash, supportingExcerptMatches } from "../scripts/daily-workflow-core.mjs";
import { normalizedEvidenceText } from "../scripts/daily-source-audit.mjs";
import { auditLedgerSourceSnapshots, snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";

const config = JSON.parse(await readFile(new URL("../data/recap-transmission-sources.json", import.meta.url), "utf8"));
function original({ date = "January 28, 2026", header = true, footerBreak = false } = {}) {
  return `<h1>${header ? `As filed with the U.S. Securities and Exchange Commission on ${date}` : "Effective January 28, 2026"}</h1><p>Select Sector SPDR Trust</p>` + Object.entries(config.sectors).map(([symbol, name]) => `<p>${name} Sector Risk: The Fund's assets will be concentrated in the ${name.toLowerCase()} sector, which means the Fund will be more affected by the performance of that sector than ${footerBreak ? `<br>3<br>Fund Summaries<br>${symbol}<br>` : ""}a fund that is more diversified.</p><p>4<br>Fund Summaries<br>${symbol}<br>Companies in the ${name.toLowerCase()} sector are affected by supply and demand, operating costs and government regulation.</p><p>Fluctuation of Net Asset Value Risk: Share values may fluctuate.</p>`).join("");
}
function reader(rawHtml, changes = {}) {
  return async () => ({ finalUrl: config.url, status: 200, contentType: "text/html; charset=utf-8", rawBody: Buffer.from(rawHtml), ...changes });
}

test("eleven original risk disclosures rederive from a single frozen body, without assigning a daily catalyst", async () => {
  const f = recapFixture();
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(original({ footerBreak: true })) });
  assert.equal(book.sources.length, 11); assert.deepEqual(book.gaps, []);
  assert.ok(book.sources.every(source => source.kind === "background" && source.causalConnection === false && source.supportingExcerpt.includes("a fund that is more diversified.")));
  assert.equal(validateRecapTransmissionData(book, f.envelope, f.plan), book);
  const ledger = await verifyResearchSources([{ sources: book.sources, alternatives: [] }], f.envelope, { reader: transmissionSourceReader(book) });
  assert.equal(ledger.sources.length, 11); assert.deepEqual(ledger.rejected, []);
  assert.ok(ledger.sources.every(source => source.backgroundSubjects.length === 1 && source.publishedAt === "2026-01-28"));
  const tampered = structuredClone(book); tampered.sources[0].supportingExcerpt += " Invented rate sensitivity.";
  assert.throws(() => validateRecapTransmissionData(tampered, f.envelope, f.plan), /重复提取/);
  book.snapshots[0].rawHtml += " changed";
  assert.throws(() => validateRecapTransmissionData(book, f.envelope, f.plan), /冻结哈希/);
});

test("effective dates, expired/future filings, wrong authorities and access failures preserve truthful gaps", async () => {
  const f = recapFixture();
  for (const sourceReader of [reader(original({ header: false })), reader(original({ date: "January 28, 2024" })), reader(original({ date: "September 30, 2026" })), reader(original(), { finalUrl: "https://mirror.example/filing.htm" }), async () => { throw new Error("HTTP 403"); }]) {
    const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: sourceReader });
    assert.equal(book.sources.length, 0); assert.equal(book.gaps.length, 11);
    assert.doesNotThrow(() => validateRecapTransmissionData(book, f.envelope, f.plan));
  }
  const cn = recapFixture("CN");
  const book = await collectRecapTransmissionData(cn.envelope, cn.plan, { reader: async () => { throw new Error("CN must not receive a US fund mechanism"); } });
  assert.equal(book.snapshots.length, 0); assert.equal(book.sources.length, 0);
});

test("frozen original source reads reuse the same body and cannot silently change on resume", async () => {
  const f = recapFixture();
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(original()) });
  const sourceHash = stableHash(book);
  let fallbackCalls = 0;
  const opened = transmissionSourceReader(book, async () => { fallbackCalls++; return { text: "Different original" }; });
  const a = await opened(config.url), b = await opened(config.url);
  assert.equal(a, b); assert.equal(fallbackCalls, 0); assert.equal(stableHash(book), sourceHash);
  await opened("https://www.reuters.com/markets/another-original");
  assert.equal(fallbackCalls, 1);
});

test("factor sentences split by an XLRE page footer retain their subject and qualifications within the excerpt bound", async () => {
  const f = recapFixture();
  const factor = `An investment\n68\nFund Summaries\nXLRE\nin a real property company may be subject to changes in supply and demand, interest rates, property taxes, operating expenses and economic conditions, including qualifications that do not establish an inverse rate sensitivity.`;
  const full = original().replace('Companies in the real estate sector are affected by supply and demand, operating costs and government regulation.', factor);
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(full) });
  const source = book.sources.find(item => item.targets[0] === "XLRE");
  assert.ok(source.supportingExcerpt.includes(factor));
  assert.ok(source.supportingExcerpt.length <= 700);
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: transmissionSourceReader(book) });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.equal(ledger.sources[0].causalConnection, false);
  const longer = full.replace(factor, factor.replace('including qualifications', 'with additional operating and regulatory uncertainty, '.repeat(5) + 'including qualifications'));
  const longBook = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(longer) });
  const longQuote = longBook.sources.find(item => item.targets[0] === "XLRE");
  assert.ok(longQuote.supportingExcerpt.startsWith('Real Estate Sector Risk:\nAn investment'));
  assert.ok(longQuote.supportingExcerpt.endsWith('do not establish an inverse rate sensitivity.'));
  assert.ok(longQuote.supportingExcerpt.length <= 700);
  const longLedger = await verifyResearchSources([{ sources: [longQuote], alternatives: [] }], f.envelope, { reader: transmissionSourceReader(longBook) });
  assert.equal(longLedger.sources.length, 1, JSON.stringify(longLedger.rejected));
});

test("a fund heading cannot lend its scope to another fund's later risk sentence, including frozen publication replay", async () => {
  const f = recapFixture();
  const rawHtml = original().replaceAll('Share values may fluctuate.', 'Share values may fluctuate when interest rates change.');
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(rawHtml) });
  const sourceReader = transmissionSourceReader(book);
  const opened = await sourceReader(config.url);
  const source = book.sources.find(item => item.targets[0] === "XLF");
  const valid = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: sourceReader });
  assert.equal(valid.sources.length, 1, JSON.stringify(valid.rejected));
  const wrong = { ...source, supportingExcerpt: source.supportingExcerpt.split('\n')[0] + '\nCompanies in the technology sector are affected by supply and demand, operating costs and government regulation.' };
  assert.ok(supportingExcerptMatches(normalizedEvidenceText(opened.text), normalizedEvidenceText(wrong.supportingExcerpt), wrong.supportingExcerpt), 'Every selected sentence really exists, in order, in this same filing');
  const rejected = await verifyResearchSources([{ sources: [wrong], alternatives: [] }], f.envelope, { reader: sourceReader });
  assert.equal(rejected.sources.length, 0);
  assert.match(rejected.rejected[0].reason, /对应基金.*风险段落/);
  const forged = structuredClone(valid);
  forged.sources[0].supportingExcerpt = wrong.supportingExcerpt;
  forged.sources[0].excerptHash = stableHash(normalizedEvidenceText(wrong.supportingExcerpt));
  const snapshots = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(config.url, opened)] };
  assert.throws(() => auditLedgerSourceSnapshots(forged, snapshots, { envelope: f.envelope }), /对应基金.*风险段落/);
  const otherRisk = { ...source, supportingExcerpt: source.supportingExcerpt.split('\n')[0] + '\nShare values may fluctuate when interest rates change.' };
  assert.ok(supportingExcerptMatches(normalizedEvidenceText(opened.text), normalizedEvidenceText(otherRisk.supportingExcerpt), otherRisk.supportingExcerpt));
  const wrongRisk = await verifyResearchSources([{ sources: [otherRisk], alternatives: [] }], f.envelope, { reader: sourceReader });
  assert.equal(wrongRisk.sources.length, 0);
  assert.match(wrongRisk.rejected[0].reason, /对应基金.*风险段落/);
});

test("ambiguous repeated fund risk headings cannot establish an exposure, and older verification caches are rechecked", async () => {
  const f = recapFixture();
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(original()) });
  const sourceReader = transmissionSourceReader(book), source = book.sources.find(item => item.targets[0] === "XLF");
  const cache = new Map();
  const valid = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: sourceReader, verifiedCache: cache });
  assert.equal(valid.sources.length, 1);
  const cached = cache.get(stableHash(source));
  delete cached.subjectIdentityVersion;
  const opened = await sourceReader(config.url);
  let reads = 0;
  const ambiguousReader = async () => { reads++; return { ...opened, text: opened.text + '\n' + source.supportingExcerpt }; };
  const rejected = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: ambiguousReader, verifiedCache: cache });
  assert.equal(reads, 1);
  assert.equal(rejected.sources.length, 0);
  assert.match(rejected.rejected[0].reason, /对应基金.*风险段落/);
  const ambiguous = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(original() + '<p>' + source.supportingExcerpt + '</p>') });
  assert.ok(!ambiguous.sources.some(item => item.targets[0] === 'XLF'));
  assert.ok(ambiguous.gaps.some(item => item.target === 'XLF'));
});

test("later financing, valuation and household-demand contexts are preserved without becoming current catalysts", async () => {
  const f = recapFixture();
  const financing = 'Profitability is largely dependent on the availability and cost of capital funds and can fluctuate significantly when interest rates change or due to increased competition.';
  const valuation = 'Securities of financial services companies may experience a dramatic decline in value when such companies experience substantial declines in the valuations of their assets.';
  const credit = 'Credit losses resulting from financial difficulties of borrowers and financial losses associated with investment activities can negatively impact the sector.';
  const spending = 'Success depends heavily on disposable household income and consumer spending.';
  const rawHtml = original()
    .replace('Companies in the financial sector are affected by supply and demand, operating costs and government regulation.', `Companies in the financial sector are affected by supply and demand, operating costs and government regulation. ${financing} ${valuation} ${credit}`)
    .replace('Companies in the consumer discretionary sector are affected by supply and demand, operating costs and government regulation.', `Companies in the consumer discretionary sector are affected by supply and demand, operating costs and government regulation. ${spending}`);
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(rawHtml) });
  assert.deepEqual(book.gaps, []);
  for (const sentence of [financing, valuation, credit]) assert.ok(book.sources.some(source => source.targets[0] === 'XLF' && source.supportingExcerpt.includes(sentence)));
  assert.ok(book.sources.some(source => source.targets[0] === 'XLY' && source.supportingExcerpt.includes(spending)));
  assert.ok(book.sources.every(source => source.kind === 'background' && source.causalConnection === false && source.supportingExcerpt.length <= 700));
  const ledger = await verifyResearchSources([{ sources: book.sources, alternatives: [] }], f.envelope, { reader: transmissionSourceReader(book) });
  assert.equal(ledger.sources.length, book.sources.length, JSON.stringify(ledger.rejected));
  assert.equal(validateRecapTransmissionData(book, f.envelope, f.plan), book);
});

test("a following contrary financing qualification is retained, and an overlong qualification is rejected with a gap", async () => {
  const f = recapFixture();
  const mechanism = 'Higher interest rates may increase borrowing costs for financial services companies.';
  const contrary = 'However, fixed-rate contracts may prevent an immediate increase in those financing costs.';
  const base = 'Companies in the financial sector are affected by supply and demand, operating costs and government regulation.';
  const rawHtml = original().replace(base, `${base} ${mechanism} ${contrary}`);
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(rawHtml) });
  const relevant = book.sources.filter(source => source.supportingExcerpt.includes(mechanism));
  assert.ok(relevant.length > 0);
  assert.ok(relevant.every(source => source.supportingExcerpt.includes(contrary)));
  const longer = rawHtml.replace(contrary, 'However, ' + 'existing fixed-rate financing contracts with additional conditions '.repeat(13) + 'may prevent an immediate increase in those financing costs.');
  const longBook = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(longer) });
  assert.ok(!longBook.sources.some(source => source.supportingExcerpt.includes(mechanism)));
  assert.ok(longBook.gaps.some(gap => gap.target === 'XLF' && gap.reason.includes('未截断')));
  const ledger = await verifyResearchSources([{ sources: longBook.sources, alternatives: [] }], f.envelope, { reader: transmissionSourceReader(longBook) });
  assert.equal(ledger.sources.length, longBook.sources.length, JSON.stringify(ledger.rejected));
});

test("consecutive references retain the actual company subgroup rather than broadening a benefit to the whole fund", async () => {
  const f = recapFixture();
  const subgroup = 'Certain utility companies have experienced full or partial deregulation in recent years.';
  const detail = 'These utility companies operate outside their original geographic regions and offer new services.';
  const benefit = 'These opportunities may permit certain utility companies to earn more than their traditional regulated rates of return.';
  const rawHtml = original().replace('Companies in the utilities sector are affected by supply and demand, operating costs and government regulation.', `Companies in the utilities sector are affected by supply and demand, operating costs and government regulation. ${subgroup} ${detail} ${benefit}`);
  const book = await collectRecapTransmissionData(f.envelope, f.plan, { reader: reader(rawHtml) });
  const relevant = book.sources.filter(source => source.supportingExcerpt.includes(benefit));
  assert.ok(relevant.length > 0);
  assert.ok(relevant.every(source => source.supportingExcerpt.includes(subgroup) && source.supportingExcerpt.includes(detail)));
  const ledger = await verifyResearchSources([{ sources: book.sources, alternatives: [] }], f.envelope, { reader: transmissionSourceReader(book) });
  assert.equal(ledger.sources.length, book.sources.length, JSON.stringify(ledger.rejected));
});
