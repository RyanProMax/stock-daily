import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { SNOWFLAKE_PRESS_RELEASE_VERSION, snowflakePressReleaseIdentity, snowflakePressReleaseRecord } from "../scripts/snowflake-press-release.mjs";
import { readExternalSource, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { auditLedgerSourceSnapshots, openedSourceFromSnapshot, snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { completeRecapPlan, recapTargets } from "../scripts/complete-recap.mjs";
import { validateRecapAttribution, recapAttributionCandidates } from "../scripts/recap-attribution.mjs";

const url = "https://www.snowflake.com/en/news/press-releases/lseg-snowflake-expand-collaboration/";
const title = "LSEG and Snowflake expand collaboration to connect trusted financial data with cloud-native AI workflows";
const dateline = "LONDON – August 21, 2026 – Snowflake (NYSE: SNOW), the AI Data Cloud company, and LSEG announced an expanded five-year enterprise-wide collaboration at Snowflake World Tour London, today.";
const description = dateline.slice(0, dateline.indexOf(" at Snowflake")) + " ...";
const escape = s => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
function html() {
  return `<head><title>LSEG and Snowflake Expand Collaboration for Governed AI</title><link rel="canonical" href="${url}"><meta property="og:url" content="${snowflakePressReleaseIdentity(url).nativeUrl}"><meta property="og:title" content="${title}"><meta name="twitter:title" content="${title}"><meta name="apple-mobile-web-app-title" content="Snowflake"><meta name="description" content="${escape(description)}"><meta property="og:description" content="${escape(description)}"><meta name="twitter:description" content="${escape(description)}"></head><body><nav>Suggested announcement: September 30, 2026; Updated 2026-09-30T14:00:00Z.</nav><div class="aem-page page"><div class="snowflake-hero-system hero--press"><div class="snowflake-hero-system-headline"><h1 class="snowflake-title-v2-line">${title}</h1></div></div><div class="snowflake-flexible-column-container press-body"><div class="snowflake-text main-pr-body" data-analytics-section="text"><span><p>Enterprise-wide collaboration deepens joint activities while execution remains subject to the announced terms.</p><p>${dateline}</p><p>The companies aim to build a more open data ecosystem. Planned customer-facing services and migration programmes remain forward-looking; this announcement supplies no stock-price causation.</p><p>Forward-looking statements involve risks, and actual results may differ from those expected.</p></span></div></div></div><footer>Copyright Snowflake. Another publication was updated September 30, 2026.</footer></body>`;
}
const opened = (body = html()) => readExternalSource(url, { includeRaw: true, lookupPublicationMetadata: false, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async () => ({ status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(body) }) });
function snowflakeFixture() {
  const fixture = recapFixture();
  const applications = fixture.envelope.aiChainPerformance.find(layer => layer.layer === "applications");
  Object.assign(applications.constituents[0], { symbol: "SNOW", name: "Snowflake", nameEn: "Snowflake" });
  fixture.plan = completeRecapPlan(fixture.envelope);
  return fixture;
}
function candidate(f) {
  const anomaly = f.plan.anomalies.find(a => a.observation.constituents?.some(c => c.symbol === "SNOW"));
  return { anomalyId: anomaly.id, role: "facts", originalUrl: url, sourceLabel: "Snowflake", title: "Generated SEO title must not replace the original heading", publishedAt: "2026-08-21", kind: "official", supportingExcerpt: dateline, facts: dateline, scope: "company", targets: ["SNOW"], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] };
}

test("the owned issuer dateline, heading, descriptions and canonical identity establish only a release day", async () => {
  const record = snowflakePressReleaseRecord(html(), url);
  assert.equal(record.version, SNOWFLAKE_PRESS_RELEASE_VERSION); assert.equal(record.publicationDate, "2026-08-21"); assert.equal(record.issuer.ticker, "SNOW");
  assert.deepEqual(record.publishedAtCandidates, []); assert.deepEqual(record.publishedDateCandidates, ["2026-08-21"]);
  assert.match(record.text, /Forward-looking statements involve risks/); assert.doesNotMatch(record.text, /Suggested|Copyright|September 30|14:00:00/);
  const result = await opened(); assert.equal(result.text, record.text); assert.deepEqual(result.publishedAtCandidates, []); assert.deepEqual(result.publishedDateCandidates, ["2026-08-21"]);
  assert.equal(result.articleProvenance.origin.key, "issuer:snowflake.com"); assert.equal(result.articleProvenance.origin.identified, true); assert.equal(result.articleProvenance.publication.status, "verified_date");
  assert.equal(result.articleProvenance.publication.publicationDate, "2026-08-21"); assert.equal(result.articleProvenance.publication.currentVersionAt, undefined);
  const snapshot = snapshotFromOpenedSource(url, result); assert.deepEqual(openedSourceFromSnapshot(snapshot), { ...result, fetchedAt: snapshot.fetchedAt });
});

test("unknown native ownership, competing body/title, conflicting metadata and revisions cannot borrow the dateline", async () => {
  const mutations = [s => s.replace('content="Snowflake"', 'content="Other"'), s => s.replace('rel="canonical"', 'rel="other"'), s => s.replace(snowflakePressReleaseIdentity(url).nativeUrl, snowflakePressReleaseIdentity(url).nativeUrl + "-other"), s => s.replace('property="og:title" content="', 'property="og:title" content="Other '), s => s.replace('name="twitter:title" content="', 'name="twitter:title" content="Other '), s => s.replace('hero--press', 'unowned-hero'), s => s.replace('press-body', 'recommendations'), s => s.replace('main-pr-body', 'unowned-body'), s => s.replace('data-analytics-section="text"', 'data-analytics-section="other"'), s => s.replace('NYSE: SNOW', 'NYSE: OTHER'), s => s.replace('<p>' + dateline + '</p>', ''), s => s.replace('<p>' + dateline + '</p>', '<blockquote><p>' + dateline + '</p></blockquote>'), s => s.replace('name="description" content="LONDON', 'name="description" content="OTHER'), s => s.replace('<p>' + dateline + '</p>', '<p>' + dateline + '</p><p>' + dateline + '</p>'), s => s.replace('</head>', '<meta name="description" content="Duplicate"></head>'), s => s.replace('</head>', '<meta property="article:published_time" content="2026-08-21T10:00:00Z"></head>'), s => s.replace('</head>', '<meta property="article:modified_time" content="2026-08-22T10:00:00Z"></head>'), s => s.replace('</span>', '<p>Updated: August 22, 2026</p></span>'), s => s.replace('</span>', '<h2>Correction: August 22, 2026</h2></span>'), s => s.replace('</span>', '<div><p>Revised: August 22, 2026</p></div></span>'), s => s.replace('August 21', 'February 30'), s => s.replaceAll('August 21, 2026', 'February 30, 2026')];
  for (const mutate of mutations) {
    const body = mutate(html()); assert.equal(snowflakePressReleaseRecord(body, url), null);
    assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(body), "text/html", url), []); assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(body), "text/html", url), []);
    assert.equal(sourceArticleProvenance(body, url).publication.status, "unverified_update"); await assert.rejects(opened(body), /无法绑定/);
  }
  for (const source of [url.replace("https:", "http:"), url.replace("www.snowflake.com", "www.snowflake.com.evil.example"), url + "?other=1", url + "#other", url.replace("press-releases", "blog"), url.slice(0, -1)]) assert.equal(snowflakePressReleaseIdentity(source), null);
});

