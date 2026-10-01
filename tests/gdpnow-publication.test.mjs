import assert from "node:assert/strict";
import test from "node:test";
import { GDP_NOW_COMMENTARIES as url, GDP_NOW_FEED, GDP_NOW_EVIDENCE_VERSION, gdpNowCommentaryRecord, gdpNowPublishedAtCandidates, gdpNowForecastDefinition, assertGdpNowCopy } from "../scripts/gdpnow-publication.mjs";
import { readExternalSource, sourcePublishedAtCandidates, sourcePublishedDateCandidates, sourceBodyText } from "../scripts/daily-source-audit.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { verifiedExternalSourceType, verifiedExternalSourceLabel, verifiedFirstPartyIssuerIdentity } from "../scripts/source-registry.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { html, feed, item, current, old } from "./gdpnow-fixture.mjs";
const clock = "2026-08-21T15:14:00.000Z";
const bytes = value => Buffer.from(value);
const parser = (article = html, rss = feed, source = url) => gdpNowPublishedAtCandidates(bytes(article), bytes(rss), source);
function opened(article = html, rss = feed) {
  return { finalUrl: url, status: 200, contentType: "text/html", rawBody: bytes(article), text: sourceBodyText(bytes(article)), publishedAtCandidates: parser(article, rss), publishedDateCandidates: sourcePublishedDateCandidates(bytes(article), "text/html", url), metadataReceipts: [{ finalUrl: GDP_NOW_FEED, status: 200, contentType: "text/xml", rawBody: bytes(rss) }] };
}
function candidate(f) {
  const anomaly = f.plan.anomalies[0];
  return { anomalyId: anomaly.id, role: "facts", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], originalUrl: url, title: "GDPNow model estimate update", facts: current, supportingExcerpt: current, kind: "official", scope: "event_only", publishedAt: clock, causalConnection: false, comparisons: [] };
}

test("a unique newest GDPNow entry binds quarter, model value and exact RSS paragraph with literal EST", () => {
  const record = gdpNowCommentaryRecord(bytes(html), url);
  assert.equal(record.quarter, "2026:Q3"); assert.equal(record.estimatePercent, 3.7);
  assert.deepEqual(parser(), [clock]);
  assert.deepEqual(parser(html, feed.replace(" EST", " EDT")), ["2026-08-21T14:14:00.000Z"]);
  assert.deepEqual(parser(html, feed.replace(" EST", " -0500")), [clock]);
  const historicDuplicates = html.replace("</div>", "<h2>August 14, 2026</h2><p>A native older typo.</p><h2>August 14, 2026</h2><p>Another old update.</p></div>");
  assert.deepEqual(parser(historicDuplicates), [clock]);
  for (const invalid of [html.replace("August 21, 2026</h2>", "February 30, 2026</h2>"), html.replace("August 17, 2026</h2>", "August 21, 2026</h2>"), html.replace("August 17, 2026</h2>", "August 24, 2026</h2>"), html.replace('content="Current and Past', 'content="Unrelated'), html.replace(`<h1>`, `<h1>Duplicate</h1><h1>`), html.replace(current, old)]) assert.deepEqual(parser(invalid), []);
  for (const source of [url + "?v=1", url + "#old", url.replace("https:", "http:")]) assert.deepEqual(parser(html, feed, source), []);
});

test("matching a shared feed URL or value alone cannot borrow another update's clock", () => {
  for (const invalid of [feed.replace("Third-Quarter", "Second-Quarter"), feed.replace("3.7 Percent", "5.0 Percent"), feed.replace(current, old), feed.replace("Fri, 21", "Thu, 21"), feed.replace("21 Aug", "17 Aug"), feed.replace(" EST", ""), feed.replace(" EST", " +1401"), feed.replace(" EST", " +1500"), feed.replace("subscribeGDPNow", "other"), feed.replace("<title>subscribeGDPNow</title>", "<title>subscribeGDPNow</title><title>other</title>"), feed.replace("bbc33028", "invalidx"), feed.replace(item, item + item), feed.replace("</item>", "<pubDate>Fri, 21 Aug 2026 10:15:00 EST</pubDate></item>"), feed.replace("</channel>", "</channel><channel/>")]) assert.deepEqual(parser(html, invalid), []);
});

test("rolling-page clocks cannot override scoped dates and missing RSS leaves intraday time unknown", async () => {
  const article = html.replace("<head>", '<head><meta property="article:published_time" content="2026-08-21T08:00:00Z">');
  assert.deepEqual(sourcePublishedAtCandidates(bytes(article), "text/html", url), []);
  assert.deepEqual(sourcePublishedDateCandidates(bytes(article), "text/html", url), ["2026-08-21"]);
  const calls = [], options = { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async source => { calls.push(source); return source === url ? { status: 200, contentType: "text/html", body: bytes(article) } : { status: 200, contentType: "text/xml", body: bytes(feed) }; } };
  const result = await readExternalSource(url, options);
  assert.deepEqual(calls, [url, GDP_NOW_FEED]); assert.deepEqual(result.publishedAtCandidates, [clock]); assert.equal(result.metadataReceipts.length, 1);
  for (const bad of [{ status: 403 }, { status: 200, contentType: "text/html", body: bytes(feed) }, { status: 200, contentType: "text/xml", body: bytes(feed.replace(current, old)) }]) {
    const partial = await readExternalSource(url, { ...options, requester: async source => source === url ? { status: 200, contentType: "text/html", body: bytes(article) } : bad });
    assert.deepEqual(partial.publishedAtCandidates, []); assert.deepEqual(partial.publishedDateCandidates, ["2026-08-21"]); assert.deepEqual(partial.metadataReceipts, []);
  }
});

