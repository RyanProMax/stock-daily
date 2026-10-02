import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { YAHOO_LIVE_ARTICLE_VERSION, YAHOO_LIVE_SECTIONS_VERSION, yahooLiveArticleIdentity, yahooLiveArticleRecord, yahooLiveArticleSections } from "../scripts/yahoo-live-article.mjs";
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

function sectionsFixture(mutate = () => {}, transform = html => html) {
  return fixture((article, blog) => {
    Object.assign(blog.liveBlogUpdate[0], {
      articleBody: "Energy stocks (XLE) rose after the reported supply news.Here’s the quoted counterview:Supply could recover.",
      author: { "@type": "Person", name: "Grace O'Donnell", url: "https://finance.yahoo.com/author/grace-odonnell/" },
      publisher: { "@type": "Organization", name: "Yahoo Finance", url: "http://finance.yahoo.com/" },
    });
    mutate(article, blog);
  }, html => transform(html.replace('<p>Earlier live coverage.</p>', '<div class="timestamp-byline"><div class="byline-meta"><div class="byline">Grace O\'Donnell</div></div></div><div class="content-wrapper"><div class="content-body"><div class="content-block"><div class="body"><p>Energy stocks (XLE) rose after the reported supply news.</p><blockquote>Here\'s the quoted counterview:</blockquote><figure><figcaption>Supply could recover.</figcaption></figure><div class="loader">Unowned widget quote</div></div></div></div></div>')));
}

test("research receives complete visible live sections with the parent version, retaining quotes and captions", () => {
  const sections = yahooLiveArticleSections(sectionsFixture(), source);
  assert.equal(sections.version, YAHOO_LIVE_SECTIONS_VERSION);
  assert.deepEqual(sections.gaps, []);
  assert.equal(sections.sections.length, 1);
  const section = sections.sections[0];
  assert.equal(section.author, "Grace O'Donnell");
  assert.equal(section.sourceVersionAt, "2026-10-01T20:07:35.000Z");
  assert.equal(section.publishedAt, undefined);
  assert.equal(section.originalText, "Energy stocks (XLE) rose after the reported supply news.\nHere's the quoted counterview:\nSupply could recover.");
  assert.equal(section.originalText.includes("Unowned widget quote"), false);
  const nativeYahooProfile = yahooLiveArticleSections(sectionsFixture((article, blog) => blog.liveBlogUpdate[0].author.url = "https://www.yahoo.com/author/grace-odonnell/"), source);
  assert.equal(nativeYahooProfile.sections[0].author, section.author);
  assert.equal(yahooLiveArticleSections(sectionsFixture(undefined, html => html.replace('id="main-content-wrapper"', 'id="foreign"')), source), null);
});

test("unbound live bodies and authors remain explicit gaps while the original closing lead stays available", () => {
  for (const html of [
    sectionsFixture((article, blog) => blog.liveBlogUpdate[0].articleBody += "Invisible embedded tweet content."),
    sectionsFixture(undefined, html => html.replace("(XLE) rose", "(XLE) fell")),
    sectionsFixture(undefined, html => html.replace('class="byline">Grace', 'class="byline">Another Grace')),
    sectionsFixture((article, blog) => blog.liveBlogUpdate[0].author.url = "https://other.example/author/grace-odonnell/"),
    sectionsFixture(undefined, html => html.replace('<div class="body"><p>Energy', '<div class="body"><p>Duplicate body</p></div><div class="body"><p>Energy')),
    sectionsFixture(undefined, html => html.replace('<div class="content-wrapper">', '<aside><div class="content-wrapper">').replace('</li>', '</aside></li>')),
    sectionsFixture(undefined, html => html.replace('<div class="timestamp-byline">', '<aside><div class="timestamp-byline">').replace('</div></div></div><div class="content-wrapper">', '</div></div></div></aside><div class="content-wrapper">')),
  ]) {
    assert(yahooLiveArticleRecord(html, source));
    const result = yahooLiveArticleSections(html, source);
    assert.equal(result.sections.length, 0);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].title, "Closing update");
  }
});

test("overlong complete live sections are not silently truncated into research evidence", () => {
  const long = "A".repeat(4_001);
  const html = sectionsFixture((article, blog) => blog.liveBlogUpdate[0].articleBody = long, html => html.replace(/<div class="body"><p>Energy[\s\S]*?<\/div><\/div><\/div><\/div>/u, `<div class="body"><p>${long}</p></div></div></div></div>`));
  const result = yahooLiveArticleSections(html, source);
  assert.equal(result.sections.length, 0);
  assert.match(result.gaps[0].reason, /长度/u);
});

