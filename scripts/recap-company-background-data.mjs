import { createHash } from "node:crypto";
import { readExternalSource } from "./daily-source-audit.mjs";
import { stableHash } from "./daily-workflow-core.mjs";
import { backgroundEvidenceInWindow } from "./evidence-timing.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot } from "./evidence-source-snapshots.mjs";
import { secFilingIssuerIdentity, secCompanySubmissionsUrl, secCompanySubmissionTime } from "./sec-filing-identity.mjs";
import { companyExposureExcerpts } from "./company-exposure-excerpts.mjs";
import { collectCnCompanyBackgroundData, validateCnCompanyBackgroundData } from "./cn-company-background-data.mjs";

export const COMPANY_BACKGROUND_VERSION = "verified-company-exposure-v3";
const REGISTRY = "https://www.sec.gov/files/company_tickers.json";
const digest = body => createHash("sha256").update(body).digest("hex");
const ANNUAL = new Set(["10-K", "20-F", "40-F"]);

function targets(plan) {
  return [...new Map(plan.anomalies.filter(item => item.kind === "ai_layer").flatMap(anomaly => anomaly.observation.constituents.map(item => [item.symbol, { symbol: item.symbol, anomaly }]))).values()];
}

function receipt(url, opened, now) {
  if (!Buffer.isBuffer(opened.rawBody) || !opened.rawBody.length || opened.rawBody.length > 2 * 1024 * 1024 || opened.finalUrl !== url || opened.status !== 200 || opened.contentType.split(";", 1)[0] !== "application/json") throw new Error("公司身份或申报响应地址、状态、类型或长度不符");
  return { url, finalUrl: opened.finalUrl, status: opened.status, contentType: opened.contentType, bodyBase64: opened.rawBody.toString("base64"), bodyHash: digest(opened.rawBody), fetchedAt: opened.fetchedAt ?? now().toISOString() };
}

