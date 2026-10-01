import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { fedSpeechPublishedAtCandidates, isPublicAddress, normalizedEvidenceText, readExternalSource, secSubmissionMetadataUrl, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "./daily-source-audit.mjs";
import { assertComparisonNotesInExcerpt, assertFactsNumbersInExcerpt, assertMaterialEarningsContext, hasCausalPassage, hasUnitBoundComparisonValue, stableHash, supportingExcerptMatches } from "./daily-workflow-core.mjs";
import { verifiedExternalSourceType } from "./source-registry.mjs";
import { isCalendarDate } from "./evidence-timing.mjs";

export const SOURCE_SNAPSHOT_VERSION = "verified-original-source-snapshots-v1";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BOOK_BYTES = 128 * 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function httpsUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || host === "localhost" || host.endsWith(".local") || (isIP(host) && !isPublicAddress(host))) throw new Error("原文快照包含无效或内网地址");
  return url.toString();
}

function rawReceipt(opened) {
  if (!Buffer.isBuffer(opened.rawBody) || !opened.rawBody.length || opened.rawBody.length > MAX_BYTES || !Number.isInteger(opened.status) || opened.status < 200 || opened.status >= 300 || typeof opened.contentType !== "string") throw new Error("原文快照缺少有效原始字节、状态或正文类型");
  return { finalUrl: httpsUrl(opened.finalUrl), status: opened.status, contentType: opened.contentType, bodyBase64: opened.rawBody.toString("base64"), bodyHash: digest(opened.rawBody) };
}

function bytes(receipt) {
  httpsUrl(receipt.finalUrl);
  if (typeof receipt.bodyBase64 !== "string" || receipt.bodyBase64.length > Math.ceil(MAX_BYTES / 3) * 4 || !Number.isInteger(receipt.status) || receipt.status < 200 || receipt.status >= 300 || typeof receipt.contentType !== "string") throw new Error("原文快照状态、类型或长度无效");
  const body = Buffer.from(receipt.bodyBase64, "base64");
  if (!body.length || body.length > MAX_BYTES || body.toString("base64") !== receipt.bodyBase64 || digest(body) !== receipt.bodyHash) throw new Error("原文快照原始字节哈希不一致");
  return body;
}