function sectionDom(html, mutate) {
  const document = new JSDOM(html).window.document;
  const post = document.querySelector("li.caas-liveblogpost");
  const blog = [...document.querySelectorAll('script[type="application/ld+json"]')].map(node => JSON.parse(node.textContent)).find(item => item["@type"] === "LiveBlogPosting");
  mutate(document, post, blog.liveBlogUpdate[0]);
  return document.documentElement.outerHTML;
}

test("section headings, clocks, bylines and bodies cannot borrow a foreign article or side container", () => {
  for (const [selector, tag] of [
    ["h2.headline", "aside"],
    ["time.liveblogpost-relative-time", "nav"],
    [".timestamp-byline", "article"],
    [".content-wrapper", "article"],
    [".liveblog-posts", "article"],
  ]) {
    const html = sectionDom(sectionsFixture(), (document, post) => {
      const target = document.querySelector(selector), wrapper = document.createElement(tag);
      target.replaceWith(wrapper); wrapper.append(target);
    });
    assert(yahooLiveArticleRecord(html, source));
    const result = yahooLiveArticleSections(html, source);
    assert.equal(result.sections.length, 0);
    assert.equal(result.gaps.length, 1);
  }
});

test("hidden embedded text cannot manufacture a complete visible section or repair an unavailable post", () => {
  for (const attributes of [{ hidden: "" }, { style: "display: none" }, { style: "visibility: hidden" }]) {
    const html = sectionDom(sectionsFixture(), (document, post, update) => {
      const body = post.querySelector(".content-block > .body"), hidden = document.createElement("p");
      for (const [name, value] of Object.entries(attributes)) hidden.setAttribute(name, value);
      hidden.textContent = update.articleBody; body.replaceChildren(hidden);
    });
    assert(yahooLiveArticleRecord(html, source));
    const result = yahooLiveArticleSections(html, source);
    assert.equal(result.sections.length, 0);
    assert.equal(result.gaps.length, 1);
    assert.match(result.gaps[0].reason, /可见全文/u);
  }
  for (const [selector, attribute, value] of [
    ["h2.headline", "hidden", ""],
    [".byline", "style", "visibility: hidden"],
    [".content-block > .body", "style", "display: none"],
    [".content-wrapper", "hidden", ""],
    ["li.caas-liveblogpost", "style", "display: none"],
    [".liveblog-posts", "style", "visibility: hidden"],
  ]) {
    const html = sectionDom(sectionsFixture(), document => document.querySelector(selector).setAttribute(attribute, value));
    assert(yahooLiveArticleRecord(html, source));
    const result = yahooLiveArticleSections(html, source);
    assert.equal(result.sections.length, 0);
    assert.equal(result.gaps.length, 1);
  }
});

test("unowned and hidden body descendants are removed without discarding visible quotations or captions", () => {
  const html = sectionDom(sectionsFixture(), (document, post) => {
    const body = post.querySelector(".content-block > .body");
    for (const markup of ['<span hidden>Unavailable embedded post</span>', '<div style="display:none"><p>Hidden descendant</p></div>', '<article><p>Another article</p></article>', '<aside>Sidebar text</aside>']) {
      body.insertAdjacentHTML("beforeend", markup);
    }
  });
  const result = yahooLiveArticleSections(html, source);
  assert.equal(result.sections.length, 1);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.sections[0].originalText, "Energy stocks (XLE) rose after the reported supply news.\nHere's the quoted counterview:\nSupply could recover.");
});

test("the owned article accepts its exact regional alias and lead, excluding navigation, video and live coverage clocks", () => {
  const record = yahooLiveArticleRecord(fixture(), source);
  assert.equal(record.canonical, canonical); assert.equal(record.title, title);
  assert.equal(record.currentVersionAt, "2026-10-01T20:07:35.000Z");
  assert.equal(record.initialPublishedAt, record.currentVersionAt);
  assert.equal(record.origin.key, "publisher:finance.yahoo.com"); assert.equal(record.origin.identified, true);
  assert.equal(yahooLiveArticleRecord(fixture(), source + "?guccounter=1").currentVersionAt, record.currentVersionAt);
  assert.equal(record.ownedBody, "Stocks recovered after an early decline.\nYields fell but remained elevated.");
  for (const suffix of ["?guccounter=2", "?guccounter=1&guccounter=1", "?guccounter=1&headline=fake", "#guccounter=1"]) assert.equal(yahooLiveArticleIdentity(source + suffix), null);
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
  assert.equal(accepted.publisherTitleChecked, true); assert.equal(accepted.publisherDocumentVersion, YAHOO_LIVE_ARTICLE_VERSION);
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
