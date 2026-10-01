import assert from "node:assert/strict";
import test from "node:test";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { validateCompleteRecap } from "../scripts/complete-recap.mjs";

const url = "https://www.wral.com/news/ap/original-wrap/", title = "Stocks fall as bond yields rise";
const initial = "2026-08-21T03:03:10.000Z", updated = "2026-08-21T21:08:12.000Z";
const quote = "S&P 500 rose because improved demand supported earnings expectations, while borrowing costs and lower volume limited the advance.";
const article = { "@type": "NewsArticle", mainEntityOfPage: { "@id": url }, headline: title, datePublished: initial, dateModified: updated, author: { "@type": "Person", name: "STAN CHOE — AP Business Writer" }, publisher: { name: "WRAL" } };
function html(data = article, { heading = title, body = quote, extra = "" } = {}) {
  return `<html><head><meta property="article:published_time" content="${data.datePublished}"><meta property="article:modified_time" content="${data.dateModified}"><script type="application/ld+json">${JSON.stringify(data)}</script>${extra}</head><body><article><h1>${heading}</h1><p>${body}</p></article></body></html>`;
}
function original(body = html()) {
  const rawBody = Buffer.from(body);
  return { finalUrl: url, status: 200, contentType: "text/html", text: sourceBodyText(rawBody), rawBody, publishedAtCandidates: sourcePublishedAtCandidates(rawBody, "text/html", url), publishedDateCandidates: sourcePublishedDateCandidates(rawBody, "text/html", url), articleProvenance: sourceArticleProvenance(body, url), metadataReceipts: [] };
}

test("the bound news version retains both the original creation clock and the current availability clock", () => {
  const opened = original();
  assert.deepEqual(opened.publishedAtCandidates, [initial]);
  assert.deepEqual(opened.articleProvenance.publication, { status: "verified", initialPublishedAt: initial, currentVersionAt: updated, timeBasis: "article_update" });
  assert.equal(opened.articleProvenance.origin.key, "agency:associated_press");
  const snapshot = snapshotFromOpenedSource(url, opened);
  assert.deepEqual(openedSourceFromSnapshot(snapshot).articleProvenance, opened.articleProvenance);
});

test("unrelated titles and URLs, ambiguous articles, invalid or reversed clocks and conflicting update metadata cannot date a current version", () => {
  for (const data of [
    { ...article, headline: "Recommended unrelated story" },
    { ...article, mainEntityOfPage: { "@id": url + "?story=other" } },
    { ...article, dateModified: "2026-02-30T21:08:12Z" },
    { ...article, dateModified: "2026-08-21T21:08:12" },
    { ...article, dateModified: "2026-08-20T21:08:12Z" },
  ]) assert.equal(sourceArticleProvenance(html(data), url).publication.status, "unverified_update");
  assert.equal(sourceArticleProvenance(html(article, { extra: `<script type="application/ld+json">${JSON.stringify(article)}</script>` }), url).publication.status, "unverified_update");
  assert.equal(sourceArticleProvenance(html().replace(`content="${updated}"`, 'content="2026-08-21T20:00:00Z"'), url).publication.status, "unverified_update");
  assert.equal(sourceArticleProvenance(`<h1>${title}</h1><meta property="article:modified_time" content="${updated}"><p>${quote}</p>`, url).publication.status, "unverified_update");
});

test("wire attribution is derived from the owned article, while photo credits and quoted or recommended wires do not identify its origin", () => {
  const own = { ...article, author: { name: "Local WRAL Reporter" } };
  const page = html(own, { body: `${quote}</p><figure><figcaption>AP Photo/Seth Wenig</figcaption></figure><aside><p>Jones writes for the Associated Press.</p></aside><blockquote><p>NEW YORK (AP) — A separately quoted wire story.</p></blockquote><p>` });
  assert.equal(sourceArticleProvenance(page, url).origin.key, "publisher:wral.com");
  assert.equal(sourceArticleProvenance(page, url).origin.basis, "bound_publisher_and_author");
  const la = "https://www.latimes.com/business/original";
  const laArticle = { ...article, mainEntityOfPage: la, publisher: { name: "Los Angeles Times" }, author: [{ name: "Damian J. Troise" }, { name: "Alex Veiga" }] };
  const originalWire = html(laArticle, { body: `${quote}</p><p>Troise and Veiga write for the Associated Press.` });
  assert.equal(sourceArticleProvenance(originalWire, la).origin.key, "agency:associated_press");
  const bareAuthors = { ...article, author: { name: "STAN CHOE" } };
  assert.equal(sourceArticleProvenance(html(bareAuthors, { body: `NEW YORK (AP) — ${quote}` }), url).origin.key, "agency:associated_press");
  const reuters = "https://www.reuters.com/markets/original";
  assert.equal(sourceArticleProvenance(html(), reuters).origin.key, "agency:reuters");
  assert.equal(sourceArticleProvenance(html(), "https://mirror.example/story"), null);
});

test("verification uses the current version, rejects out-of-window revisions and reaudits clock and origin from frozen original bytes", async () => {
  const f = recapFixture(), candidate = { ...f.ledger.sources[1], originalUrl: url, title, facts: "The index rose because demand improved, while borrowing costs limited the advance.", supportingExcerpt: quote, comparisons: [], publishedAt: initial };
  const output = { sources: [candidate], rejectedSources: [], alternatives: [] };
  const opened = original();
  const ledger = await verifyResearchSources([output], f.envelope, { reader: async () => opened });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  const source = ledger.sources[0];
  assert.equal(source.publishedAt, updated);
  assert.equal(source.initialPublishedAt, initial);
  assert.equal(source.timeBasis, "article_update");
  const snapshot = snapshotFromOpenedSource(url, opened), book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshot] };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope }));
  for (const mutate of [s => s.publishedAt = initial, s => delete s.initialPublishedAt, s => s.reportingOrigin.key = "agency:reuters"]) {
    const changed = structuredClone(ledger); mutate(changed.sources[0]);
    assert.throws(() => auditLedgerSourceSnapshots(changed, book, { envelope: f.envelope }));
  }
  const later = original(html({ ...article, dateModified: "2026-08-23T21:08:12Z" }));
  const rejected = await verifyResearchSources([output], f.envelope, { reader: async () => later });
  assert.equal(rejected.sources.length, 0);
  assert.match(rejected.rejected[0].reason, /交易窗口/);
});

test("different passages and publisher domains from the same wire remain one origin for confidence", () => {
  const f = recapFixture();
  const first = f.ledger.sources[1];
  Object.assign(first, { url, provenanceChecked: true, reportingOrigin: { key: "agency:associated_press", identified: true } });
  const second = { ...first, id: "0-second-wire", url: "https://www.latimes.com/business/another-wrap", supportingExcerpt: first.supportingExcerpt + " Its other paragraph mentions a distinct possible offset.", reportingOrigin: { key: "agency:associated_press", identified: true } };
  f.ledger.sources.push(second); f.raw.entries[0].evidenceIds.push(second.id); f.raw.entries[0].confidence = "high";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /独立报道交叉佐证/);
  second.url = "https://www.reuters.com/markets/independent-wrap"; second.reportingOrigin.key = "agency:reuters";
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social).entries[0].confidence, "high");
  second.reportingOrigin.identified = false;
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /独立报道交叉佐证/);
  second.reportingOrigin = { identified: true };
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /独立报道交叉佐证/);
});
