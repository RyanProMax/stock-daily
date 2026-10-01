import { JSDOM } from "jsdom";
import { stableHash } from "./daily-workflow-core.mjs";
import { decodeSourceBody, readExternalSource } from "./daily-source-audit.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource } from "./evidence-source-snapshots.mjs";
import { chinaPmiDocument, deriveChinaPmiContext } from "./china-pmi-release.mjs";

export const CHINA_PMI_DATA_VERSION = "verified-nbs-pmi-book-v1";
export const CHINA_PMI_INDEX = "https://www.stats.gov.cn/sj/zxfb/";
export const CHINA_PMI_INTERPRETATION_INDEX = "https://www.stats.gov.cn/sj/sjjd/";
const columns = new Map([[CHINA_PMI_INDEX, "数据发布"], [CHINA_PMI_INTERPRETATION_INDEX, "数据解读"]]);
const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
const indexBase = source => source.endsWith("/index_1.html") ? source.slice(0, -"index_1.html".length) : source;
const indexGroup = (book, root) => book.indexes.filter(item => indexBase(item.source) === root);
const groupEntries = (book, root, envelope) => indexGroup(book, root).flatMap(snapshot => chinaPmiIndexEntries(snapshot, envelope)).sort((a, b) => b.date.localeCompare(a.date));
const documentIndex = (book, root, url, envelope) => indexGroup(book, root).find(snapshot => chinaPmiIndexEntries(snapshot, envelope).some(item => item.url === url));

export function unavailableChinaPmiData(marketAsOf, reason) {
  return { version: CHINA_PMI_DATA_VERSION, marketAsOf, indexes: [], release: null, interpretation: null, context: null, gaps: [{ stage: "release_index", url: CHINA_PMI_INDEX, reason }] };
}

function original(snapshot, envelope) {
  const opened = openedSourceFromSnapshot(snapshot);
  if (opened.status !== 200 || opened.finalUrl !== snapshot.source || !/^text\/html(?:;|$)/iu.test(opened.contentType) || Buffer.byteLength(opened.rawBody) > 1024 * 1024 || Date.parse(snapshot.fetchedAt) < Date.parse(envelope.session.windowEnd)) throw new Error("统计局 PMI 原文地址、状态、类型、长度或采集时点不符");
  return opened;
}

export function chinaPmiIndexEntries(snapshot, envelope) {
  const base = indexBase(snapshot.source);
  if (!columns.has(base)) throw new Error("统计局 PMI 目录不是指定官方入口");
  const opened = original(snapshot, envelope), document = new JSDOM(decodeSourceBody(opened.rawBody, opened.contentType)).window.document;
  const meta = [...document.querySelectorAll('meta[name="ColumnName"]')];
  if (meta.length !== 1 || meta[0].content !== columns.get(base)) throw new Error("统计局 PMI 目录栏目不符");
  const entries = new Map();
  for (const anchor of document.querySelectorAll("li > a[href]")) {
    const title = clean(anchor.getAttribute("title") ?? anchor.textContent);
    const match = /^(?:(?:国家统计局服务业调查中心首席统计师[^\d]{2,12}解读))?(20\d{2})年([1-9]|1[0-2])月中国采购经理指数(?:运行情况)?$/u.exec(title);
    if (!match) continue;
    const url = new URL(anchor.getAttribute("href"), snapshot.source);
    const root = new URL(base).pathname;
    if (url.origin !== "https://www.stats.gov.cn" || url.search || url.hash || !url.pathname.startsWith(root) || !/^20\d{4}\/t20\d{6}_[1-9]\d{5,9}\.html$/u.test(url.pathname.slice(root.length))) throw new Error("统计局 PMI 目录链接不属于同一官方栏目");
    const dates = [...anchor.parentElement.querySelectorAll(":scope > span")].map(node => clean(node.textContent)).filter(value => /^20\d{2}-\d{2}-\d{2}$/u.test(value));
    if (dates.length !== 1 || new Date(`${dates[0]}T00:00:00Z`).toISOString().slice(0, 10) !== dates[0]) throw new Error("统计局 PMI 目录日期缺失或重复");
    const entry = { url: url.href, title, date: dates[0], period: `${match[1]}-${match[2].padStart(2, "0")}` };
    if (entries.has(url.href) && stableHash(entries.get(url.href)) !== stableHash(entry)) throw new Error("统计局 PMI 目录同一条目身份不一致");
    entries.set(url.href, entry);
  }
  return [...entries.values()].filter(item => item.date <= envelope.marketAsOf && Date.parse(envelope.marketAsOf) - Date.parse(item.date) <= 45 * 86_400_000).sort((a, b) => b.date.localeCompare(a.date));
}

