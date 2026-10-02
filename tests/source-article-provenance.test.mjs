import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot, auditLedgerSourceSnapshots, createSnapshotSourceReader, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { MarketWorkflow } from "../scripts/daily-workflow.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";

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

const micronUrl = "https://investors.micron.com/news/press-release/2026/Micron-Technology-Inc--Reports-Record-Fiscal-Fourth-Quarter-and-Full-Year-2026-Results/default.aspx";
const micronTitle = "Micron Technology, Inc. Reports Record Fiscal Fourth-Quarter and Full-Year 2026 Results";
const micronArticle = { "@type": "NewsArticle", mainEntityOfPage: { "@id": micronUrl }, headline: micronTitle, datePublished: "2026-09-30T15:01:00Z", dateModified: "2026-09-30T15:01:00Z", publisher: { "@type": "Corporation", name: "Micron", legalName: "Micron Technology, Inc.", url: "https://investors.micron.com" } };
function micronHtml(data = micronArticle) {
  return `<html><head><meta property="og:url" content="${micronUrl}"><script type="application/ld+json">${JSON.stringify(data)}</script></head><body><h1>Press release</h1><main><div class="evergreen-news-details"><div class="evergreen-news-details-item"><h3 class="evergreen-news-title">${micronTitle}</h3><span class="evergreen-news-date-text">September 30, 2026</span><p>Micron Technology, Inc. (Nasdaq: MU) announced its results.</p></div></div></main></body></html>`;
}

test("the reviewed Micron release binds its owned H3, calendar and corporate legal identity", () => {
  const result = sourceArticleProvenance(micronHtml(), micronUrl);
  assert.equal(result.origin.key, "issuer:micron.com");
  assert.equal(result.origin.identified, true);
  assert.deepEqual(result.publication, { status: "verified", initialPublishedAt: "2026-09-30T15:01:00.000Z", currentVersionAt: "2026-09-30T15:01:00.000Z", timeBasis: "first_publication", boundReleaseDate: "2026-09-30" });
});

test("an unrelated heading, calendar, issuer, link or duplicate module cannot lend the Micron release a clock", () => {
  const base = micronHtml();
  const mutations = [
    base.replace(`<h3 class="evergreen-news-title">${micronTitle}`, '<h3 class="evergreen-news-title">Another release'),
    base.replace("September 30, 2026", "October 1, 2026"),
    base.replace('"legalName":"Micron Technology, Inc."', '"legalName":"Nvidia Corporation"'),
    base.replace('"name":"Micron"', '"name":"Q4 Inc"'),
    base.replace('"url":"https://investors.micron.com"', '"url":"https://another.example"'),
    base.replace(`content="${micronUrl}"`, 'content="https://investors.micron.com/other"'),
    base.replace('<div class="evergreen-news-details">', '<div class="other-news-details">'),
    base.replace("</main>", '<div class="evergreen-news-details"></div></main>'),
    base.replace('"dateModified":"2026-09-30T15:01:00Z"', '"dateModified":"2026-09-30T15:01:00"'),
  ];
  for (const body of mutations) assert.equal(sourceArticleProvenance(body, micronUrl).publication.status, "unverified_update");
  const elsewhere = micronUrl.replace("investors.micron.com", "www.hpe.com");
  assert.notEqual(sourceArticleProvenance(base.replaceAll(micronUrl, elsewhere), elsewhere)?.publication?.status, "verified");
});

