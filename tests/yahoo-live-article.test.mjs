import assert from "node:assert/strict";
import test from "node:test";
import { yahooLiveArticleIdentity, yahooLiveArticleRecord } from "../scripts/yahoo-live-article.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { sourceBodyText, sourcePublishedAtCandidates } from "../scripts/daily-source-audit.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

const slug = "stock-market-today-thursday-oct-1-dow-sp-500-nasdaq-080602402";
const source = `https://ca.finance.yahoo.com/news/${slug}.html`;
const canonical = `https://finance.yahoo.com/markets/live/${slug}.html`;
const title = "Stock market today: Stocks recover as yields fall";
const published = "2026-10-01T20:07:35Z";
function fixture(mutate = () => {}, transform = html => html) {
  const article = { "@type": "NewsArticle", headline: title, datePublished: published, dateModified: published, mainEntityOfPage: { "@id": canonical }, publisher: { "@type": "Organization", name: "Yahoo! Finance Canada", url: "https://ca.finance.yahoo.com/" }, provider: { "@type": "Organization", name: "Yahoo Finance", url: "http://finance.yahoo.com/" }, author: { "@type": "Person", name: "Grace O'Donnell", url: "https://finance.yahoo.com/author/grace-odonnell/" } };
  const blog = { "@type": "LiveBlogPosting", headline: title, url: canonical, mainEntityOfPage: { "@id": canonical }, datePublished: published, coverageEndTime: "2026-10-01T22:04:56Z", articleBody: "Stocks recovered after an early decline.Yields fell but remained elevated.", liveBlogUpdate: [{ datePublished: "2026-10-01T20:07:34Z", headline: "Closing update" }] };
  mutate(article, blog);
  const html = `<html><head><link rel="canonical" href="${canonical}"><meta property="og:url" content="${source}"></head><body><nav><h1>Yahoo Finance Canada</h1></nav><main id="main-content-wrapper"><article class="article-wrap"><div class="cover-headline"><h1 class="cover-title">${title}</h1></div><div class="byline-attr"><a href="/author/grace-odonnell">Grace O'Donnell</a><time class="byline-attr-meta-time" datetime="${published}">Thursday, October 1</time></div><div class="body-wrap"><div class="body"><div class="bodyItems-wrapper"><p>Stocks recovered after an early decline.</p><div class="loader"></div><p>Yields fell but remained elevated.</p><div class="liveblog-posts"><ul class="liveblog-list"><li class="caas-liveblogpost"><time class="liveblogpost-relative-time">Thu, October 1, 2026 at 8:04 PM UTC</time><h2 class="headline">Closing update</h2><p>Earlier live coverage.</p></li></ul></div><script>{"unrelated":"hydration"}</script></div></div></div></article></main><script type="application/ld+json">${JSON.stringify(article)}</script><script type="application/ld+json">${JSON.stringify(blog)}</script><script type="application/ld+json">{"@type":"VideoObject","uploadDate":"2026-10-01T08:06:02Z"}</script></body></html>`;
  return transform(html);
}

test("the owned article accepts its exact regional alias and lead, excluding navigation, video and live coverage clocks", () => {
  const record = yahooLiveArticleRecord(fixture(), source);
  assert.equal(record.canonical, canonical); assert.equal(record.title, title);
  assert.equal(record.currentVersionAt, "2026-10-01T20:07:35.000Z");
  assert.equal(record.initialPublishedAt, record.currentVersionAt);
  assert.equal(record.origin.key, "publisher:finance.yahoo.com"); assert.equal(record.origin.identified, true);
  const primary = source.replace("ca.finance.yahoo.com", "finance.yahoo.com");
  const primaryHtml = fixture(article => { article.publisher.name = "Yahoo! Finance"; article.publisher.url = "https://finance.yahoo.com/"; }, html => html.replace(`content="${source}"`, `content="${canonical}"`));
  assert.equal(yahooLiveArticleRecord(primaryHtml, primary).currentVersionAt, record.currentVersionAt);
  assert.equal(yahooLiveArticleRecord(primaryHtml, canonical).currentVersionAt, record.currentVersionAt);
});

test("foreign, ambiguous or incomplete ownership cannot identify or date a Yahoo closing article", () => {
  for (const transform of [
    html => html.replace(`href="${canonical}"`, 'href="https://finance.yahoo.com/markets/live/other.html"'),
    html => html.replace(`content="${source}"`, `content="${canonical}"`),
    html => html.replace('id="main-content-wrapper"', 'id="unowned"'),
    html => html.replace('</main>', '<article class="article-wrap"></article></main>'),
    html => html.replace('class="cover-title"', 'class="unowned"'),
    html => html.replace('</h1></div>', '</h1><h1>Another headline</h1></div>'),
    html => html.replace('href="/author/grace-odonnell"', 'href="https://other.example/author/grace-odonnell"'),
    html => html.replace('Yields fell but remained elevated.</p>', 'Yields rose.</p>'),
    html => html.replace('<div class="liveblog-posts">', '<p>Unbound new lead paragraph.</p><div class="liveblog-posts">'),
    html => html.replace(`datetime="${published}"`, 'datetime="2026-10-01T08:06:02Z"'),
    html => html.replace('Thu, October 1, 2026 at 8:04 PM UTC', 'Thu, October 1, 2026 at 10:04 PM UTC'),
    html => html.replace('Thu, October 1, 2026 at 8:04 PM UTC', 'Fri, October 1, 2026 at 8:04 PM UTC'),
    html => html.replace('<h2 class="headline">Closing update</h2>', '<h2 class="headline">Other update</h2>'),
    html => html.replace('</head>', '<meta property="article:modified_time" content="2026-10-01T08:06:02Z"></head>'),
  ]) assert.equal(yahooLiveArticleRecord(fixture(undefined, transform), source), null);
  for (const url of [source + "?x=1", source + "#part", source.replace("ca.finance.yahoo.com", "unknown.example"), source.replace("https:", "http:"), source.replace(slug, "other-080602402")]) assert.equal(yahooLiveArticleIdentity(url), null);
});

