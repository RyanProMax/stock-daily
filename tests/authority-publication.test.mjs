import assert from "node:assert/strict";
import test from "node:test";
import { FED_SPEECH_FEED, fedSpeechPublicationRecord } from "../scripts/fed-speech-publication.mjs";
import { secFilingPublicationRecord } from "../scripts/sec-filing-publication.mjs";
import { boundMetadataPublication, readExternalSource, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { auditLedgerSourceSnapshots, openedSourceFromSnapshot, snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { assertFactsNumbersInExcerpt, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

const fedUrl = "https://www.federalreserve.gov/newsevents/speech/jefferson20261001a.htm";
const fedTitle = "The U.S. Economy and Monetary Policy";
const quote = "The economy has continued to expand while the labor market has softened and the balance of risks has shifted.";
const fedBody = `<div id="article"><div class="heading"><p class="article__time">October 01, 2026</p><h3 class="title">${fedTitle}</h3></div><p>${quote}</p></div>`;
const fedItem = `<item><title>Jefferson, ${fedTitle}</title><link>${fedUrl}</link><guid>${fedUrl}</guid><category>Speech</category><pubDate>Thu, 1 Oct 2026 17:30:00 GMT</pubDate></item>`;
const fedFeed = `<rss><channel>${fedItem}</channel></rss>`;
const secUrl = "https://www.sec.gov/Archives/edgar/data/723125/000072312526000018/a2026q4ex991-pressrelease.htm";
const secMetadata = "https://www.sec.gov/Archives/edgar/data/723125/000072312526000018/0000723125-26-000018.txt";
const secBody = `<html><head><title>Document</title></head><body><p>${quote}</p></body></html>`;
const secDocument = `<DOCUMENT>\n<TYPE>EX-99.1\n<SEQUENCE>2\n<FILENAME>a2026q4ex991-pressrelease.htm\n<TEXT>\n${secBody}\n</TEXT>\n</DOCUMENT>`;
const secSubmission = `<SEC-DOCUMENT>0000723125-26-000018.txt : 20260930\n<SEC-HEADER>0000723125-26-000018.hdr.sgml : 20260930\n<ACCEPTANCE-DATETIME>20260930160222\nACCESSION NUMBER: 0000723125-26-000018\nCONFORMED SUBMISSION TYPE: 8-K\nFILED AS OF DATE: 20260930\nFILER:\nCOMPANY CONFORMED NAME: MICRON TECHNOLOGY INC\nCENTRAL INDEX KEY: 0000723125\n</SEC-HEADER>\n${secDocument}`;

function envelope() {
  const value = structuredClone(recapFixture().envelope);
  value.marketAsOf = "2026-10-01";
  Object.assign(value.session, { asOf: "2026-10-01", windowStart: "2026-09-30T20:00:00.000Z", windowEnd: "2026-10-01T20:00:00.000Z", wrapDeadline: "2026-10-01T22:00:00.000Z" });
  return value;
}
const candidate = (url, date) => ({ originalUrl: url, title: "Official economic release", publishedAt: date, kind: "official", scope: "event_only", targets: [], role: "facts", anomalyId: "publication", hypothesisIds: ["official-event"], causalConnection: false, facts: quote, supportingExcerpt: quote, comparisons: [] });
const research = source => ({ sources: [source], rejectedSources: [], alternatives: [] });
async function open(url, body, metadataUrl, metadataBody) {
  return readExternalSource(url, { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async requested => {
    assert.ok([url, metadataUrl].includes(requested));
    return { status: 200, contentType: requested === url ? "text/html" : metadataUrl === FED_SPEECH_FEED ? "application/xml" : "text/plain", body: Buffer.from(requested === url ? body : metadataBody) };
  } });
}

test("Fed zero-padded owned dates bind one matching speaker, title, calendar and zoned RSS publication", () => {
  assert.equal(fedSpeechPublicationRecord(fedBody, fedFeed, fedUrl).publishedAt, "2026-10-01T17:30:00.000Z");
  assert.equal(fedSpeechPublicationRecord(fedBody.replace("October 01", "October 1"), fedFeed, fedUrl).publicationDate, "2026-10-01");
  for (const changed of [
    fedFeed.replace("Jefferson,", "Powell,"), fedFeed.replace(fedTitle, "A different policy speech"),
    fedFeed.replace("Thu,", "Fri,"), fedFeed.replace("1 Oct", "32 Oct"), fedFeed.replace("GMT", ""),
    fedFeed.replace(fedItem, `${fedItem}${fedItem}`), fedFeed.replace("<guid>", "<link>wrong</link><guid>"),
    fedFeed.replace(`<guid>${fedUrl}`, "<guid>https://www.federalreserve.gov/other"),
  ]) assert.equal(fedSpeechPublicationRecord(fedBody, changed, fedUrl), null, changed);
  for (const body of [fedBody.replace("October 01", "October 02"), fedBody.replace("October 01", "February 30"), fedBody.replace('</div><p>', '<p class="article__time">October 01, 2026</p></div><p>')]) assert.equal(fedSpeechPublicationRecord(body, fedFeed, fedUrl), null);
  assert.equal(fedSpeechPublicationRecord(fedBody, fedFeed, `${fedUrl}?date=2026-10-01`), null);
  const unrelatedClock = '<meta property="article:published_time" content="2026-10-01T14:00:00Z"><script type="application/ld+json">{"datePublished":"2026-10-01"}</script>';
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(fedBody + unrelatedClock), "text/html", fedUrl), []);
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(fedBody.replace("October 01", "October 02") + unrelatedClock), "text/html", fedUrl), []);
});