test("a matching Micron calendar claim upgrades only to its rederived native clock and remains auditable", async () => {
  const envelope = structuredClone(recapFixture().envelope);
  envelope.marketAsOf = "2026-10-01";
  Object.assign(envelope.session, { asOf: "2026-10-01", windowStart: "2026-09-30T20:00:00.000Z", windowEnd: "2026-10-01T20:00:00.000Z", wrapDeadline: "2026-10-01T22:00:00.000Z" });
  const rawBody = Buffer.from(micronHtml());
  const opened = { finalUrl: micronUrl, status: 200, contentType: "text/html", rawBody, text: sourceBodyText(rawBody), publishedAtCandidates: sourcePublishedAtCandidates(rawBody, "text/html", micronUrl), publishedDateCandidates: [], articleProvenance: sourceArticleProvenance(rawBody.toString(), micronUrl) };
  const source = { originalUrl: micronUrl, title: micronTitle, publishedAt: "2026-09-30", kind: "official", scope: "event_only", targets: [], role: "facts", anomalyId: "micron-calendar", hypothesisIds: ["micron-calendar-event"], causalConnection: false, facts: "Micron Technology, Inc. announced its results.", supportingExcerpt: "Micron Technology, Inc. (Nasdaq: MU) announced its results.", comparisons: [] };
  const research = value => ({ sources: [value], rejectedSources: [], alternatives: [] });
  const ledger = await verifyResearchSources([research(source)], envelope, { reader: async () => opened });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.equal(ledger.sources[0].publishedAt, "2026-09-30T15:01:00.000Z");
  assert.equal(ledger.sources[0].timePrecision, "instant");
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(micronUrl, opened)] };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book, { envelope }));
  const wrongDate = await verifyResearchSources([research({ ...source, publishedAt: "2026-10-01" })], envelope, { reader: async () => opened });
  assert.equal(wrongDate.sources.length, 0);
  assert.match(wrongDate.rejected[0].reason, /可见发布日期/);
  for (const changed of [
    { ...opened, rawBody: undefined },
    { ...opened, articleProvenance: { ...opened.articleProvenance, publication: { ...opened.articleProvenance.publication, boundReleaseDate: "2026-10-01" } } },
  ]) {
    const rejected = await verifyResearchSources([research(source)], envelope, { reader: async () => changed });
    assert.equal(rejected.sources.length, 0);
    assert.match(rejected.rejected[0].reason, /原始正文重建/);
  }
});

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

const ownedUrl = "https://finance.yahoo.com/markets/stocks/article/owned-networking-stock-call.html";
const ownedArticle = { ...article, mainEntityOfPage: { "@id": ownedUrl }, author: { name: "Grace O'Donnell" }, publisher: { name: "Yahoo! Finance" } };
function ownedHtml(data = ownedArticle, changes = {}) {
  return html(data, { extra: `<link rel="canonical" href="${ownedUrl}"><meta property="og:url" content="${ownedUrl}">`, ...changes }).replace("<body>", "<body><nav><h1>Yahoo Finance</h1></nav>");
}

test("a unique owned story binds its clock and author despite unrelated external navigation headings", () => {
  for (const navigation of ["Yahoo Finance", "Unrelated navigation title", title]) {
    const page = ownedHtml().replace("<h1>Yahoo Finance</h1>", `<h1>${navigation}</h1>`);
    const result = sourceArticleProvenance(page, ownedUrl);
    assert.deepEqual(result.publication, { status: "verified", initialPublishedAt: initial, currentVersionAt: updated, timeBasis: "article_update" });
    assert.deepEqual(result.origin, { key: "publisher:finance.yahoo.com", identified: true, basis: "bound_publisher_and_author" });
  }
});

test("external headings cannot lend ownership to a wrong, absent, nested or ambiguous article heading", () => {
  const page = ownedHtml().replace("<h1>Yahoo Finance</h1>", `<h1>${title}</h1>`);
  for (const changed of [
    ownedHtml(ownedArticle, { heading: "Different story" }),
    page.replace(`<article><h1>${title}</h1>`, "<article>"),
    page.replace(`<article><h1>${title}</h1>`, "<article><h1></h1>"),
    page.replace(`<article><h1>${title}</h1>`, `<article><aside><h1>${title}</h1></aside>`),
    page.replace("</article>", `<h1>${title}</h1></article>`),
    page.replace("</article>", "<h1>Different story</h1></article>"),
    page.replace("</article>", "<h1></h1></article>"),
    page.replace("</body>", "<article><p>Recommended story.</p></article></body>"),
    page.replace("</body>", `<article><h1>${title}</h1></article></body>`),
    ownedHtml({ ...ownedArticle, headline: "Different story" }),
  ]) assert.notEqual(sourceArticleProvenance(changed, ownedUrl).publication?.status, "verified");
});

