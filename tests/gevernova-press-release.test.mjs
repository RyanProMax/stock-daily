import assert from "node:assert/strict";
import test from "node:test";
import { gevernovaPressReleaseIdentity, gevernovaPressReleaseRecord, GEVERNOVA_PRESS_RELEASE_VERSION } from "../scripts/gevernova-press-release.mjs";
import { readExternalSource, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { completeRecapPlan } from "../scripts/complete-recap.mjs";

const url = "https://www.gevernova.com/news/press-releases/ge-vernova-declares-fourth-quarter-2026-dividend";
const title = "GE Vernova declares fourth quarter 2026 dividend";
const dateline = "CAMBRIDGE, Mass. (August 21, 2026) – GE Vernova (NYSE: GEV) today announced that its Board of Directors has declared a $0.50 per share quarterly dividend. The quarterly dividend will be payable on November 24, 2026, to shareholders of record as of October 27, 2026.";
const html = () => `<head><title>${title} | GE Vernova News</title><link rel="canonical" href="${url}"><meta name="description" content="${dateline}"><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "NewsArticle", headline: title, datePublished: "2026-08-21T07:30:06-0400", dateModified: "2026-08-21T07:41:13-0400" }] })}</script></head><body><nav>Unrelated article updated today.</nav><div id="block-ge-vernova-news-content"><main><section class="hero-article-section"><h1 class="hero-article-title">${title}</h1></section><div class="article-text-content"><div class="body-2 article-para"><span></span><p>${dateline}</p><p>Future dividend declarations will be made at the discretion of the Board of Directors and depend on earnings and cash requirements.</p><p>Forward-Looking Statements: Actual results may differ from expectations.</p></div></div></main></div><footer>Recommended article has another date.</footer></body>`;
const opened = (body = html()) => readExternalSource(url, { includeRaw: true, lookupPublicationMetadata: false, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async () => ({ status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(body) }) });

test("GE's owned dateline, identity, heading and same-day version metadata establish a day only", async () => {
  const record = gevernovaPressReleaseRecord(html(), url);
  assert.equal(record.version, GEVERNOVA_PRESS_RELEASE_VERSION); assert.equal(record.issuer.ticker, "GEV"); assert.equal(record.publicationDate, "2026-08-21");
  assert.deepEqual(record.publishedAtCandidates, []); assert.match(record.text, /discretion/); assert.match(record.text, /Actual results may differ/); assert.doesNotMatch(record.text, /Unrelated|Recommended/);
  const original = await opened(); assert.equal(original.text, record.text); assert.deepEqual(original.publishedDateCandidates, ["2026-08-21"]); assert.equal(original.articleProvenance.origin.key, "issuer:gevernova.com"); assert.equal(original.articleProvenance.publication.currentVersionAt, undefined);
  const snapshot = snapshotFromOpenedSource(url, original); assert.deepEqual(openedSourceFromSnapshot(snapshot), { ...original, fetchedAt: snapshot.fetchedAt });
});

test("unowned, ambiguous or revised originals cannot borrow GE's date", async () => {
  const mutations = [s => s.replace('rel="canonical"', 'rel="other"'), s => s.replace('id="block-ge-vernova-news-content"', 'id="other"'), s => s.replace('hero-article-section', 'other'), s => s.replace('article-text-content', 'other'), s => s.replace('NYSE: GEV', 'NYSE: OTHER'), s => s.replace(`<p>${dateline}</p>`, `<blockquote><p>${dateline}</p></blockquote>`), s => s.replace(`<p>${dateline}</p>`, `<p>${dateline}</p><p>${dateline}</p>`), s => s.replace('2026-08-21T07:41:13', '2026-08-22T07:41:13'), s => s.replace('2026-08-21T07:41:13', '2026-08-21T07:29:00'), s => s.replace('2026-08-21T07:41:13-0400', '2026-08-21T07:41:13+0400'), s => s.replace('"headline":"GE Vernova', '"headline":"Other'), s => s.replace('"dateModified":', '"unknown":'), s => s.replace('</head>', '<meta property="article:modified_time" content="2026-08-22T10:00:00Z"></head>'), s => s.replace('</div></div></main>', '<p>Correction: August 22, 2026</p></div></div></main>'), s => s.replaceAll('August 21, 2026', 'February 30, 2026')];
  for (const mutate of mutations) {
    const body = mutate(html()); assert.equal(gevernovaPressReleaseRecord(body, url), null);
    assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(body), "text/html", url), []); assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(body), "text/html", url), []);
    assert.equal(sourceArticleProvenance(body, url).publication.status, "unverified_update"); await assert.rejects(opened(body), /无法绑定/);
  }
  for (const source of [url + "?other=1", url + "#other", url.replace("https:", "http:"), url.replace("www.gevernova.com", "www.gevernova.com.evil.example")]) assert.equal(gevernovaPressReleaseIdentity(source), null);
});

test("verified date-only GE facts derive the company and heading but cannot acquire a clock", async () => {
  const f = recapFixture();
  Object.assign(f.envelope.aiChainPerformance.find(layer => layer.layer === "data_center").constituents[0], { symbol: "GEV", name: "GE Vernova", nameEn: "GE Vernova" });
  f.plan = completeRecapPlan(f.envelope);
  const anomaly = f.plan.anomalies.find(a => a.observation.constituents?.some(c => c.symbol === "GEV"));
  assert.ok(anomaly);
  const source = { anomalyId: anomaly.id, role: "facts", originalUrl: url, sourceLabel: "GE Vernova", title: "Generated heading should be replaced", publishedAt: "2026-08-21", kind: "official", supportingExcerpt: dateline, facts: dateline, scope: "company", targets: ["GEV"], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] };
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: () => opened() });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected)); const verified = ledger.sources[0];
  assert.equal(verified.title, title); assert.deepEqual(verified.companySubjects, ["GEV"]); assert.equal(verified.issuerDocumentVersion, GEVERNOVA_PRESS_RELEASE_VERSION); assert.equal(verified.timePrecision, "date"); assert.ok(verified.timingLimitation); assert.equal(verified.initialPublishedAt, undefined);
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, await opened())] }; auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope });
  for (const publishedAt of ["2026-08-20", "2026-08-21T07:30:06-04:00", "2026-11-24"]) { const refused = await verifyResearchSources([{ sources: [{ ...source, publishedAt }], alternatives: [] }], f.envelope, { reader: () => opened() }); assert.equal(refused.sources.length, 0); }
  const forged = structuredClone(ledger); forged.sources[0].publishedAt = "2026-08-21T07:30:06-04:00"; assert.throws(() => auditLedgerSourceSnapshots(forged, book, { envelope: f.envelope }));
});
