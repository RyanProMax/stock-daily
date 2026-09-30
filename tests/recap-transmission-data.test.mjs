import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { collectRecapTransmissionData, validateRecapTransmissionData, transmissionSourceReader } from "../scripts/recap-transmission-data.mjs";
import { verifyResearchSources, stableHash } from "../scripts/daily-workflow-core.mjs";

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
