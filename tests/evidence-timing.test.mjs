import assert from "node:assert/strict";
import test from "node:test";
import { isCalendarDate, officialReleaseDateInWindow } from "../scripts/evidence-timing.mjs";
import { sourcePublishedDateCandidates, sourcePublishedAtCandidates } from "../scripts/daily-source-audit.mjs";
import { validateResearchOutput, verifyResearchSources, stableHash } from "../scripts/daily-workflow-core.mjs";
import { verifiedExternalSourceType, verifiedExternalSourceLabel, publishableExternalSourceDomains } from "../scripts/source-registry.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";
import { validateReport, buildReportContent } from "../scripts/daily-publish.mjs";

const source = "https://www.conference-board.org/topics/tags.cfm?parent=consumer-confidence";
const excerpt = "The share of consumers anticipating higher interest rates over the next twelve months jumped by 5.2 percentage points to 68.4%.";
function worker() {
  const f = recapFixture(), anomaly = f.plan.anomalies[0];
  const raw = { contractVersion: "stock-daily-evidence-worker-v1", role: "facts", market: "US", anomalyId: anomaly.id, outcome: "found", queries: [anomaly.factQueries[0], "US August 21 2026 Conference Board consumer confidence official release"], sources: [{ url: source, sourceLabel: "The Conference Board", title: "US consumer confidence official release", publishedAt: "2026-08-21", kind: "official", supportingExcerpt: excerpt, facts: excerpt, scope: "event_only", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] }], alternatives: [] };
  const output = validateResearchOutput(raw, "facts", anomaly, f.envelope);
  return { ...f, anomaly, raw, output };
}
const reader = async url => ({ finalUrl: url, status: 200, contentType: "text/html", text: excerpt, publishedAtCandidates: [], publishedDateCandidates: ["2026-08-21"] });

test("date-only metadata retains calendar precision and rejects unrelated or modified dates", () => {
  const html = '<h2>US Consumer Confidence Fell in August</h2><h3>Latest Press Release</h3><p>Updated: Friday, August 21, 2026</p>';
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(html), "text/html", source), ["2026-08-21"]);
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(html), "text/html", source), []);
  for (const value of [html.replace("Latest Press Release", "Older Research"), html.replace("August 21", "February 30")]) assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(value), "text/html", source), []);
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(html), "text/html", source.replace("parent=consumer-confidence", "parent=another-series")), []);
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from('<meta property="article:modified_time" content="2026-08-21"><p>Updated: August 21, 2026</p>'), "text/html", source), []);
  const article = { "@type": "Report", "url": "https://issuer.example/release", datePublished: "2026-08-21", dateModified: "2026-08-22" };
  const metadata = value => Buffer.from(`<script type="application/ld+json">${JSON.stringify(value)}</script>`);
  assert.deepEqual(sourcePublishedDateCandidates(metadata(article), "text/html", article.url), ["2026-08-21"]);
  assert.deepEqual(sourcePublishedDateCandidates(metadata({ ...article, url: "https://issuer.example/related" }), "text/html", article.url), []);
  assert.equal(isCalendarDate("2026-02-30"), false);
});

test("only official first-party facts can use an independently matched date-only release", async () => {
  const f = worker();
  assert.equal(f.output.sources.length, 1);
  const ledger = await verifyResearchSources([f.output], f.envelope, { reader });
  assert.equal(ledger.sources.length, 1);
  const verified = ledger.sources[0];
  assert.equal(verified.publishedAt, "2026-08-21");
  assert.equal(verified.timePrecision, "date");
  assert.match(verified.timingLimitation, /intraday.*unverified/);
  assert.equal(verified.causalConnection, false);
  for (const mutate of [
    value => value.publishedAt = "2026-08-22",
    value => value.publishedAt = "2026-08-21T14:00:00Z",
    value => value.originalUrl = "https://www.reuters.com/market/story",
    value => value.kind = "event",
    value => { value.role = "causal"; value.causalConnection = true; value.supportingExcerpt = "SPX fell because rising interest rate expectations dampened demand."; },
  ]) {
    const changed = structuredClone(f.output); mutate(changed.sources[0]);
    assert.equal((await verifyResearchSources([changed], f.envelope, { reader })).sources.length, 0);
  }
});

test("date-only facts cannot claim future releases or reuse an older unchecked timing cache", async () => {
  const f = worker();
  assert.equal(officialReleaseDateInWindow("2026-08-22", f.envelope), false);
  assert.equal(officialReleaseDateInWindow("2026-08-10", f.envelope), false);
  let calls = 0;
  const candidate = f.output.sources[0], hash = stableHash(candidate);
  const cached = { ...candidate, candidateHash: hash, comparisonNotesChecked: true, earningsContextChecked: true };
  const ledger = await verifyResearchSources([f.output], f.envelope, { verifiedCache: new Map([[hash, cached]]), reader: async url => { calls++; return reader(url); } });
  assert.equal(calls, 1);
  assert.equal(ledger.sources[0].timingChecked, true);
});

test("reviewed issuer identities expand primary sources without promoting KOL websites", () => {
  for (const domain of ["amd.com", "micron.com", "dell.com", "coreweave.com", "vertiv.com", "conference-board.org"]) {
    assert.equal(verifiedExternalSourceType(`https://www.${domain}/news/release`), "first_party");
    assert.ok(publishableExternalSourceDomains().includes(domain));
  }
  assert.equal(verifiedExternalSourceType("https://semianalysis.com/report"), "expert");
  assert.equal(verifiedExternalSourceType("https://trendforce.com/news"), "expert");
  assert.equal(verifiedExternalSourceLabel("https://www.nvidia.com/news"), "NVIDIA");
});

test("public report validation preserves date precision and rejects date-only media causality", () => {
  const input = fixtureInput(), report = fixtureReport(input);
  const official = report.drivers[0].evidence.find(item => item.kind === "official");
  official.publishedAt = "2026-08-21";
  const validated = validateReport(report, input);
  assert.equal(validated.drivers[0].evidence.find(item => item.kind === "official").publishedAt, "2026-08-21");
  const content = JSON.parse(buildReportContent(input, validated));
  assert.equal(content.drivers[0].evidence.find(item => item.kind === "official").publishedAt, "2026-08-21");
  official.publishedAt = "2026-08-22";
  assert.throws(() => validateReport(report, input), /发布日期/);
  official.publishedAt = "2026-08-21";
  const media = report.drivers.find(item => item.market === "US").evidence.find(item => item.kind === "event");
  media.publishedAt = "2026-08-21";
  assert.throws(() => validateReport(report, input), /证据字段/);
});
