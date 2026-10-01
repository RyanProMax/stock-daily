import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { BEA_RELEASE_FEED, beaReleasePublishedAtCandidates, decodeSourceBody, fedSpeechPublishedAtCandidates, isPublicAddress, normalizedEvidenceText, readExternalSource, secSubmissionMetadataUrl, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "./daily-source-audit.mjs";
import { GDP_NOW_FEED, assertGdpNowCopy, gdpNowCommentaryRecord, gdpNowForecastDefinition, gdpNowPublishedAtCandidates, isGdpNowCommentary } from "./gdpnow-publication.mjs";
import { sourceArticleProvenance } from "./source-article-provenance.mjs";
import { nfraDocumentIdentity, nfraDocumentRecord } from "./nfra-document.mjs";
import { pdfSourceRecord } from "./pdf-source.mjs";
import { cninfoPdfPublication } from "./cninfo-pdf-publication.mjs";
import { assertComparisonNotesInExcerpt, assertFactsNumbersInExcerpt, assertMaterialEarningsContext, hasCausalPassage, hasUnitBoundComparisonValue, stableHash, supportingExcerptMatches, verifiedBackgroundExposureSubjects, verifiedCurrentCompanySubjects } from "./daily-workflow-core.mjs";
import { verifiedExternalSourceType } from "./source-registry.mjs";
import { isCalendarDate } from "./evidence-timing.mjs";
import { assertAccessibleOriginalArticle, assertSessionClosingClaims } from "./source-session-integrity.mjs";
import { auditRecapRateFactors } from "./recap-rate-factors.mjs";
import { secCompanySubmissionsUrl, secCompanySubmissionTime } from "./sec-filing-identity.mjs";
import { verifiedCurrentCorporateAction } from "./recap-corporate-actions.mjs";
import { chinaPmiDocument, chinaPmiSurveyDefinition } from "./china-pmi-release.mjs";
import { MOF_DOCUMENT_VERSION, mofDocumentIdentity, mofDocumentRecord } from "./mof-document.mjs";

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
  return { finalUrl: httpsUrl(opened.finalUrl), status: opened.status, contentType: opened.contentType, bodyBase64: opened.rawBody.toString("base64"), bodyHash: digest(opened.rawBody), ...(opened.requestMethod ? { requestMethod: opened.requestMethod } : {}) };
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
  if (!/(?:html|xhtml|plain|json)/iu.test(snapshot.contentType) && !/^application\/pdf(?:;|$)/iu.test(snapshot.contentType)) throw new Error("原文快照正文类型不受支持");
  let text = sourceBodyText(body, snapshot.contentType);
  let pdfDocument = /^application\/pdf(?:;|$)/iu.test(snapshot.contentType) ? pdfSourceRecord(body) : undefined;
  let publishedAtCandidates = sourcePublishedAtCandidates(body, snapshot.contentType, snapshot.finalUrl);
  const receipts = snapshot.metadataReceipts;
  if (!Array.isArray(receipts) || receipts.length > 1) throw new Error("原文快照的时间元数据记录无效");
  let authorityDocument;
  if (mofDocumentIdentity(snapshot.finalUrl)) {
    const record = /(?:html|xhtml)/iu.test(snapshot.contentType) ? mofDocumentRecord(decodeSourceBody(body, snapshot.contentType), snapshot.finalUrl) : null;
    if (!record || receipts.length) throw new Error("财政部公告未由冻结原文绑定身份、正文及发布时间");
    authorityDocument = { ...record, articleProvenance: sourceArticleProvenance(decodeSourceBody(body, snapshot.contentType), snapshot.finalUrl) };
    text = record.text;
    publishedAtCandidates = record.publishedAtCandidates;
  }
  const nfraIdentity = nfraDocumentIdentity(snapshot.finalUrl);
  if (nfraIdentity) publishedAtCandidates = [];
  for (const receipt of receipts) {
    const metadata = bytes(receipt);
    if (publishedAtCandidates.length) throw new Error("已有原始发布时间时不得覆盖为附加时间");
    if (pdfDocument) {
      const publication = cninfoPdfPublication(body, { ...receipt, rawBody: metadata }, snapshot.finalUrl);
      if (!publication) throw new Error("PDF 公告身份或发布日期未由对应原始记录证明");
      pdfDocument = { ...pdfDocument, ...publication };
    }
    else if (nfraIdentity) {
      authorityDocument = nfraDocumentRecord(decodeSourceBody(body, snapshot.contentType), { ...receipt, rawBody: metadata }, snapshot.finalUrl);
      if (!authorityDocument) throw new Error("金融监管总局公告未由冻结页面和对应原始记录绑定");
      text = authorityDocument.text;
      publishedAtCandidates = authorityDocument.publishedAtCandidates;
    }
    else if (receipt.finalUrl === "https://www.federalreserve.gov/feeds/speeches.xml" && new URL(snapshot.finalUrl).hostname === "www.federalreserve.gov") publishedAtCandidates = fedSpeechPublishedAtCandidates(body, metadata, snapshot.finalUrl);
    else if (receipt.finalUrl === GDP_NOW_FEED && isGdpNowCommentary(snapshot.finalUrl) && /^(?:application|text)\/xml(?:;|$)/iu.test(receipt.contentType)) publishedAtCandidates = gdpNowPublishedAtCandidates(body, metadata, snapshot.finalUrl);
    else if (receipt.finalUrl === BEA_RELEASE_FEED) publishedAtCandidates = beaReleasePublishedAtCandidates(body, metadata, snapshot.finalUrl);
    else if (receipt.finalUrl === secCompanySubmissionsUrl(snapshot.finalUrl)) publishedAtCandidates = secCompanySubmissionTime(metadata, snapshot.finalUrl);
    else if (receipt.finalUrl === secSubmissionMetadataUrl(snapshot.finalUrl)) publishedAtCandidates = sourcePublishedAtCandidates(metadata, receipt.contentType, receipt.finalUrl);
    else throw new Error("附加时间元数据不对应原始文章或 SEC 申报");
  }
  if (nfraIdentity && !authorityDocument) throw new Error("金融监管总局公告缺少冻结原始正文记录");
  if ([...text].length < 80 || stableHash(text) !== snapshot.textHash || !/Z$/u.test(snapshot.fetchedAt ?? "") || !Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error("原文快照正文或采集时间无效");
  const publishedDateCandidates = pdfDocument?.publishedDateCandidates ?? authorityDocument?.publishedDateCandidates ?? sourcePublishedDateCandidates(body, snapshot.contentType, snapshot.finalUrl);
  if (stableHash(publishedAtCandidates) !== stableHash(snapshot.publishedAtCandidates) || stableHash(publishedDateCandidates) !== stableHash(snapshot.publishedDateCandidates)) throw new Error("原文快照的发布时间未由冻结原文证明");
  const articleProvenance = authorityDocument?.articleProvenance ?? (/(?:html|xhtml)/iu.test(snapshot.contentType) ? sourceArticleProvenance(decodeSourceBody(body, snapshot.contentType), snapshot.finalUrl) : null);
  const metadataReceipts = receipts.map(receipt => ({ finalUrl: receipt.finalUrl, status: receipt.status, contentType: receipt.contentType, rawBody: bytes(receipt), ...(receipt.requestMethod ? { requestMethod: receipt.requestMethod } : {}) }));
  return { source: snapshot.source, finalUrl: snapshot.finalUrl, status: snapshot.status, contentType: snapshot.contentType, text, publishedAtCandidates, publishedDateCandidates, articleProvenance, rawBody: body, metadataReceipts, fetchedAt: snapshot.fetchedAt, ...(pdfDocument ? { pdfDocument } : {}) };
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

export function auditLedgerSourceSnapshots(ledger, book, { envelope = null, macroData = null } = {}) {
  validateSourceSnapshots(book);
  if (ledger.sources.some(source => source.kind === "macro_observation")) {
    if (!envelope || !macroData) throw new Error("数据观测缺少原始财政部数据账本");
    auditRecapRateFactors(ledger, macroData, envelope);
  }
  const originals = new Map(book.snapshots.map(snapshot => [snapshot.source, openedSourceFromSnapshot(snapshot)]));
  for (const source of ledger.sources) {
    if (source.kind === "macro_observation") continue;
    const original = originals.get(source.originalUrl ?? source.url);
    if (!original || original.finalUrl !== source.url || original.status !== (source.status ?? original.status) || verifiedExternalSourceType(original.finalUrl) !== source.sourceType) throw new Error("证据来源与冻结原文地址、状态或身份不一致");
    assertAccessibleOriginalArticle(original);
    if (mofDocumentIdentity(source.url) ? source.authorityDocumentVersion !== MOF_DOCUMENT_VERSION : source.authorityDocumentVersion) throw new Error("财政部公告身份核验版本未由冻结原文重建");
    if (envelope) assertSessionClosingClaims(original.text, envelope, source.publishedAt);
    const quote = normalizedEvidenceText(source.supportingExcerpt);
    const body = normalizedEvidenceText(original.text);
    if (quote.length < 20 || stableHash(quote) !== source.excerptHash || !supportingExcerptMatches(body, quote, source.supportingExcerpt)) throw new Error("证据引文未由冻结原文证明");
    const publication = original.articleProvenance?.publication;
    if (publication?.status === "unverified_update") throw new Error("文章当前版本更新时间无法核验");
    if (source.provenanceChecked || source.reportingOrigin) {
      if (stableHash(source.reportingOrigin ?? null) !== stableHash(original.articleProvenance?.origin ?? null)) throw new Error("报道原始署名或来源未由冻结文章重建");
    }
    const clocks = publication?.status === "verified" ? [publication.currentVersionAt] : original.publishedAtCandidates;
    if (publication?.status === "verified" && (source.initialPublishedAt !== publication.initialPublishedAt || source.timeBasis !== publication.timeBasis)) throw new Error("首次发布与当前版本时间必须分别保留");
    const clock = isCalendarDate(source.publishedAt) ? source.sourceType === "first_party" && original.publishedDateCandidates.includes(source.publishedAt) : Number.isFinite(Date.parse(source.publishedAt)) && /(?:Z|[+-]\d{2}:\d{2})$/u.test(source.publishedAt ?? "") && clocks.some(value => !isCalendarDate(value) && Date.parse(value) === Date.parse(source.publishedAt));
    if (!clock) throw new Error("证据发布时间未由冻结原文或对应时间元数据证明");
    if (source.kind === "corporate_action") {
      if (!envelope || source.corporateActionChecked !== true || stableHash(source.corporateAction) !== stableHash(verifiedCurrentCorporateAction(source, original, envelope))) throw new Error("公司行动日期、金额和发行主体未由冻结一手原文重建");
    } else if (source.corporateAction || source.corporateActionChecked) throw new Error("其他来源不能伪造公司行动核验记录");
    if (isGdpNowCommentary(source.originalUrl ?? source.url) || isGdpNowCommentary(source.url)) {
      const record = gdpNowCommentaryRecord(original.rawBody, source.url);
      if (!record || source.forecastChecked !== true || stableHash(source.forecastDefinition) !== stableHash(gdpNowForecastDefinition(record)) || source.role !== "facts" || !["official", "event"].includes(source.kind) || source.causalConnection || !supportingExcerptMatches(normalizedEvidenceText(record.paragraph), quote, source.supportingExcerpt)) throw new Error("GDPNow 模型定义、最新条目和引文未由冻结原文重建");
      assertGdpNowCopy(source.facts, [source]);
    } else if (source.forecastDefinition || source.forecastChecked) throw new Error("非 GDPNow 原文不得伪造模型核验记录");
    const pmiRecord = /^(?:text\/html|application\/xhtml)/iu.test(original.contentType) ? chinaPmiDocument(decodeSourceBody(original.rawBody, original.contentType), source.url) : null;
    if (pmiRecord) {
      if (source.surveyChecked !== true || stableHash(source.surveyDefinition) !== stableHash(chinaPmiSurveyDefinition(pmiRecord)) || source.role !== "facts" || source.scope !== "event_only" || !["official", "event"].includes(source.kind) || source.causalConnection || source.comparisons?.length) throw new Error("PMI 调查口径或公共事件范围未由冻结原文重建");
      const frozen = [macroData?.chinaPmi?.release, macroData?.chinaPmi?.interpretation].find(item => item?.source === source.url);
      const ledgerOriginal = book.snapshots.find(item => item.source === (source.originalUrl ?? source.url));
      if (frozen && frozen.bodyHash !== ledgerOriginal?.bodyHash) throw new Error("PMI 引文和宏观数据使用了不同版本的发布原文");
    } else if (source.surveyDefinition || source.surveyChecked) throw new Error("非 PMI 原文不得伪造调查核验记录");
    assertFactsNumbersInExcerpt({ ...source, facts: source.facts ?? "" });
    assertComparisonNotesInExcerpt(source);
    assertMaterialEarningsContext(source, original.text);
    for (const comparison of source.comparisons ?? []) for (const value of [comparison.actualValue, comparison.baselineValue]) if (!hasUnitBoundComparisonValue(source.supportingExcerpt, comparison.unit, value)) throw new Error("类型化财务对比值未由冻结引文的数值和单位证明");
    if (source.role === "causal" && !hasCausalPassage(source.supportingExcerpt)) throw new Error("冻结引文没有原文因果联系");
    if (source.kind === "background" && envelope && stableHash(source.backgroundSubjects) !== stableHash(verifiedBackgroundExposureSubjects(source, original, envelope))) throw new Error("背景敞口主体未由原始发行主体重建");
    if (envelope) {
      const companySubjects = verifiedCurrentCompanySubjects(source, original, envelope);
      if ((companySubjects.length || source.companySubjects || source.companySubjectChecked) && (source.companySubjectChecked !== true || stableHash(source.companySubjects) !== stableHash(companySubjects))) throw new Error("当前公司证据主体未由冻结原文重建");
    }
  }
  return book;
}