test("frozen raw feed receipts reproduce publication and reject forged times or changed event paragraphs", () => {
  const snapshot = snapshotFromOpenedSource(url, opened());
  assert.deepEqual(openedSourceFromSnapshot(snapshot).publishedAtCandidates, [clock]);
  for (const mutate of [s => s.publishedAtCandidates = ["2026-08-21T14:14:00.000Z"], s => s.metadataReceipts[0].finalUrl += "?wrong=1", s => s.metadataReceipts[0].contentType = "text/html", s => s.metadataReceipts[0].bodyBase64 = bytes(feed.replace(current, old)).toString("base64")]) { const changed = structuredClone(snapshot); mutate(changed); assert.throws(() => openedSourceFromSnapshot(changed)); }
});

test("research admission and publication replay scope every fragment to the newest model entry", async () => {
  const f = recapFixture(), source = candidate(f), reader = async () => opened();
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.equal(ledger.sources[0].forecastChecked, true); assert.equal(ledger.sources[0].forecastDefinition.version, GDP_NOW_EVIDENCE_VERSION);
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, opened())] };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope }));
  for (const change of [{ supportingExcerpt: old, facts: old }, { supportingExcerpt: current + "\n" + old }, { facts: "Real GDP growth reached 3.7 percent, down from 5.0 percent." }, { kind: "background" }, { role: "causal", causalConnection: true }]) {
    const rejected = await verifyResearchSources([{ sources: [{ ...source, ...change }], alternatives: [] }], f.envelope, { reader });
    assert.equal(rejected.sources.length, 0, JSON.stringify(change));
  }
  for (const mutate of [s => delete s.forecastDefinition, s => s.forecastDefinition.quarter = "2026:Q2", s => s.forecastDefinition.nature = "realized", s => s.forecastChecked = false, s => { s.supportingExcerpt = old; s.facts = old; s.excerptHash = stableHash(old.toLowerCase().replace(/[^\p{L}\p{N}.+%\-]+/gu, "")); }]) {
    const changed = structuredClone(ledger); mutate(changed.sources[0]); assert.throws(() => auditLedgerSourceSnapshots(changed, book, { envelope: f.envelope }));
  }
  const cached = new Map([[stableHash(source), { ...ledger.sources[0], forecastChecked: undefined }]]); let calls = 0;
  await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { verifiedCache: cached, reader: async () => { calls++; return opened(); } });
  assert.equal(calls, 1);
});

test("GDPNow citations preserve model nature in bilingual explanations, alternatives and KOL copy", () => {
  const definition = gdpNowForecastDefinition(gdpNowCommentaryRecord(bytes(html), url));
  assert.doesNotThrow(() => assertGdpNowCopy("GDPNow 模型估计下修", [{ forecastDefinition: definition }]));
  assert.doesNotThrow(() => assertGdpNowCopy("The GDPNow model estimate declined", [{ forecastDefinition: definition }]));
  for (const copy of ["GDP reached 3.7%", "GDPNow reached 3.7%", "模型估计下修"]) assert.throws(() => assertGdpNowCopy(copy, [{ forecastDefinition: definition }]));
  const f = recapFixture(); f.ledger.sources[0].forecastDefinition = definition;
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /GDPNow/);
  f.raw.entries[0].why += "GDPNow 模型估计下修。"; f.raw.entries[0].whyEn += " The GDPNow model estimate was revised down.";
  f.raw.entries[0].magnitudeEvidenceIds.push(f.ledger.sources[0].id);
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /GDPNow/);
  f.raw.entries[0].magnitude += "GDPNow 模型估计下修。"; f.raw.entries[0].magnitudeEn += " The GDPNow model estimate declined.";
  f.raw.entries[1].alternatives[0].evidenceIds.push(f.ledger.sources[0].id);
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /GDPNow/);
  f.raw.entries[1].alternatives[0].text += "GDPNow 模型估计下修。"; f.raw.entries[1].alternatives[0].textEn += " The GDPNow model estimate declined.";
  f.social.leads.push({ id: "verified-post", authorHandle: "Expert", url: "https://x.com/Expert/status/123", publishedAt: clock });
  f.raw.entries[1].opinions.push({ postId: "verified-post", evidenceIds: [f.ledger.sources[0].id], text: "该经济数据变化可能影响后续需求和投资预期。", textEn: "The change in growth expectations could affect later demand and investment." });
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { attribution: f.attribution }), /GDPNow/);
});

test("the reviewed regional Reserve Bank is a primary authority without being a company issuer", () => {
  assert.equal(verifiedExternalSourceType(url), "first_party"); assert.equal(verifiedExternalSourceLabel(url), "Federal Reserve Bank of Atlanta"); assert.equal(verifiedFirstPartyIssuerIdentity(url), null);
  assert.equal(verifiedExternalSourceType("https://atlantafed.org.fake.example/"), "expert");
});