test("verification derives the native heading and company scope without inventing intraday availability", async () => {
  const f = snowflakeFixture(), source = candidate(f), ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: () => opened(), checkSessionIntegrity: true });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected)); const verified = ledger.sources[0];
  assert.equal(verified.title, title); assert.equal(verified.issuerDocumentVersion, SNOWFLAKE_PRESS_RELEASE_VERSION); assert.equal(verified.issuerTitleChecked, true); assert.equal(verified.publishedAt, "2026-08-21"); assert.equal(verified.timePrecision, "date"); assert.match(verified.timingLimitation, /unverified/); assert.equal(verified.initialPublishedAt, undefined); assert.deepEqual(verified.companySubjects, ["SNOW"]); assert.deepEqual(verified.targets, ["SNOW"]); assert.equal(verified.scope, "company");
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, await opened())] }; auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope });
  for (const mutate of [s => delete s.issuerDocumentVersion, s => s.issuerDocumentVersion = "older", s => s.title = "Unverified title", s => s.issuerTitleChecked = false, s => s.publishedAt = "2026-08-21T10:00:00Z", s => s.timePrecision = "instant", s => delete s.timingLimitation, s => s.initialPublishedAt = "2026-08-21T10:00:00Z"]) { const copy = structuredClone(ledger); mutate(copy.sources[0]); assert.throws(() => auditLedgerSourceSnapshots(copy, book, { envelope: f.envelope })); }
});