function boundDocument(snapshot, index, envelope) {
  const opened = original(snapshot, envelope), entry = chinaPmiIndexEntries(index, envelope).find(item => item.url === snapshot.source);
  const record = chinaPmiDocument(decodeSourceBody(opened.rawBody, opened.contentType), snapshot.source);
  if (!record || !entry || record.title !== entry.title || record.publicationDate !== entry.date || record.period !== entry.period || Date.parse(record.publishedAt) > Date.parse(envelope.session.windowEnd)) throw new Error("统计局 PMI 标题、发布时间或正文未与目录绑定，或收盘时尚不可用");
  return record;
}

export function validateRecapChinaPmiData(book, envelope) {
  if (book?.version !== CHINA_PMI_DATA_VERSION || envelope.market !== "CN" || book.marketAsOf !== envelope.marketAsOf || !Array.isArray(book.indexes) || book.indexes.length > 4 || new Set(book.indexes.map(item => item.source)).size !== book.indexes.length || !Array.isArray(book.gaps) || book.gaps.length > 4 || book.gaps.some(item => !["release_index", "release", "interpretation_index", "interpretation"].includes(item.stage) || typeof item.reason !== "string" || !item.reason || item.reason.length > 300 || typeof item.url !== "string" || !item.url.startsWith("https://www.stats.gov.cn/"))) throw new Error("中国 PMI 冻结输入版本、日期或缺口无效");
  book.indexes.forEach(snapshot => chinaPmiIndexEntries(snapshot, envelope));
  for (const snapshot of book.indexes.filter(item => item.source !== indexBase(item.source))) {
    const root = book.indexes.find(item => item.source === indexBase(snapshot.source));
    const html = root ? decodeSourceBody(original(root, envelope).rawBody, root.contentType) : "";
    if (!/createPageHTML\((?:[2-9]|\d{2,4}),\s*0,\s*"index",\s*"html"\)/u.test(html) || chinaPmiIndexEntries(root, envelope).length) throw new Error("统计局第二页目录没有绑定首页分页记录或跳过了可用首页条目");
  }
  const index = book.release ? documentIndex(book, CHINA_PMI_INDEX, book.release.source, envelope) : book.indexes.find(item => item.source === CHINA_PMI_INDEX);
  const interpretationIndex = book.interpretation ? documentIndex(book, CHINA_PMI_INTERPRETATION_INDEX, book.interpretation.source, envelope) : null;
  if (!book.release) {
    if (book.context !== null || book.interpretation || !book.gaps.some(item => ["release_index", "release"].includes(item.stage))) throw new Error("中国 PMI 缺失必须保留明确缺口，不能伪造数据");
    return book;
  }
  if (!index || book.gaps.some(item => ["release_index", "release"].includes(item.stage))) throw new Error("中国 PMI 发布页缺少绑定目录或与失败状态矛盾");
  const release = boundDocument(book.release, index, envelope);
  if (groupEntries(book, CHINA_PMI_INDEX, envelope)[0]?.url !== book.release.source) throw new Error("中国 PMI 不能跳过更新的目录条目而使用旧值");
  const interpretation = book.interpretation ? boundDocument(book.interpretation, interpretationIndex, envelope) : null;
  if ((interpretation && book.gaps.some(item => ["interpretation_index", "interpretation"].includes(item.stage))) || (!interpretation && !book.gaps.some(item => ["interpretation_index", "interpretation"].includes(item.stage)))) throw new Error("中国 PMI 解读状态与缺口不一致");
  const derived = { ...deriveChinaPmiContext(release, interpretation), source: book.release.source, interpretationSource: book.interpretation?.source ?? null };
  if (stableHash(derived) !== stableHash(book.context)) throw new Error("中国 PMI 不能由冻结目录、正文和数据表重建");
  return book;
}