test("SEC availability binds the accession, filer, exact exhibit and valid New York acceptance clock", () => {
  const record = secFilingPublicationRecord(secDocument, secSubmission, secUrl, sourceBodyText);
  assert.equal(record.publishedAt, "2026-09-30T20:02:22.000Z");
  assert.equal(record.timeBasis, "sec_filing_availability");
  assert.equal(record.issuerName, "MICRON TECHNOLOGY INC");
  for (const changed of [
    secSubmission.replace("ACCESSION NUMBER: 0000723125-26-000018", "ACCESSION NUMBER: 0000723125-26-000019"),
    secSubmission.replace("CENTRAL INDEX KEY: 0000723125", "CENTRAL INDEX KEY: 0001045810"),
    secSubmission.replace("FILED AS OF DATE: 20260930", "FILED AS OF DATE: 20261001"),
    secSubmission.replace("20260930160222", "20260931160222"),
    secSubmission.replace("20260930160222", "20260930250222"),
    secSubmission.replace("<ACCEPTANCE-DATETIME>", "<ACCEPTANCE-DATETIME>20260930160221\n<ACCEPTANCE-DATETIME>"),
    secSubmission.replace(secDocument, `${secDocument}\n${secDocument}`),
    secSubmission.replace(quote, `${quote} A different financial result.`),
    secSubmission.replace("<FILENAME>", "<FILENAME>wrong.htm\n<FILENAME>"),
  ]) assert.equal(secFilingPublicationRecord(secDocument, changed, secUrl, sourceBodyText), null, changed);
  assert.equal(secFilingPublicationRecord(secDocument.replace("EX-99.1", "10-Q"), secSubmission, secUrl, sourceBodyText), null);
  assert.equal(secFilingPublicationRecord(secDocument, secSubmission, `${secUrl}?accession=other`, sourceBodyText), null);
});

test("calendar facts retain exact verified authority availability and frozen receipt identity", async () => {
  for (const [url, body, metadataUrl, metadata, date, expected] of [
    [fedUrl, fedBody, FED_SPEECH_FEED, fedFeed, "2026-10-01", "2026-10-01T17:30:00.000Z"],
    [secUrl, secDocument, secMetadata, secSubmission, "2026-09-30", "2026-09-30T20:02:22.000Z"],
  ]) {
    const opened = await open(url, body, metadataUrl, metadata);
    const ledger = await verifyResearchSources([research(candidate(url, date))], envelope(), { reader: async () => opened });
    assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
    assert.equal(ledger.sources[0].publishedAt, expected);
    assert.equal(ledger.sources[0].timePrecision, "instant");
    assert.deepEqual(ledger.sources[0].officialPublication, boundMetadataPublication(opened));
    const snapshot = snapshotFromOpenedSource(url, opened), book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshot] };
    assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope: envelope() }));
    const tampered = structuredClone(ledger); tampered.sources[0].officialPublication.publishedAt = "2026-10-01T14:00:00.000Z";
    assert.throws(() => auditLedgerSourceSnapshots(tampered, book, { envelope: envelope() }), /对应发布记录重建/);
    const changedDate = await verifyResearchSources([research(candidate(url, "2026-09-29"))], envelope(), { reader: async () => opened });
    assert.equal(changedDate.sources.length, 0);
    const fake = { ...opened, publishedAtCandidates: ["2026-10-01T14:00:00Z"] };
    const fakeLedger = await verifyResearchSources([research(candidate(url, date))], envelope(), { reader: async () => fake });
    assert.equal(fakeLedger.sources.length, 0);
    assert.deepEqual(openedSourceFromSnapshot(snapshot).metadataReceipts[0].rawBody, opened.metadataReceipts[0].rawBody);
  }
});

