import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { BEA_RELEASE_FEED, beaReleasePublishedAtCandidates, readExternalSource, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource } from "../scripts/evidence-source-snapshots.mjs";

const source = "https://www.bea.gov/news/2026/personal-income-and-outlays-august-2026";
const path = new URL(source).pathname;
const title = "Personal Income and Outlays, August 2026";
const body = `<article about="${path}"><h1>News Release</h1><div class="release-embargo"><div class="field--name-field-release-date">EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, Wednesday, September 30, 2026</div></div><h1>${title}</h1><div class="field--name-body">Personal income increased, according to estimates released today by the U.S. Bureau of Economic Analysis (BEA). The PCE price index rose 3.4 percent from one year ago.</div></article>`;
const item = `<item><title>${title}</title><link>${source}</link><guid>${source}</guid><pubDate>Wed, 30 Sep 2026 08:31:00 EDT</pubDate></item>`;
const feed = `<rss><channel>${item}</channel></rss>`;
const clock = "2026-09-30T12:31:00.000Z";

test("BEA's exact official RSS record supplies the publication clock, never the earlier embargo time", () => {
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(body), "text/html", source), []);
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(body), "text/html", source), ["2026-09-30"]);
  assert.deepEqual(beaReleasePublishedAtCandidates(body, feed, source), [clock]);
  assert.deepEqual(beaReleasePublishedAtCandidates(body, feed, source.replace("www.bea", "bea")), [clock]);
  for (const invalid of [
    feed.replaceAll(path, path.replace("august", "july")),
    feed.replace(`<guid>${source}</guid>`, `<guid>https://mirror.example${path}</guid>`),
    feed.replace(title, "Personal Income and Outlays, July 2026"),
    feed.replace("08:31:00 EDT", "08:31:00"),
    feed.replace("Wed, 30 Sep", "Tue, 30 Sep"),
    feed.replace("08:31:00 EDT", "08:31:00 +1460"),
    feed.replace("Wed, 30 Sep", "Thu, 01 Oct"),
    feed.replace("</item>", "<pubDate>Wed, 30 Sep 2026 08:30:00 EDT</pubDate></item>"),
    `<rss><channel>${item}${item}</channel></rss>`,
  ]) assert.deepEqual(beaReleasePublishedAtCandidates(body, invalid, source), []);
  const marchBody = body.replace("Wednesday, September 30", "Monday, March 2");
  assert.deepEqual(beaReleasePublishedAtCandidates(marchBody, feed.replace("Wed, 30 Sep", "Mon, 30 Feb"), source), []);
});

test("BEA calendar pages, unrelated articles, future-release paragraphs and footer modification dates cannot date a current release", () => {
  for (const invalid of [
    body.replace(`about="${path}"`, 'about="/news/2026/unrelated"'),
    body.replace("released today", "will be released next month"),
    body.replace("Wednesday, September 30", "Tuesday, September 30"),
    body.replace("September 30", "February 30"),
    body.replace("field--name-field-release-date", "field--name-modification-date"),
  ]) {
    assert.deepEqual(beaReleasePublishedAtCandidates(invalid, feed, source), []);
    assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(invalid), "text/html", source), []);
  }
  for (const url of [source.replace("www.bea.gov", "mirror.example"), source.replace(path, "/news/blog/release-schedule"), source + "?calendar=true"]) assert.deepEqual(beaReleasePublishedAtCandidates(body, feed, url), []);
  const generic = `<article about="${path}"><h1>${title}</h1><p>Next release: September 30, 2026 at 8:30 a.m.</p><footer>Page last modified on 9/30/26</footer></article>`;
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(generic), "text/html", source), []);
});

test("source reads freeze exact BEA feed bytes, while a refused feed retains only the independently stated release date", async () => {
  const requests = [];
  const requester = async url => { requests.push(url); return { status: 200, contentType: url === source ? "text/html" : "text/xml", body: Buffer.from(url === source ? body : feed) }; };
  const options = { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester };
  const opened = await readExternalSource(source, options);
  assert.deepEqual(requests, [source, BEA_RELEASE_FEED]);
  assert.deepEqual(opened.publishedAtCandidates, [clock]);
  assert.equal(opened.metadataReceipts[0].rawBody.toString(), feed);
  const snapshot = snapshotFromOpenedSource(source, opened);
  assert.deepEqual(openedSourceFromSnapshot(snapshot).publishedAtCandidates, [clock]);
  const denied = await readExternalSource(source, { ...options, requester: async url => url === source ? requester(url) : { status: 403 } });
  assert.deepEqual(denied.publishedAtCandidates, []);
  assert.deepEqual(denied.publishedDateCandidates, ["2026-09-30"]);
  assert.deepEqual(denied.metadataReceipts, []);
});

test("substituted BEA feed identities or altered publication bytes cannot reproduce a frozen clock", () => {
  const original = { finalUrl: source, status: 200, contentType: "text/html", rawBody: Buffer.from(body), text: sourceBodyText(Buffer.from(body)), publishedAtCandidates: [clock], publishedDateCandidates: ["2026-09-30"], metadataReceipts: [{ finalUrl: BEA_RELEASE_FEED, status: 200, contentType: "text/xml", rawBody: Buffer.from(feed) }] };
  const snapshot = snapshotFromOpenedSource(source, original);
  const changed = structuredClone(snapshot);
  const altered = Buffer.from(feed.replace("08:31:00", "08:30:00"));
  changed.metadataReceipts[0].bodyBase64 = altered.toString("base64");
  changed.metadataReceipts[0].bodyHash = createHash("sha256").update(altered).digest("hex");
  assert.throws(() => openedSourceFromSnapshot(changed), /发布时间/);
  changed.metadataReceipts[0].finalUrl = "https://mirror.example/rss.xml";
  assert.throws(() => openedSourceFromSnapshot(changed), /不对应/);
});