test("owned-body fallback needs one exact current identity, one author and consistent current-version metadata", () => {
  const page = ownedHtml();
  for (const changed of [
    page.replace(`<link rel="canonical" href="${ownedUrl}">`, ""),
    page.replace(`<meta property="og:url" content="${ownedUrl}">`, ""),
    page.replace(`rel="canonical" href="${ownedUrl}"`, `rel="canonical" href="${ownedUrl}?other=1"`),
    page.replace(`property="og:url" content="${ownedUrl}"`, `property="og:url" content="${ownedUrl}?other=1"`),
    page.replace("</head>", `<link rel="canonical" href="${ownedUrl}"></head>`),
    page.replace("</head>", `<meta property="og:url" content="${ownedUrl}"></head>`),
    ownedHtml({ ...ownedArticle, mainEntityOfPage: { "@id": ownedUrl + "?other=1" } }),
    ownedHtml({ ...ownedArticle, url: ownedUrl + "?other=1" }),
    ownedHtml({ ...ownedArticle, author: undefined }),
    ownedHtml({ ...ownedArticle, author: { name: " " } }),
    page.replace("</head>", `<script type="application/ld+json">${JSON.stringify(ownedArticle)}</script></head>`),
    page.replace("</head>", `<script type="application/ld+json">${JSON.stringify({ ...ownedArticle, headline: "Different story" })}</script></head>`),
    page.replace(`property="article:published_time" content="${initial}"`, 'property="article:published_time" content="2026-08-21T03:02:10Z"'),
    page.replace(`property="article:modified_time" content="${updated}"`, 'property="article:modified_time" content="2026-08-21T21:09:12Z"'),
    ownedHtml({ ...ownedArticle, dateModified: "2026-08-21T21:08:12" }),
    ownedHtml({ ...ownedArticle, dateModified: "2026-08-20T21:08:12Z" }),
  ]) assert.notEqual(sourceArticleProvenance(changed, ownedUrl).publication?.status, "verified");
  // Removing navigation cannot bypass an explicit source-identity conflict.
  for (const changed of [
    page.replace(`rel="canonical" href="${ownedUrl}"`, `rel="canonical" href="${ownedUrl}?other=1"`),
    page.replace(`property="og:url" content="${ownedUrl}"`, `property="og:url" content="${ownedUrl}?other=1"`),
    ownedHtml({ ...ownedArticle, url: ownedUrl + "?other=1" }),
  ]) assert.notEqual(sourceArticleProvenance(changed.replace("<nav><h1>Yahoo Finance</h1></nav>", ""), ownedUrl).publication?.status, "verified");
});

test("all declared publisher page identities agree through arrays with or without external navigation", () => {
  const elsewhere = ownedUrl + "?other=1";
  const conflicts = [
    [{ "@id": elsewhere }],
    [ownedUrl, elsewhere],
    [{ url: ownedUrl }, { "@id": elsewhere }],
    [[{ url: ownedUrl }], [[{ "@id": elsewhere }]]],
    [{ url: [ownedUrl, elsewhere] }],
    [ownedUrl, 42],
  ];
  const consistent = [
    [ownedUrl],
    [{ url: ownedUrl }, { "@id": ownedUrl }],
    [[{ url: ownedUrl }], [[{ "@id": ownedUrl }]]],
  ];
  for (const navigation of [true, false]) {
    const page = entity => {
      const raw = ownedHtml({ ...ownedArticle, url: ownedUrl, mainEntityOfPage: entity });
      return navigation ? raw : raw.replace("<nav><h1>Yahoo Finance</h1></nav>", "");
    };
    for (const entity of conflicts) assert.notEqual(sourceArticleProvenance(page(entity), ownedUrl).publication?.status, "verified");
    for (const entity of consistent) assert.equal(sourceArticleProvenance(page(entity), ownedUrl).publication?.status, "verified");
  }
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

test("resumed mixed ledgers reaudited against frozen originals retain accepted proof times while reconsidering refusals", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-mixed-proof-resume-"));
  try {
    const f = recapFixture(), refused = "https://www.wral.com/news/ap/refused-wrap/", reads = [];
    const candidate = { ...f.ledger.sources[1], originalUrl: url, title, facts: "The index rose because demand improved, while borrowing costs limited the advance.", supportingExcerpt: quote, comparisons: [], publishedAt: initial };
    const outputs = [{ sources: [candidate, { ...candidate, originalUrl: refused }], rejectedSources: [], alternatives: [] }];
    const create = async () => {
      const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true, workRoot: root });
      await workflow.initialize();
      workflow.recapSnapshotReader = await createSnapshotSourceReader(resolve(workflow.runDir, "artifacts/recap-source-snapshots.json"), async source => {
        reads.push(source);
        if (source === refused) throw new Error("外部证据返回 HTTP 403");
        assert.equal(source, url);
        return original();
      });
      workflow.recapSourceReader = workflow.recapSnapshotReader.reader;
      return workflow;
    };
    const firstWorkflow = await create(), first = await firstWorkflow.verifyEvidence(outputs);
    assert.equal(first.sources.length, 1);
    assert.equal(first.rejected.length, 1);
    const resumed = await create(), second = await resumed.verifyEvidence(outputs);
    assert.deepEqual(second.sources, first.sources);
    assert.equal(second.rejected.length, 1);
    assert.equal(reads.filter(source => source === url).length, 1);
    assert.equal(reads.filter(source => source === refused).length, 2);
    assert.equal(second.sources[0].publishedAt, updated);
    assert.equal(second.sources[0].reportingOrigin.key, "agency:associated_press");
  } finally { await rm(root, { recursive: true, force: true }); }
});