export async function collectRecapChinaPmiData(envelope, { reader = readExternalSource, now = () => new Date(), signal } = {}) {
  const book = { version: CHINA_PMI_DATA_VERSION, marketAsOf: envelope.marketAsOf, indexes: [], release: null, interpretation: null, context: null, gaps: [] };
  const read = async url => {
    const opened = await reader(url, { includeRaw: true, lookupPublicationMetadata: false, maxBytes: 1024 * 1024, signal: signal ?? AbortSignal.timeout(30_000) });
    const snapshot = snapshotFromOpenedSource(url, opened, opened.fetchedAt ?? now().toISOString());
    original(snapshot, envelope); return snapshot;
  };
  const readIndexes = async root => {
    const index = await read(root); const entries = chinaPmiIndexEntries(index, envelope); book.indexes.push(index);
    if (!entries.length) {
      const html = decodeSourceBody(Buffer.from(index.bodyBase64, "base64"), index.contentType);
      if (/createPageHTML\((?:[2-9]|\d{2,4}),\s*0,\s*"index",\s*"html"\)/u.test(html)) {
        const second = await read(`${root}index_1.html`); chinaPmiIndexEntries(second, envelope); book.indexes.push(second);
      }
    }
  };
  try {
    await readIndexes(CHINA_PMI_INDEX);
  } catch (error) { book.gaps.push({ stage: "release_index", url: CHINA_PMI_INDEX, reason: String(error.message).slice(0, 300) }); }
  const entry = groupEntries(book, CHINA_PMI_INDEX, envelope)[0];
  const index = entry ? documentIndex(book, CHINA_PMI_INDEX, entry.url, envelope) : book.indexes.find(item => item.source === CHINA_PMI_INDEX);
  if (index && !book.gaps.some(item => item.stage === "release_index")) {
    try {
      if (!entry) throw new Error("官方目录中没有收盘前近期的 PMI 发布条目");
      const snapshot = await read(entry.url), release = boundDocument(snapshot, index, envelope);
      deriveChinaPmiContext(release); book.release = snapshot;
    } catch (error) { book.gaps.push({ stage: "release", url: entry?.url ?? CHINA_PMI_INDEX, reason: String(error.message).slice(0, 300) }); }
  }
  if (book.release) {
    try { await readIndexes(CHINA_PMI_INTERPRETATION_INDEX); }
    catch (error) { book.gaps.push({ stage: "interpretation_index", url: CHINA_PMI_INTERPRETATION_INDEX, reason: String(error.message).slice(0, 300) }); }
    const release = boundDocument(book.release, index, envelope);
    if (!book.gaps.some(item => item.stage === "interpretation_index")) {
      const match = groupEntries(book, CHINA_PMI_INTERPRETATION_INDEX, envelope).filter(item => item.period === release.period && item.date === release.publicationDate);
      try {
        if (match.length !== 1) throw new Error("官方目录未唯一定位同月同日的 PMI 解读");
        const snapshot = await read(match[0].url), record = boundDocument(snapshot, documentIndex(book, CHINA_PMI_INTERPRETATION_INDEX, match[0].url, envelope), envelope);
        deriveChinaPmiContext(release, record); book.interpretation = snapshot;
      } catch (error) { book.gaps.push({ stage: "interpretation", url: match[0]?.url ?? CHINA_PMI_INTERPRETATION_INDEX, reason: String(error.message).slice(0, 300) }); }
    }
    book.context = { ...deriveChinaPmiContext(release, book.interpretation ? boundDocument(book.interpretation, documentIndex(book, CHINA_PMI_INTERPRETATION_INDEX, book.interpretation.source, envelope), envelope) : null), source: book.release.source, interpretationSource: book.interpretation?.source ?? null };
  }
  return validateRecapChinaPmiData(book, envelope);
}

export function chinaPmiSourceReader(book, fallback = readExternalSource) {
  const snapshots = new Map([book?.release, book?.interpretation].filter(Boolean).map(item => [item.source, item]));
  const cache = new Map();
  return async (url, options) => {
    if (!snapshots.has(url)) return fallback(url, options);
    if (!cache.has(url)) cache.set(url, openedSourceFromSnapshot(snapshots.get(url)));
    return cache.get(url);
  };
}

export function chinaPmiResearchSources(book, envelope, plan) {
  if (!book) return [];
  validateRecapChinaPmiData(book, envelope);
  if (!book.context || Date.parse(book.context.publishedAt) < Date.parse(envelope.session.windowStart) - 72 * 3_600_000) return [];
  const anomaly = plan.anomalies.find(item => item.kind === "market");
  if (!anomaly) throw new Error("PMI 公共事件缺少市场调查目标");
  return [book.release, book.interpretation].filter(Boolean).flatMap(snapshot => {
    const record = chinaPmiDocument(decodeSourceBody(Buffer.from(snapshot.bodyBase64, "base64"), snapshot.contentType), snapshot.source);
    const passages = record.interpretation ? book.context.interpretationPassages : book.context.releasePassages;
    return passages.map(quote => ({ originalUrl: snapshot.source, sourceLabel: "国家统计局", title: record.title, publishedAt: record.publishedAt, kind: "official", supportingExcerpt: quote, facts: quote, scope: "event_only", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [], role: "facts", anomalyId: anomaly.id }));
  });
}
