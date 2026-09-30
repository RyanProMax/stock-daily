import assert from "node:assert/strict";
import test from "node:test";
import { stableHash } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { collectRecapMacroData, parseTreasurySnapshot, treasuryDataUrl, validateRecapMacroData } from "../scripts/recap-macro-data.mjs";

const rows = [
  { date: "2026-08-19", two: 4.80, ten: 5.20, thirty: 5.50 },
  { date: "2026-08-20", two: 4.81, ten: 5.24, thirty: 5.56 },
  { date: "2026-08-21", two: 4.79, ten: 5.26, thirty: 5.59 },
  { date: "2026-08-24", two: 99, ten: 99, thirty: 99 },
];
function xml(data = rows) {
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><title>DailyTreasuryYieldCurveRateData</title><updated>2026-08-21T21:00:00Z</updated>${data.map(row => `<entry><content type="application/xml"><m:properties><d:NEW_DATE>${row.date}T00:00:00</d:NEW_DATE><d:BC_2YEAR>${row.two}</d:BC_2YEAR><d:BC_10YEAR>${row.ten}</d:BC_10YEAR><d:BC_30YEAR>${row.thirty}</d:BC_30YEAR></m:properties></content></entry>`).join("")}</feed>`;
}
function snapshot(body = xml()) {
  return { url: treasuryDataUrl(2026), finalUrl: treasuryDataUrl(2026), xml: body, payloadHash: stableHash(body), fetchedAt: "2026-08-21T22:00:00Z" };
}
function options(body = xml()) {
  return { now: () => new Date("2026-08-21T22:00:00Z"), reader: async url => ({ rawBody: Buffer.from(body), finalUrl: url }) };
}

test("official par yields retain original XML and recompute differences in basis points", async () => {
  const envelope = recapFixture().envelope;
  const book = await collectRecapMacroData(envelope, options());
  assert.equal(book.gaps.length, 0);
  assert.equal(book.snapshots[0].xml, xml());
  assert.equal(book.context.dataDate, "2026-08-21");
  assert.equal(book.context.previousDataDate, "2026-08-20");
  assert.equal(book.context.rates.tenYear.actualPercent, 5.26);
  assert.equal(book.context.rates.tenYear.changeBasisPoints, 2);
  assert.equal(book.context.rates.twoYear.changeBasisPoints, -2);
  assert.equal(book.context.tenMinusTwoBasisPoints, 47);
  assert.equal(book.context.tenMinusTwoChangeBasisPoints, 4);
  assert.equal(book.context.publishedAt, undefined);
  assert.ok(book.context.limitations.some(text => text.includes("historical publication vintages")));
  assert.ok(book.context.limitations.some(text => text.includes("not the cause")));
  assert.equal(validateRecapMacroData(book, envelope), book);
  book.context.rates.tenYear.changeBasisPoints = 200;
  assert.throws(() => validateRecapMacroData(book, envelope), /派生值/);
});

test("future US observations cannot enter a US recap or China's earlier close", async () => {
  const envelope = recapFixture("CN").envelope;
  const book = await collectRecapMacroData(envelope, options());
  assert.equal(book.context.dataDate, "2026-08-20");
  assert.equal(book.context.rates.tenYear.actualPercent, 5.24);
  assert.equal(book.context.rates.tenYear.changeBasisPoints, 4);
  assert.ok(book.context.limitations.some(text => text.includes("not evidence of a same-day Chinese")));
});

test("wrong authority, series, namespaces, duplicate dates, null yields and invalid dates fail", () => {
  const envelope = recapFixture().envelope;
  for (const mutate of [
    value => { value.url = value.url.replace("home.treasury.gov", "unrelated.example"); },
    value => { value.finalUrl = value.finalUrl.replace("home.treasury.gov", "unrelated.example"); },
    value => { value.xml = value.xml.replace("DailyTreasuryYieldCurveRateData", "AnotherSeries"); },
    value => { value.xml = value.xml.replaceAll("http://schemas.microsoft.com/ado/2007/08/dataservices\"", "https://untrusted.example\""); },
    value => { value.xml = xml([...rows, rows[0]]); },
    value => { value.xml = value.xml.replace("2026-08-19T", "2026-02-30T"); },
    value => { value.xml = value.xml.replace('<d:BC_2YEAR>4.8</d:BC_2YEAR>', '<d:BC_2YEAR m:null="true"/>'); },
    value => { value.xml = '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + value.xml; },
    value => { value.xml = value.xml.replace("</feed>", ""); },
    value => { value.fetchedAt = "2026-08-21T18:00:00Z"; },
    value => { value.xml = value.xml.replace("2026-08-21T21:00:00Z", "2026-08-22T21:00:00Z"); },
  ]) {
    const value = snapshot(); mutate(value); value.payloadHash = stableHash(value.xml);
    assert.throws(() => parseTreasurySnapshot(value, envelope));
  }
  const value = snapshot(); value.payloadHash = "fake";
  assert.throws(() => parseTreasurySnapshot(value, envelope), /哈希/);
});

test("stale or missing observations remain explicit gaps; no prior value is silently carried forward", async () => {
  const envelope = recapFixture().envelope;
  const book = await collectRecapMacroData(envelope, options(xml(rows.filter(row => row.date !== envelope.marketAsOf))));
  assert.equal(book.context, null);
  assert.match(book.gaps[0].reason, /前向填充/);
  const unavailable = await collectRecapMacroData(envelope, { reader: async () => { throw new Error("HTTP 403"); } });
  assert.equal(unavailable.context, null);
  assert.equal(unavailable.snapshots.length, 0);
  assert.equal(unavailable.gaps[0].reason, "HTTP 403");
  unavailable.context = { rates: { tenYear: 5.26 } };
  assert.throws(() => validateRecapMacroData(unavailable, envelope), /缺口/);
});

test("first January observations use separately verified current and prior year records", async () => {
  const envelope = recapFixture().envelope;
  envelope.marketAsOf = "2026-01-02";
  envelope.session.previousAsOf = "2025-12-31";
  envelope.session.windowEnd = "2026-01-02T21:00:00Z";
  const requests = [];
  const book = await collectRecapMacroData(envelope, {
    now: () => new Date("2026-01-02T22:00:00Z"),
    reader: async url => {
      requests.push(url);
      const year = new URL(url).searchParams.get("field_tdr_date_value");
      const data = year === "2025" ? [{ ...rows[1], date: "2025-12-31" }] : [{ ...rows[2], date: "2026-01-02" }];
      return { rawBody: Buffer.from(xml(data).replace("2026-08-21T21:00:00Z", "2026-01-02T21:30:00Z")), finalUrl: url };
    },
  });
  assert.deepEqual(requests, [treasuryDataUrl(2025), treasuryDataUrl(2026)]);
  assert.equal(book.context.previousDataDate, "2025-12-31");
  assert.equal(book.context.rates.tenYear.changeBasisPoints, 2);
});