test("body identity, publisher, author, dates and all live updates must agree with the current owned version", () => {
  for (const mutate of [
    article => article.headline = "Different closing story",
    article => article.mainEntityOfPage['@id'] = source,
    article => article.publisher.name = "Reuters",
    article => article.publisher.url = "https://other.example/",
    article => article.provider.name = "Reuters",
    article => article.author.name = "Different reporter",
    article => article.datePublished = "2026-10-02T00:00:00Z",
    article => article.dateModified = "2026-10-01T08:06:02Z",
    article => article.dateModified = "2026-10-01T20:07:35",
    article => article.datePublished = "2026-02-30T20:07:35Z",
    (article, blog) => blog.articleBody = "Stocks recovered after an early decline.",
    (article, blog) => blog.datePublished = "2026-10-01T08:00:00Z",
    (article, blog) => blog.liveBlogUpdate = [],
    (article, blog) => blog.liveBlogUpdate[0].datePublished = "2026-10-01T22:04:56Z",
    (article, blog) => blog.liveBlogUpdate[0].dateModified = "2026-10-02T00:00:00Z",
  ]) assert.equal(yahooLiveArticleRecord(fixture(mutate), source), null);
});

test("verification and publication replay rebuild the current clock, title and origin from owned original bytes", async () => {
  const rawBody = Buffer.from(fixture()), opened = { finalUrl: source, status: 200, contentType: "text/html", rawBody, text: sourceBodyText(rawBody), publishedAtCandidates: sourcePublishedAtCandidates(rawBody, "text/html", source), publishedDateCandidates: [], articleProvenance: sourceArticleProvenance(rawBody.toString(), source), metadataReceipts: [], fetchedAt: "2026-10-01T22:00:00Z" };
  const f = recapFixture(), envelope = JSON.parse(JSON.stringify(f.envelope).replaceAll("2026-08-21", "2026-10-01").replaceAll("2026-08-20", "2026-09-30"));
  const candidate = { ...f.ledger.sources[1], role: "facts", scope: "market", originalUrl: source, title: "A generated title cannot replace the original headline", facts: "Stocks recovered after an early decline. Yields fell but remained elevated.", supportingExcerpt: "Stocks recovered after an early decline.\n\nYields fell but remained elevated.", comparisons: [], causalConnection: false, publishedAt: "2026-10-01T08:06:02Z" };
  const output = { sources: [candidate], rejectedSources: [], alternatives: [] };
  const ledger = await verifyResearchSources([output], envelope, { reader: async () => opened });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  const accepted = ledger.sources[0];
  assert.equal(accepted.title, title); assert.equal(accepted.publishedAt, "2026-10-01T20:07:35.000Z");
  assert.equal(accepted.publisherTitleChecked, true); assert.equal(accepted.publisherDocumentVersion, "verified-yahoo-live-article-v1");
  const snapshot = snapshotFromOpenedSource(source, opened), book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshot] };
  assert.deepEqual(openedSourceFromSnapshot(snapshot).articleProvenance, opened.articleProvenance);
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope }));
  for (const mutate of [s => s.title = "Wrong title", s => s.publishedAt = candidate.publishedAt, s => delete s.publisherDocumentVersion, s => s.reportingOrigin.key = "agency:reuters"]) {
    const changed = structuredClone(ledger); mutate(changed.sources[0]);
    assert.throws(() => auditLedgerSourceSnapshots(changed, book, { envelope }));
  }
  for (const changed of [{ ...opened, rawBody: undefined }, { ...opened, text: opened.text + " invented text" }, { ...opened, articleProvenance: { ...opened.articleProvenance, publication: { ...opened.articleProvenance.publication, currentVersionAt: "2026-10-01T08:06:02Z" } } }]) {
    const rejected = await verifyResearchSources([output], envelope, { reader: async () => changed });
    assert.equal(rejected.sources.length, 0); assert.match(rejected.rejected[0].reason, /原始字节/);
  }
  const cached = structuredClone(accepted); delete cached.publisherDocumentVersion;
  let reads = 0;
  const rechecked = await verifyResearchSources([output], envelope, { reader: async () => { reads++; return opened; }, verifiedCache: new Map([[cached.candidateHash, cached]]) });
  assert.equal(reads, 1); assert.equal(rechecked.sources[0].publisherDocumentVersion, accepted.publisherDocumentVersion);
});