const hpeUrl = "https://www.hpe.com/us/en/newsroom/press-release/2026/08/networking-priorities.html";
const hpeArticle = { ...article, mainEntityOfPage: { "@id": hpeUrl.replace("/us/en/", "/content/hpe/country/us/en/") }, publisher: { name: "Hewlett Packard Enterprise" }, author: { name: "Global Communication Team" } };
const hpeHtml = (data = hpeArticle, changes = {}) => html(data, { extra: `<link rel="canonical" href="${hpeUrl}"><meta property="og:url" content="${hpeUrl}">`, ...changes });

test("a native issuer CMS alias needs exact public identities, its own publisher, headline and two separate clocks", () => {
  const raw = hpeHtml(), provenance = sourceArticleProvenance(raw, hpeUrl);
  assert.deepEqual(provenance.publication, { status: "verified", initialPublishedAt: initial, currentVersionAt: updated, timeBasis: "article_update" });
  assert.deepEqual(provenance.origin, { key: "issuer:hpe.com", identified: true, basis: "bound_issuer_article" });
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(raw), "text/html", hpeUrl), [initial]);
  for (const changed of [
    raw.replace(`rel="canonical" href="${hpeUrl}"`, `rel="canonical" href="${hpeUrl}?other=1"`),
    raw.replace(`property="og:url" content="${hpeUrl}"`, `property="og:url" content="${hpeUrl}other"`),
    raw.replace('</head>', `<link rel="canonical" href="${hpeUrl}"></head>`),
    hpeHtml({ ...hpeArticle, mainEntityOfPage: { "@id": hpeArticle.mainEntityOfPage["@id"] + "other" } }),
    hpeHtml({ ...hpeArticle, publisher: { name: "Unrelated Company" } }),
    hpeHtml(hpeArticle, { heading: "Different recommended article" }),
    hpeHtml({ ...hpeArticle, dateModified: "2026-02-30T21:08:12Z" }),
  ]) assert.notEqual(sourceArticleProvenance(changed, hpeUrl).publication?.status, "verified");
  assert.equal(sourceArticleProvenance(raw, hpeUrl.replace("www.hpe.com", "www.hpe.com.evil.example")), null);
  assert.equal(sourceArticleProvenance(raw, hpeUrl.replace("www.hpe.com", "www.dell.com")).publication?.status === "verified", false);
});

test("issuer clocks require a bound original article and cannot come from generic government or footer modifications", () => {
  const direct = { ...hpeArticle, mainEntityOfPage: hpeUrl }; delete direct.dateModified;
  const firstHtml = hpeHtml(direct).replace(/<meta property="article:modified_time"[^>]+>/u, "");
  assert.equal(sourceArticleProvenance(firstHtml, hpeUrl).publication.timeBasis, "first_publication");
  const government = "https://www.bea.gov/news/release";
  assert.equal(sourceArticleProvenance(html({ ...article, mainEntityOfPage: government }), government), null);
  assert.equal(sourceArticleProvenance(firstHtml.replace('</head>', '<meta property="article:modified_time" content="2026-08-22T21:00:00Z"></head>'), hpeUrl).publication.status, "unverified_update");
});
