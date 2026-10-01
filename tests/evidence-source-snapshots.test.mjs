import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { auditLedgerSourceSnapshots, createSnapshotSourceReader, openedSourceFromSnapshot, snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION, validateSourceSnapshots } from "../scripts/evidence-source-snapshots.mjs";
import { normalizedEvidenceText, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { stableHash } from "../scripts/daily-workflow-core.mjs";

const url = "https://www.reuters.com/markets/original";
const quote = "The index fell 0.2% as rising Treasury yields weighed on stocks. The report identified borrowing costs as the offset to improved demand.";
function opened(body = `<meta property="article:published_time" content="2026-09-29T20:30:00Z"><p>${quote}</p>`, source = url) {
  const rawBody = Buffer.from(body);
  return { finalUrl: source, status: 200, contentType: "text/html", rawBody, text: sourceBodyText(rawBody), publishedAtCandidates: sourcePublishedAtCandidates(rawBody, "text/html", source), publishedDateCandidates: sourcePublishedDateCandidates(rawBody, "text/html", source), metadataReceipts: [] };
}
function fixture() {
  const snapshot = snapshotFromOpenedSource(url, opened());
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshot] };
  const ledger = { sources: [{ url, originalUrl: url, sourceType: "publisher", role: "causal", publishedAt: "2026-09-29T20:30:00.000Z", status: 200, supportingExcerpt: quote, excerptHash: stableHash(normalizedEvidenceText(quote)), facts: "The index fell 0.2% as Treasury yields rose.", comparisons: [] }] };
  return { snapshot, book, ledger };
}

test("frozen source byte and clock receipts reproduce the original and support the approved ledger", () => {
  const f = fixture();
  assert.deepEqual(openedSourceFromSnapshot(f.snapshot).rawBody, opened().rawBody);
  assert.equal(auditLedgerSourceSnapshots(f.ledger, f.book), f.book);
  for (const mutate of [
    f => f.snapshot.bodyBase64 = Buffer.from("changed original").toString("base64"),
    f => f.snapshot.textHash = "replaced",
    f => f.snapshot.publishedAtCandidates = ["2026-09-29T14:00:00Z"],
    f => f.snapshot.status = undefined,
    f => f.snapshot.finalUrl = "https://127.0.0.1/private",
    f => f.book.snapshots.push(structuredClone(f.snapshot)),
    f => f.ledger.sources[0].facts = "The index rose 0.2%.",
    f => f.ledger.sources[0].supportingExcerpt = "A fabricated explanation connects this price reaction to nonexistent orders.",
    f => f.ledger.sources[0].publishedAt = "2026-09-29T14:00:00.000Z",
    f => f.ledger.sources[0].comparisons = [{ unit: "percent", actualValue: 7, baselineValue: 0.2 }],
  ]) { const changed = fixture(); mutate(changed); assert.throws(() => auditLedgerSourceSnapshots(changed.ledger, changed.book)); }
});

test("a recomputed byte hash cannot hide an original-page revision under the frozen parsed body", () => {
  const f = fixture();
  const body = Buffer.from(f.snapshot.bodyBase64, "base64").toString().replace("fell 0.2%", "rose 0.2%");
  f.snapshot.bodyBase64 = Buffer.from(body).toString("base64");
  f.snapshot.bodyHash = createHash("sha256").update(body).digest("hex");
  assert.throws(() => validateSourceSnapshots(f.book), /正文/);
});

test("concurrent candidates and resumed batches reuse one frozen original without another request", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "stock-daily-source-book-"));
  try {
    let requests = 0;
    const path = resolve(directory, "sources.json");
    const capture = await createSnapshotSourceReader(path, async (source, options) => { requests++; assert.equal(options.includeRaw, true); return opened(); });
    const [a, b] = await Promise.all([capture.reader(url), capture.reader(url)]);
    assert.equal(requests, 1);
    assert.equal(a.text, b.text);
    const restored = await createSnapshotSourceReader(path, () => { throw new Error("network must not run"); });
    assert.equal((await restored.reader(url)).text, a.text);
    assert.equal(JSON.parse(await readFile(path)).snapshots.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTTP refusals are never archived as evidence and are shared only within the current attempt", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "stock-daily-source-failure-"));
  try {
    let requests = 0;
    const path = resolve(directory, "sources.json");
    const capture = await createSnapshotSourceReader(path, async () => { requests++; throw new Error("HTTP 403"); });
    const results = await Promise.allSettled([capture.reader(url), capture.reader(url)]);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(requests, 1);
    assert.deepEqual(capture.book.snapshots, []);
    const restored = await createSnapshotSourceReader(path, async () => opened());
    assert.ok((await restored.reader(url)).text.includes(quote));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SEC acceptance times require the exact corresponding original submission bytes", () => {
  const source = "https://www.sec.gov/Archives/edgar/data/123/000000012326000001/exhibit.htm";
  const original = opened(`<p>${quote}</p>`, source);
  const rawBody = Buffer.from("<ACCEPTANCE-DATETIME>20260929100000\n" + "SEC submission metadata ".repeat(5));
  const metadata = { finalUrl: "https://www.sec.gov/Archives/edgar/data/123/000000012326000001/0000000123-26-000001.txt", status: 200, contentType: "text/plain", rawBody };
  original.metadataReceipts = [metadata];
  original.publishedAtCandidates = sourcePublishedAtCandidates(rawBody, "text/plain", metadata.finalUrl);
  assert.ok(original.publishedAtCandidates.length);
  const snapshot = snapshotFromOpenedSource(source, original);
  assert.deepEqual(openedSourceFromSnapshot(snapshot).publishedAtCandidates, original.publishedAtCandidates);
  snapshot.metadataReceipts[0].finalUrl = "https://www.sec.gov/Archives/edgar/data/999/other.txt";
  assert.throws(() => openedSourceFromSnapshot(snapshot), /不对应/);
});

test("uncaptured auxiliary clocks and hidden EPS qualifications cannot satisfy publication", () => {
  const original = opened(`<p>${quote}</p>`);
  original.publishedAtCandidates = ["2026-09-29T14:00:00Z"];
  assert.throws(() => snapshotFromOpenedSource(url, original), /发布时间/);
  const f = fixture();
  const actual = opened(`<meta property="article:published_time" content="2026-09-29T20:30:00Z"><p>${quote}</p><p>EPS included one-off gains from strategic investments.</p>`);
  f.book.snapshots = [snapshotFromOpenedSource(url, actual)];
  f.ledger.sources[0].comparisons = [{ label: "EPS" }];
  assert.throws(() => auditLedgerSourceSnapshots(f.ledger, f.book), /非经常性/);
});

test("an official date-only original cannot be upgraded to a fabricated midnight clock", () => {
  const source = "https://www.conference-board.org/release/confidence";
  const original = opened(`<meta property="article:published_time" content="2026-09-29"><p>${quote}</p>`, source);
  const snapshot = snapshotFromOpenedSource(source, original);
  const ledger = fixture().ledger;
  Object.assign(ledger.sources[0], { url: source, originalUrl: source, sourceType: "first_party", role: "facts", publishedAt: "2026-09-29" });
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshot] };
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, book));
  ledger.sources[0].publishedAt = "2026-09-29T00:00:00.000Z";
  assert.throws(() => auditLedgerSourceSnapshots(ledger, book), /发布时间/);
});
