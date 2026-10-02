import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { priorRecapDiscoveryLeads } from "../scripts/recap-research-discovery.mjs";
import { stableHash } from "../scripts/daily-workflow-core.mjs";
import { snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";

const url = "https://finance.yahoo.com/markets/live/stock-market-today-thursday-oct-1-dow-sp-500-nasdaq-080602402.html";
const title = "Stock market today: Stocks recover as yields fall";
const published = "2026-10-01T20:07:35Z";
const envelope = { market: "US", marketAsOf: "2026-10-01", session: { windowStart: "2026-10-01T13:30:00Z", windowEnd: "2026-10-01T20:00:00Z" }, markets: [{ symbol: "SPX", asOf: "2026-10-01", change: "+0.50%", value: "6000.00" }] };

function snapshot(closing = "At the closing bell, the S&P 500 rose 0.50%.") {
  const body = ["Stocks recovered after an early decline.", "Yields fell but remained elevated.", closing];
  const article = { "@type": "NewsArticle", headline: title, datePublished: published, dateModified: published, mainEntityOfPage: { "@id": url }, publisher: { "@type": "Organization", name: "Yahoo! Finance", url: "https://finance.yahoo.com/" }, provider: { "@type": "Organization", name: "Yahoo Finance", url: "http://finance.yahoo.com/" }, author: { "@type": "Person", name: "Grace O'Donnell", url: "https://finance.yahoo.com/author/grace-odonnell/" } };
  const blog = { "@type": "LiveBlogPosting", headline: title, url, mainEntityOfPage: { "@id": url }, datePublished: published, coverageEndTime: "2026-10-01T22:04:56Z", articleBody: body.join(""), liveBlogUpdate: [{ datePublished: "2026-10-01T20:07:34Z", headline: "Closing update" }] };
  const rawBody = Buffer.from(`<html><head><link rel="canonical" href="${url}"><meta property="og:url" content="${url}"></head><body><main id="main-content-wrapper"><article class="article-wrap"><div class="cover-headline"><h1 class="cover-title">${title}</h1></div><div class="byline-attr"><a href="/author/grace-odonnell">Grace O'Donnell</a><time class="byline-attr-meta-time" datetime="${published}">Thursday, October 1</time></div><div class="body-wrap"><div class="body"><div class="bodyItems-wrapper">${body.map(p => `<p>${p}</p>`).join("")}<div class="liveblog-posts"><ul class="liveblog-list"><li class="caas-liveblogpost"><time class="liveblogpost-relative-time">Thu, October 1, 2026 at 8:04 PM UTC</time><h2 class="headline">Closing update</h2><p>Earlier coverage.</p></li></ul></div></div></div></div></article></main><script type="application/ld+json">${JSON.stringify(article)}</script><script type="application/ld+json">${JSON.stringify(blog)}</script></body></html>`);
  return snapshotFromOpenedSource(url, { rawBody, finalUrl: url, status: 200, contentType: "text/html", text: sourceBodyText(rawBody), publishedAtCandidates: sourcePublishedAtCandidates(rawBody, "text/html", url), publishedDateCandidates: sourcePublishedDateCandidates(rawBody, "text/html", url), metadataReceipts: [] }, "2026-10-01T21:00:00Z");
}

async function history(t, original = snapshot()) {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = resolve(root, "failed-old-version");
  await mkdir(resolve(runDir, "artifacts"), { recursive: true });
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [original] };
  const manifest = { market: "US", marketAsOf: envelope.marketAsOf, inputHash: "old-rounding-and-version", status: "failed", startedAt: "2026-10-01T20:30:00Z", sourceSnapshotsHash: stableHash(book), stages: { "evidence-verification-test": { status: "completed", sourceSnapshotsHash: stableHash(book) } } };
  await writeFile(resolve(runDir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(resolve(runDir, "artifacts/recap-source-snapshots.json"), JSON.stringify(book));
  return { root, runDir, book, manifest };
}

test("an intact same-session owned wrap supplies only a discovery URL across input changes", async t => {
  const h = await history(t);
  const leads = await priorRecapDiscoveryLeads(h.root, envelope);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].url, url);
  assert.equal(leads[0].publishedAt, "2026-10-01T20:07:35.000Z");
  assert.equal(leads[0].discoveryOnly, true);
  assert.equal(leads[0].reportingOrigin, "publisher:finance.yahoo.com");
  assert.equal(leads[0].supportingExcerpt, undefined);
  assert.equal(leads[0].facts, undefined);
  assert.deepEqual(await priorRecapDiscoveryLeads(h.root, { ...envelope, marketAsOf: "2026-10-02" }), []);
  assert.deepEqual(await priorRecapDiscoveryLeads(h.root, envelope, { beforeStartedAt: "2026-10-01T20:00:00Z" }), []);
});

test("a current-version wrap without explicit closing numbers remains a lead, not admitted evidence", async t => {
  const h = await history(t, snapshot("The session ended with a recovery."));
  assert.equal((await priorRecapDiscoveryLeads(h.root, envelope)).length, 1);
});

test("contradictory closing claims and an impossible future publication supply no lead", async t => {
  const h = await history(t, snapshot("At the closing bell, the S&P 500 fell 1.25%."));
  assert.deepEqual(await priorRecapDiscoveryLeads(h.root, envelope), []);
  h.book.snapshots = [{ ...snapshot(), fetchedAt: "2026-10-01T19:00:00Z" }];
  h.manifest.sourceSnapshotsHash = stableHash(h.book);
  h.manifest.stages["evidence-verification-test"].sourceSnapshotsHash = stableHash(h.book);
  await writeFile(resolve(h.runDir, "manifest.json"), JSON.stringify(h.manifest));
  await writeFile(resolve(h.runDir, "artifacts/recap-source-snapshots.json"), JSON.stringify(h.book));
  assert.deepEqual(await priorRecapDiscoveryLeads(h.root, envelope), []);
});

test("altered bytes or unsealed snapshots cannot become discovery input", async t => {
  const h = await history(t);
  h.book.snapshots[0].bodyBase64 = Buffer.from("fabricated original").toString("base64");
  await writeFile(resolve(h.runDir, "artifacts/recap-source-snapshots.json"), JSON.stringify(h.book));
  assert.deepEqual(await priorRecapDiscoveryLeads(h.root, envelope), []);
  h.manifest.sourceSnapshotsHash = stableHash(h.book);
  h.manifest.stages["evidence-verification-test"].sourceSnapshotsHash = stableHash(h.book);
  await writeFile(resolve(h.runDir, "manifest.json"), JSON.stringify(h.manifest));
  assert.deepEqual(await priorRecapDiscoveryLeads(h.root, envelope), []);
  const stored = JSON.parse(await readFile(resolve(h.runDir, "manifest.json"), "utf8"));
  assert.equal(stored.status, "failed");
});
