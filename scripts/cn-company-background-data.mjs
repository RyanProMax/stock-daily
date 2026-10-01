import { createHash } from "node:crypto";
import { CNINFO_REGISTRY_URL, CNINFO_HISTORY_URL, cninfoRegistryIdentity, cninfoHistoryBody, cninfoLatestPeriodic } from "./cninfo-history-request.mjs";
import { companyExposureExcerpts } from "./company-exposure-excerpts.mjs";
import { stableHash } from "./daily-workflow-core.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource } from "./evidence-source-snapshots.mjs";
import { pdfTextExcerptChecker } from "./pdf-text-evidence.mjs";

const digest = body => createHash("sha256").update(body).digest("hex");
const targets = plan => [...new Map(plan.anomalies.filter(item => item.kind === "ai_layer").flatMap(anomaly => anomaly.observation.constituents.map(item => [item.symbol, { symbol: item.symbol, anomaly }]))).values()];
function receipt(url, opened, now, requestBody) {
  if (opened.finalUrl !== url || opened.status !== 200 || !/^application\/json(?:;|$)/iu.test(opened.contentType ?? "") || !Buffer.isBuffer(opened.rawBody) || !opened.rawBody.length || opened.rawBody.length > 2 * 1024 * 1024 || (requestBody !== undefined && (opened.requestMethod !== "POST" || opened.requestBody !== requestBody))) throw new Error("巨潮公司记录的地址、状态、类型、长度或请求不符");
  return { url, finalUrl: url, status: opened.status, contentType: opened.contentType, bodyBase64: opened.rawBody.toString("base64"), bodyHash: digest(opened.rawBody), fetchedAt: opened.fetchedAt ?? now().toISOString(), ...(requestBody !== undefined ? { requestMethod: "POST", requestBody, requestBodyHash: digest(requestBody) } : {}) };
}
function json(r, url, requestBody) {
  if (r?.url !== url || r.finalUrl !== url || r.status !== 200 || !/^application\/json(?:;|$)/iu.test(r.contentType ?? "") || !/Z$/u.test(r.fetchedAt ?? "") || !Number.isFinite(Date.parse(r.fetchedAt)) || typeof r.bodyBase64 !== "string" || r.bodyBase64.length > Math.ceil(2 * 1024 * 1024 / 3) * 4 || (requestBody !== undefined ? r.requestMethod !== "POST" || r.requestBody !== requestBody || r.requestBodyHash !== digest(requestBody) : r.requestMethod || r.requestBody || r.requestBodyHash)) throw new Error("巨潮冻结公司记录或查询表单不符");
  const body = Buffer.from(r.bodyBase64, "base64");
  if (!body.length || body.length > 2 * 1024 * 1024 || body.toString("base64") !== r.bodyBase64 || digest(body) !== r.bodyHash) throw new Error("巨潮冻结公司记录原始字节哈希不符");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function derive(book, envelope, plan, cache = new Map()) {
  const registry = json(book.registry, CNINFO_REGISTRY_URL), profiles = new Map(), filings = new Map(), sources = [], gaps = [];
  // Validate every saved original before handling missing evidence. Changing a
  // record's bytes, issuer or query cannot turn corruption into an ordinary gap.
  for (const profile of book.profiles) {
    const entity = cninfoRegistryIdentity(registry, profile.symbol);
    const selected = cninfoLatestPeriodic(json(profile.receipt, CNINFO_HISTORY_URL, cninfoHistoryBody(entity, envelope)), entity, envelope);
    profiles.set(profile.symbol, selected);
  }
  for (const filing of book.filings) {
    const selected = profiles.get(filing.symbol), entity = cninfoRegistryIdentity(registry, filing.symbol);
    if (!selected || filing.snapshot?.source !== selected.url || filing.snapshot.finalUrl !== selected.url) throw new Error("冻结定期报告未对应最新的完整官方披露记录");
    const hash = stableHash(filing.snapshot);
    let original = cache.get(hash);
    if (!original) {
      const opened = openedSourceFromSnapshot(filing.snapshot);
      const publication = opened.pdfDocument, record = opened.metadataReceipts?.[0];
      const metadata = record && JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.rawBody));
      if (opened.status !== 200 || !/^application\/pdf(?:;|$)/iu.test(opened.contentType) || publication?.issuer?.symbol !== filing.symbol || publication.announcementId !== selected.announcementId || publication.title !== selected.title || publication.issuer.name !== selected.name || metadata?.announcement?.orgId !== entity.orgId || publication.publishedAtCandidates.length || stableHash(publication.publishedDateCandidates) !== stableHash([selected.publishedAt])) throw new Error("定期报告的原始发行主体、机构、日期、标题或文件身份不一致");
      const checkExcerpt = pdfTextExcerptChecker(opened);
      original = { opened, quotes: companyExposureExcerpts(opened.text, { language: "zh", issuerName: publication.issuer.issuerName, acceptExcerpt: quote => { try { checkExcerpt(quote); return true; } catch { return false; } } }) };
      cache.set(hash, original);
    }
    filings.set(filing.symbol, original);
  }
  for (const { symbol, anomaly } of targets(plan)) {
    try {
      cninfoRegistryIdentity(registry, symbol);
      const selected = profiles.get(symbol), original = filings.get(symbol);
      if (!selected) throw new Error("尚无该公司的完整冻结定期披露记录");
      if (!original) throw new Error("尚无对应完整定期报告的可重放原文");
      if (!original.quotes.length) throw new Error("定期报告中没有完整可核验的自身经济敞口段落");
      for (const quote of original.quotes) sources.push({ originalUrl: selected.url, sourceLabel: "巨潮资讯网", title: `${selected.name}：${selected.title}`, publishedAt: selected.publishedAt, kind: "background", supportingExcerpt: quote, facts: "公司此前披露了自身经营涉及的经济因素及其影响，具体条件见原文。", scope: "company", targets: [symbol], hypothesisIds: [anomaly.hypotheses[1].id], causalConnection: false, comparisons: [], role: "facts", anomalyId: anomaly.id });
    } catch (error) { gaps.push({ symbol, reason: error.message }); }
  }
  return { sources, gaps };
}