function json(receipt, url) {
  if (receipt?.url !== url || receipt.finalUrl !== url || receipt.status !== 200 || typeof receipt.contentType !== "string" || receipt.contentType.split(";", 1)[0] !== "application/json" || !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(receipt.fetchedAt) || !Number.isFinite(Date.parse(receipt.fetchedAt))) throw new Error("公司身份或申报冻结来源不符");
  if (typeof receipt.bodyBase64 !== "string" || receipt.bodyBase64.length > Math.ceil(2 * 1024 * 1024 / 3) * 4) throw new Error("公司身份或申报原文长度无效");
  const body = Buffer.from(receipt.bodyBase64, "base64");
  if (!body.length || body.length > 2 * 1024 * 1024 || body.toString("base64") !== receipt.bodyBase64 || digest(body) !== receipt.bodyHash) throw new Error("公司身份或申报原文字节哈希不符");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function identity(registry, symbol) {
  const matches = Object.values(json(registry, REGISTRY)).filter(item => item.ticker === symbol);
  if (matches.length !== 1 || !Number.isInteger(matches[0].cik_str) || matches[0].cik_str <= 0 || typeof matches[0].title !== "string" || !matches[0].title) throw new Error("官方代码表未唯一确认公司身份");
  return { symbol, cik: String(matches[0].cik_str), name: matches[0].title };
}

function latestAnnual(profile, entity, envelope) {
  const url = `https://data.sec.gov/submissions/CIK${entity.cik.padStart(10, "0")}.json`;
  const value = json(profile, url), recent = value.filings?.recent;
  if (String(Number(value.cik)) !== entity.cik || !Array.isArray(value.tickers) || !value.tickers.includes(entity.symbol) || !recent || !Array.isArray(recent.form) || recent.form.length > 10_000 || ["accessionNumber", "primaryDocument", "acceptanceDateTime"].some(field => !Array.isArray(recent[field]) || recent[field].length !== recent.form.length)) throw new Error("官方申报记录未确认相同发行人、代码或完整申报列");
  const candidates = recent.form.flatMap((form, index) => {
    if (!ANNUAL.has(form) || !/^\d{10}-\d{2}-\d{6}$/u.test(recent.accessionNumber[index]) || !/^[A-Za-z0-9_.-]+\.html?$/u.test(recent.primaryDocument[index])) return [];
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${entity.cik}/${recent.accessionNumber[index].replaceAll("-", "")}/${recent.primaryDocument[index]}`;
    const times = secCompanySubmissionTime(Buffer.from(profile.bodyBase64, "base64"), filingUrl);
    return times.length === 1 && backgroundEvidenceInWindow(times[0], envelope) ? [{ form, url: filingUrl, publishedAt: times[0] }] : [];
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!candidates.length) throw new Error("窗口前没有可核验且未过期的完整年报");
  return candidates[0];
}

function derive(book, envelope, plan, originalCache = new Map()) {
  const sources = [], gaps = [];
  const openedFilings = new Map();
  // Corrupt originals are invalid input, not an ordinary research gap.
  for (const filing of book.filings) {
    const entity = identity(book.registry, filing.symbol);
    const profile = book.profiles.find(item => item.symbol === filing.symbol);
    if (!profile) throw new Error("冻结年报缺少对应官方申报记录");
    const selected = latestAnnual(profile.receipt, entity, envelope);
    // Checkpointing need not parse/segment every unchanged annual again. The
    // key binds all raw bytes and timing receipts; any change reopens it. A
    // standalone validation always starts with a fresh cache.
    const originalKey = stableHash(filing.snapshot);
    let original = originalCache.get(originalKey);
    if (!original) {
      const opened = openedSourceFromSnapshot(filing.snapshot);
      original = { opened, issuer: secFilingIssuerIdentity(opened), quotes: companyExposureExcerpts(opened.text) };
      originalCache.set(originalKey, original);
    }
    const { opened, issuer } = original;
    if (filing.snapshot.source !== selected.url || opened.finalUrl !== selected.url || !issuer || issuer.cik !== entity.cik || issuer.form !== selected.form || !issuer.symbols.includes(filing.symbol) || !opened.publishedAtCandidates.includes(selected.publishedAt)) throw new Error("冻结年报主体、代码、表格或时刻与官方记录不一致");
    openedFilings.set(filing.symbol, original);
  }
  for (const { symbol, anomaly } of targets(plan)) {
    try {
      const entity = identity(book.registry, symbol);
      const profiles = book.profiles.filter(item => item.symbol === symbol);
      if (profiles.length !== 1) throw new Error("尚无该公司的冻结官方申报记录");
      const selected = latestAnnual(profiles[0].receipt, entity, envelope);
      const filings = book.filings.filter(item => item.symbol === symbol);
      if (filings.length !== 1 || filings[0].snapshot.source !== selected.url) throw new Error("尚无对应年报的冻结原文");
      const { opened, issuer, quotes } = openedFilings.get(symbol);
      if (!issuer || issuer.cik !== entity.cik || issuer.form !== selected.form || !issuer.symbols.includes(symbol) || !opened.publishedAtCandidates.includes(selected.publishedAt)) throw new Error("年报主体、上市代码、表格或受理时刻未与官方记录一致");
      if (!quotes.length) throw new Error("年报中没有完整可核验的自身传导披露句子");
      for (const quote of quotes) sources.push({ originalUrl: selected.url, sourceLabel: "SEC", title: `${issuer.name}: disclosed business and financing risks`, publishedAt: selected.publishedAt, kind: "background", supportingExcerpt: quote, facts: "公司此前披露了涉及经营、需求、成本或融资条件的风险说明，具体影响取决于业务及财务项目和合同条款。", scope: "company", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[1].id], causalConnection: false, comparisons: [], role: "facts", anomalyId: anomaly.id });
    } catch (error) { gaps.push({ symbol, reason: error.message }); }
  }
  return { sources, gaps };
}

export function validateRecapCompanyBackgroundData(book, envelope, plan) {
  if (book?.version !== COMPANY_BACKGROUND_VERSION || book.market !== envelope.market || book.marketAsOf !== envelope.marketAsOf || !Array.isArray(book.profiles) || !Array.isArray(book.filings) || !Array.isArray(book.sources) || !Array.isArray(book.gaps) || book.profiles.length > 32 || book.filings.length > 32 || new Set(book.profiles.map(item => item.symbol)).size !== book.profiles.length || new Set(book.filings.map(item => item.symbol)).size !== book.filings.length) throw new Error("公司敞口冻结输入的版本、日期或结构无效");
  const bytes = book.filings.reduce((total, item) => total + Buffer.byteLength(item.snapshot.bodyBase64 ?? "", "base64"), 0);
  if (bytes > 96 * 1024 * 1024) throw new Error("公司敞口原文字节超过上限");
  const expected = targets(plan).map(item => item.symbol);
  if ([...book.profiles, ...book.filings].some(item => !expected.includes(item.symbol))) throw new Error("公司敞口包含计划外公司");
  if (book.failures !== undefined && (!Array.isArray(book.failures) || book.failures.length > 128 || book.failures.some(item => !expected.includes(item.symbol) || typeof item.reason !== "string" || !item.reason || typeof item.url !== "string" || (envelope.market === "US" && !/^https:\/\/(?:www|data)\.sec\.gov\//u.test(item.url)) || !Number.isFinite(Date.parse(item.observedAt))))) throw new Error("公司敞口访问失败记录无效");
  if (envelope.market === "CN") return validateCnCompanyBackgroundData(book, envelope, plan);
  if (envelope.market !== "US") {
    if (book.registry || book.profiles.length || book.filings.length || book.sources.length || book.gaps.length || book.failures?.length) throw new Error("中国市场不能套用美国公司的敞口记录");
    return book;
  }
  if (!book.registry) {
    if (book.profiles.length || book.filings.length || book.sources.length || stableHash(book.gaps.map(item => item.symbol)) !== stableHash(expected) || book.gaps.some(item => typeof item.reason !== "string" || !item.reason)) throw new Error("官方公司身份不可用的缺口不完整");
    return book;
  }
  const derived = derive(book, envelope, plan);
  if (stableHash(derived.sources) !== stableHash(book.sources) || stableHash(derived.gaps) !== stableHash(book.gaps)) throw new Error("公司敞口无法从冻结身份、申报和年报原文重建");
  return book;
}

export function companyBackgroundSourceReader(book, fallback = readExternalSource) {
  const filings = new Map(book.filings.map(item => [item.snapshot.source, item.snapshot]));
  const cache = new Map();
  return async (url, options) => {
    if (!filings.has(url)) return fallback(url, options);
    if (!cache.has(url)) cache.set(url, openedSourceFromSnapshot(filings.get(url)));
    return cache.get(url);
  };
}

export async function collectRecapCompanyBackgroundData(envelope, plan, { reader = readExternalSource, now = () => new Date(), signal, onCheckpoint, resumeBook = null } = {}) {
  const book = resumeBook ? validateRecapCompanyBackgroundData(structuredClone(resumeBook), envelope, plan) : { version: COMPANY_BACKGROUND_VERSION, market: envelope.market, marketAsOf: envelope.marketAsOf, registry: null, profiles: [], filings: [], sources: [], gaps: [] };
  if (envelope.market === "CN") return collectCnCompanyBackgroundData(book, envelope, plan, { reader, now, signal, onCheckpoint });
  if (envelope.market !== "US") return book;
  const requested = targets(plan);
  book.failures ??= [];
  const originalCache = new Map();
  const checkpoint = async () => { Object.assign(book, derive(book, envelope, plan, originalCache)); if (onCheckpoint) await onCheckpoint(book); };
  try { book.registry ??= receipt(REGISTRY, await reader(REGISTRY, { structured: true, signal }), now); }
  catch (error) { book.gaps = requested.map(({ symbol }) => ({ symbol, reason: `官方公司身份不可用：${error.message}` })); return book; }
  for (const { symbol } of requested) {
    if (signal?.aborted) break;
    if (book.filings.some(item => item.symbol === symbol)) continue;
    let requestedUrl = REGISTRY;
    try {
      const entity = identity(book.registry, symbol);
      const url = `https://data.sec.gov/submissions/CIK${entity.cik.padStart(10, "0")}.json`;
      requestedUrl = url;
      const profile = book.profiles.find(item => item.symbol === symbol)?.receipt ?? receipt(url, await reader(url, { structured: true, signal }), now);
      const selected = latestAnnual(profile, entity, envelope);
      if (!book.profiles.some(item => item.symbol === symbol)) book.profiles.push({ symbol, receipt: profile });
      requestedUrl = selected.url;
      const opened = await reader(selected.url, { includeRaw: true, lookupPublicationMetadata: false, maxBytes: 8 * 1024 * 1024, signal });
      if (opened.finalUrl !== selected.url) throw new Error("年报原文地址发生不支持的跳转");
      const issuer = secFilingIssuerIdentity(opened);
      if (!issuer || issuer.cik !== entity.cik || issuer.form !== selected.form || !issuer.symbols.includes(symbol)) throw new Error("年报主体、上市代码或表格未与官方记录一致");
      const direct = opened.publishedAtCandidates ?? [];
      if (direct.length && !direct.includes(selected.publishedAt)) throw new Error("原文发布时间与相应官方申报受理时刻不一致");
      const original = { ...opened, publishedAtCandidates: [selected.publishedAt], metadataReceipts: direct.length ? opened.metadataReceipts ?? [] : [{ finalUrl: secCompanySubmissionsUrl(selected.url), status: profile.status, contentType: profile.contentType, rawBody: Buffer.from(profile.bodyBase64, "base64") }] };
      const snapshot = snapshotFromOpenedSource(selected.url, original, opened.fetchedAt ?? now().toISOString());
      if (book.filings.reduce((sum, item) => sum + Buffer.byteLength(item.snapshot.bodyBase64, "base64"), 0) + opened.rawBody.length > 96 * 1024 * 1024) throw new Error("公司敞口原文字节超过上限");
      book.filings.push({ symbol, snapshot });
    } catch (error) { book.failures.push({ symbol, url: requestedUrl, reason: error.message, observedAt: now().toISOString() }); }
    await checkpoint();
  }
  await checkpoint();
  return validateRecapCompanyBackgroundData(book, envelope, plan);
}