test("copied dates from another release, guessed London hours and unavailable raw originals remain rejected", async () => {
  const f = snowflakeFixture(), source = candidate(f);
  for (const publishedAt of ["2026-08-20", "2026-08-21T00:00:00Z", "2026-08-21T09:00:00+01:00"]) { const ledger = await verifyResearchSources([{ sources: [{ ...source, publishedAt }], alternatives: [] }], f.envelope, { reader: () => opened() }); assert.equal(ledger.sources.length, 0); }
  const noRaw = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: async () => { const value = await opened(); delete value.rawBody; return value; } }); assert.equal(noRaw.sources.length, 0); assert.match(noRaw.rejected[0].reason, /原生正文记录/);
});

test("snapshot replay refuses changed bytes, reintroduced navigation and external timing receipts", async () => {
  const snapshot = snapshotFromOpenedSource(url, await opened());
  for (const mutate of [s => s.publishedAtCandidates = ["2026-08-21T09:00:00Z"], s => s.publishedDateCandidates = ["2026-08-20"], s => s.textHash = "old full-page text", s => s.metadataReceipts = [{ ...s, metadataReceipts: undefined }], s => { const raw = Buffer.from(html().replace('NYSE: SNOW', 'NYSE: OTHER')); s.bodyBase64 = raw.toString("base64"); s.bodyHash = createHash("sha256").update(raw).digest("hex"); }]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => openedSourceFromSnapshot(copy)); }
});

test("unknown issuer-document and precision caches reopen the same raw original", async () => {
  const f = snowflakeFixture(), source = candidate(f), outputs = [{ sources: [source], alternatives: [] }], first = await verifyResearchSources(outputs, f.envelope, { reader: () => opened() });
  for (const mutation of [s => delete s.issuerDocumentVersion, s => s.issuerDocumentVersion = "older", s => s.issuerTitleChecked = false, s => s.timePrecision = "instant", s => delete s.timingLimitation]) {
    const cached = structuredClone(first.sources[0]); mutation(cached); let reads = 0;
    const ledger = await verifyResearchSources(outputs, f.envelope, { verifiedCache: new Map([[stableHash(source), cached]]), reader: async (_, options) => { reads++; assert.equal(options.includeRaw, true); return opened(); } }); assert.equal(reads, 1); assert.equal(ledger.sources[0].issuerDocumentVersion, SNOWFLAKE_PRESS_RELEASE_VERSION); assert.equal(ledger.sources[0].title, title);
  }
});

test("a native date-only company fact and later wrap cannot complete a pre-close timing chain", async () => {
  const f = snowflakeFixture(), source = candidate(f), ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: () => opened() }), root = ledger.sources[0], target = recapTargets(f.envelope).find(t => t.constituents?.some(c => c.symbol === "SNOW"));
  const reaction = { ...f.ledger.sources.find(s => s.role === "causal"), id: "later-snow-wrap", targets: ["SNOW"], scope: "company", companySubjectChecked: true, companySubjects: ["SNOW"], supportingExcerpt: "Snowflake rose because its expanded five-year enterprise-wide collaboration supports future customer demand.", publishedAt: "2026-08-21T20:30:00Z" };
  const combined = { sources: [root, reaction] }, candidates = recapAttributionCandidates(f.envelope, [target], combined);
  assert.equal(candidates[0].constituents.find(c => c.symbol === "SNOW").reportedEligible, false);
  const entry = structuredClone(f.attribution.entries.find(e => e.target === target.symbol)); entry.chains = [{ rootEvidenceId: root.id, reactionEvidenceId: reaction.id, timingEvidenceId: null, mechanismEvidenceIds: [], subjectTargets: ["SNOW"], basis: "reported", eventAnchors: ["Snowflake", "five-year enterprise-wide collaboration"], expectedDirection: "positive", transmission: "The new collaboration could support future demand, but the later wrap does not prove release availability before the close.", limitations: "The original has only a release date; no pre-close evidence was supplied." }];
  entry.basis = "unresolved"; entry.counterEvidenceIds = []; assert.throws(() => validateRecapAttribution({ ...f.attribution, entries: [entry] }, f.envelope, [target], combined), /时间先后不成立/);
});