test("a bound SEC calendar cannot move an after-close filing before the regular-session deadline", async () => {
  const metadata = secSubmission.replaceAll("20260930", "20261001");
  const opened = await open(secUrl, secDocument, secMetadata, metadata);
  const ledger = await verifyResearchSources([research(candidate(secUrl, "2026-10-01"))], envelope(), { reader: async () => opened });
  assert.equal(ledger.sources.length, 0);
  assert.match(ledger.rejected[0].reason, /交易窗口/);
});

test("raising revenue guidance does not lend its direction to a separately expected margin", () => {
  const supportingExcerpt = "The company is raising revenue guidance to 22 percent. It expects operating margin to be 20 percent.";
  const facts = "The company raised revenue guidance to 22 percent and expected operating margin to be 20 percent.";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  for (const changed of [facts.replace("raised revenue", "lowered revenue"), facts.replace("margin to be", "margin to rise"), facts.replace("20 percent", "20 basis points")]) {
    assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt }), /无法按单位和方向/);
  }
});

const hpeUrl = "https://www.hpe.com/us/en/newsroom/press-release/2026/09/hpe-to-outline-networking-priorities-for-long-term-value-creation.html";
const hpeTitle = "HPE to outline Networking priorities for long-term value creation";
const hpeArticle = { "@type": "NewsArticle", mainEntityOfPage: hpeUrl, headline: hpeTitle, datePublished: "2026-09-30T13:15:00Z", dateModified: "2026-10-01T17:32:57.487Z", publisher: { name: "Hewlett Packard Enterprise" } };
const hpeHtml = () => `<script type="application/ld+json">${JSON.stringify(hpeArticle)}</script><div class="newsroom-article"><div class="newsroom-a-header"><h1 class="newsroom-a-title">${hpeTitle}</h1><div class="newsroom-a-info"><span class="newsroom-a-data">September 30, 2026</span></div></div><p>${quote}</p></div>`;

test("HPE owned release calendars bind the initial day while retaining current article availability", async () => {
  const body = hpeHtml(), opened = await open(hpeUrl, body, null, null);
  assert.equal(opened.articleProvenance.publication.boundReleaseDate, "2026-09-30");
  const ledger = await verifyResearchSources([research(candidate(hpeUrl, "2026-09-30"))], envelope(), { reader: async () => opened });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.equal(ledger.sources[0].publishedAt, "2026-10-01T17:32:57.487Z");
  assert.equal(ledger.sources[0].initialPublishedAt, "2026-09-30T13:15:00.000Z");
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(hpeUrl, opened)] };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope: envelope() }));
  for (const changed of [body.replace("September 30, 2026", "September 29, 2026"), body.replace('</div></div><p>', '<span class="newsroom-a-data">September 30, 2026</span></div></div><p>'), body.replace('<h1 class="newsroom-a-title">', '<h1 class="newsroom-a-title">Another headline ')]) assert.equal(sourceArticleProvenance(changed, hpeUrl)?.publication?.boundReleaseDate, undefined);
  const wrongDate = await verifyResearchSources([research(candidate(hpeUrl, "2026-10-01"))], envelope(), { reader: async () => opened });
  assert.equal(wrongDate.sources.length, 0);
  const fake = { ...opened, articleProvenance: { ...opened.articleProvenance, publication: { ...opened.articleProvenance.publication, boundReleaseDate: "2026-10-01" } } };
  const fakeLedger = await verifyResearchSources([research(candidate(hpeUrl, "2026-10-01"))], envelope(), { reader: async () => fake });
  assert.equal(fakeLedger.sources.length, 0);
});