export function openedSourceFromSnapshot(snapshot) {
  httpsUrl(snapshot.source);
  const body = bytes(snapshot);
  if (!/(?:html|xhtml|plain|json)/iu.test(snapshot.contentType)) throw new Error("原文快照正文类型不受支持");
  const text = sourceBodyText(body, snapshot.contentType);
  if ([...text].length < 80 || stableHash(text) !== snapshot.textHash || !/Z$/u.test(snapshot.fetchedAt ?? "") || !Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error("原文快照正文或采集时间无效");
  let publishedAtCandidates = sourcePublishedAtCandidates(body, snapshot.contentType, snapshot.finalUrl);
  const receipts = snapshot.metadataReceipts;
  if (!Array.isArray(receipts) || receipts.length > 1) throw new Error("原文快照的时间元数据记录无效");
  for (const receipt of receipts) {
    const metadata = bytes(receipt);
    if (publishedAtCandidates.length) throw new Error("已有原始发布时间时不得覆盖为附加时间");
    if (receipt.finalUrl === "https://www.federalreserve.gov/feeds/speeches.xml" && new URL(snapshot.finalUrl).hostname === "www.federalreserve.gov") publishedAtCandidates = fedSpeechPublishedAtCandidates(body, metadata, snapshot.finalUrl);
    else if (receipt.finalUrl === secSubmissionMetadataUrl(snapshot.finalUrl)) publishedAtCandidates = sourcePublishedAtCandidates(metadata, receipt.contentType, receipt.finalUrl);
    else throw new Error("附加时间元数据不对应原始文章或 SEC 申报");
  }
  const publishedDateCandidates = sourcePublishedDateCandidates(body, snapshot.contentType, snapshot.finalUrl);
  if (stableHash(publishedAtCandidates) !== stableHash(snapshot.publishedAtCandidates) || stableHash(publishedDateCandidates) !== stableHash(snapshot.publishedDateCandidates)) throw new Error("原文快照的发布时间未由冻结原文证明");
  return { source: snapshot.source, finalUrl: snapshot.finalUrl, status: snapshot.status, contentType: snapshot.contentType, text, publishedAtCandidates, publishedDateCandidates, rawBody: body };
}

export function snapshotFromOpenedSource(source, opened, fetchedAt = new Date().toISOString()) {
  const snapshot = { source: httpsUrl(source), ...rawReceipt(opened), fetchedAt, textHash: stableHash(opened.text), publishedAtCandidates: opened.publishedAtCandidates ?? [], publishedDateCandidates: opened.publishedDateCandidates ?? [], metadataReceipts: (opened.metadataReceipts ?? []).map(rawReceipt) };
  openedSourceFromSnapshot(snapshot);
  return snapshot;
}

function assertBookBounds(book) {
  if (book?.version !== SOURCE_SNAPSHOT_VERSION || !Array.isArray(book.snapshots) || book.snapshots.length > 200) throw new Error("原文快照账本无效");
  let totalBytes = 0;
  for (const snapshot of book.snapshots) {
    totalBytes += Buffer.byteLength(snapshot.bodyBase64 ?? "", "base64") + (snapshot.metadataReceipts ?? []).reduce((sum, receipt) => sum + Buffer.byteLength(receipt.bodyBase64 ?? "", "base64"), 0);
    if (totalBytes > MAX_BOOK_BYTES) throw new Error("原文快照总字节超过上限");
  }
}

export function validateSourceSnapshots(book) {
  assertBookBounds(book);
  const sources = new Set();
  for (const snapshot of book.snapshots) {
    if (sources.has(snapshot.source)) throw new Error("原文快照请求地址重复");
    sources.add(snapshot.source);
    openedSourceFromSnapshot(snapshot);
  }
  return book;
}

// One immutable original per request in this run. Repeated candidates and
// resumed batches reuse it; HTTP refusals are shared only during this process.
export async function createSnapshotSourceReader(path, fallback = readExternalSource) {
  let book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [] };
  try { book = validateSourceSnapshots(JSON.parse(await readFile(path, "utf8"))); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const opened = new Map(book.snapshots.map(snapshot => [snapshot.source, Promise.resolve(openedSourceFromSnapshot(snapshot))]));
  let queue = Promise.resolve();
  const persist = () => {
    const copy = JSON.stringify(book, null, 2) + "\n";
    queue = queue.then(async () => { await mkdir(dirname(path), { recursive: true }); await writeFile(path + ".tmp", copy, { mode: 0o600 }); await rename(path + ".tmp", path); });
    return queue;
  };
  await persist();
  return {
    get book() { return structuredClone(book); },
    reader: async (source, options = {}) => {
      options.signal?.throwIfAborted();
      if (!opened.has(source)) opened.set(source, (async () => {
        const result = await fallback(source, { ...options, includeRaw: true });
        const snapshot = snapshotFromOpenedSource(source, result);
        book.snapshots.push(snapshot);
        try { assertBookBounds(book); } catch (error) { book.snapshots.pop(); throw error; }
        await persist();
        return openedSourceFromSnapshot(snapshot);
      })());
      return opened.get(source);
    },
  };
}

export function auditLedgerSourceSnapshots(ledger, book) {
  validateSourceSnapshots(book);
  const originals = new Map(book.snapshots.map(snapshot => [snapshot.source, openedSourceFromSnapshot(snapshot)]));
  for (const source of ledger.sources) {
    const original = originals.get(source.originalUrl ?? source.url);
    if (!original || original.finalUrl !== source.url || original.status !== (source.status ?? original.status) || verifiedExternalSourceType(original.finalUrl) !== source.sourceType) throw new Error("证据来源与冻结原文地址、状态或身份不一致");
    const quote = normalizedEvidenceText(source.supportingExcerpt);
    const body = normalizedEvidenceText(original.text);
    if (quote.length < 20 || stableHash(quote) !== source.excerptHash || !supportingExcerptMatches(body, quote, source.supportingExcerpt)) throw new Error("证据引文未由冻结原文证明");
    const clock = isCalendarDate(source.publishedAt) ? source.sourceType === "first_party" && original.publishedDateCandidates.includes(source.publishedAt) : Number.isFinite(Date.parse(source.publishedAt)) && /(?:Z|[+-]\d{2}:\d{2})$/u.test(source.publishedAt ?? "") && original.publishedAtCandidates.some(value => !isCalendarDate(value) && Date.parse(value) === Date.parse(source.publishedAt));
    if (!clock) throw new Error("证据发布时间未由冻结原文或对应时间元数据证明");
    assertFactsNumbersInExcerpt({ ...source, facts: source.facts ?? "" });
    assertComparisonNotesInExcerpt(source);
    assertMaterialEarningsContext(source, original.text);
    for (const comparison of source.comparisons ?? []) for (const value of [comparison.actualValue, comparison.baselineValue]) if (!hasUnitBoundComparisonValue(source.supportingExcerpt, comparison.unit, value)) throw new Error("类型化财务对比值未由冻结引文的数值和单位证明");
    if (source.role === "causal" && !hasCausalPassage(source.supportingExcerpt)) throw new Error("冻结引文没有原文因果联系");
  }
  return book;
}