export function validateCnCompanyBackgroundData(book, envelope, plan) {
  const expected = targets(plan).map(item => item.symbol);
  if (book.failures?.some(item => ![CNINFO_REGISTRY_URL, CNINFO_HISTORY_URL].includes(item.url) && !/^https:\/\/static\.cninfo\.com\.cn\/finalpage\/20\d{2}-\d{2}-\d{2}\/\d{10}\.PDF$/u.test(item.url))) throw new Error("巨潮公司敞口访问失败记录地址无效");
  if (!book.registry) {
    if (book.profiles.length || book.filings.length || book.sources.length || stableHash(book.gaps.map(item => item.symbol)) !== stableHash(expected) || book.gaps.some(item => typeof item.reason !== "string" || !item.reason)) throw new Error("巨潮公司身份不可用的缺口不完整");
    return book;
  }
  const derived = derive(book, envelope, plan);
  if (stableHash(derived.sources) !== stableHash(book.sources) || stableHash(derived.gaps) !== stableHash(book.gaps)) throw new Error("中国公司敞口无法从冻结身份、披露记录及完整原文重建");
  return book;
}

export async function collectCnCompanyBackgroundData(book, envelope, plan, { reader, now, signal, onCheckpoint }) {
  const requested = targets(plan), cache = new Map();
  book.failures ??= [];
  const boundedSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
  const checkpoint = async () => { Object.assign(book, derive(book, envelope, plan, cache)); if (onCheckpoint) await onCheckpoint(book); };
  try { book.registry ??= receipt(CNINFO_REGISTRY_URL, await reader(CNINFO_REGISTRY_URL, { structured: true, signal: boundedSignal() }), now); }
  catch (error) {
    book.gaps = requested.map(({ symbol }) => ({ symbol, reason: `巨潮公司身份不可用：${error.message}` }));
    if (requested.length) book.failures.push({ symbol: requested[0].symbol, url: CNINFO_REGISTRY_URL, reason: error.message, observedAt: now().toISOString() });
    if (onCheckpoint) await onCheckpoint(book);
    return book;
  }
  const registry = json(book.registry, CNINFO_REGISTRY_URL);
  // Discover all issuer records before downloading lengthy PDFs. A slow or
  // unsupported first document must not consume every other company's chance
  // to establish its native disclosure identity within the shared deadline.
  for (const { symbol } of requested) {
    if (signal?.aborted) break;
    if (book.profiles.some(item => item.symbol === symbol)) continue;
    let url = CNINFO_REGISTRY_URL;
    try {
      const entity = cninfoRegistryIdentity(registry, symbol), body = cninfoHistoryBody(entity, envelope);
      url = CNINFO_HISTORY_URL;
      const profile = book.profiles.find(item => item.symbol === symbol)?.receipt ?? receipt(url, await reader(url, { structured: true, cninfoHistory: body, maxBytes: 2 * 1024 * 1024, signal: boundedSignal() }), now, body);
      const selected = cninfoLatestPeriodic(json(profile, url, body), entity, envelope);
      if (!book.profiles.some(item => item.symbol === symbol)) book.profiles.push({ symbol, receipt: profile });
      if (!selected) throw new Error("窗口前没有可核验且未过期的完整定期报告");
    } catch (error) { book.failures.push({ symbol, url, reason: error.message, observedAt: now().toISOString() }); }
    await checkpoint();
  }
  for (const { symbol } of requested) {
    if (signal?.aborted) break;
    if (book.filings.some(item => item.symbol === symbol)) continue;
    const profile = book.profiles.find(item => item.symbol === symbol);
    if (!profile) continue;
    let url = CNINFO_HISTORY_URL;
    try {
      const entity = cninfoRegistryIdentity(registry, symbol);
      const selected = cninfoLatestPeriodic(json(profile.receipt, CNINFO_HISTORY_URL, cninfoHistoryBody(entity, envelope)), entity, envelope);
      if (!selected) continue;
      url = selected.url;
      const opened = await reader(url, { includeRaw: true, maxBytes: 8 * 1024 * 1024, signal: boundedSignal() });
      const snapshot = snapshotFromOpenedSource(url, opened, opened.fetchedAt ?? now().toISOString());
      if (book.filings.reduce((sum, item) => sum + Buffer.byteLength(item.snapshot.bodyBase64, "base64"), 0) + opened.rawBody.length > 96 * 1024 * 1024) throw new Error("公司敞口原文字节超过上限");
      // Admit only after the same replay used at publication confirms identity.
      const candidate = { ...book, filings: [...book.filings, { symbol, snapshot }] };
      derive(candidate, envelope, plan, cache);
      book.filings.push({ symbol, snapshot });
    } catch (error) { book.failures.push({ symbol, url, reason: error.message, observedAt: now().toISOString() }); }
    await checkpoint();
  }
  await checkpoint();
  return validateCnCompanyBackgroundData(book, envelope, plan);
}
