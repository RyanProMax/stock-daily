import { JSDOM } from "jsdom";
import { stableHash } from "./daily-workflow-core.mjs";
import { decodeSourceBody, normalizedEvidenceText, readExternalSource } from "./daily-source-audit.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource } from "./evidence-source-snapshots.mjs";
import { pbocDocumentIdentity, pbocDocumentRecord } from "./pboc-document.mjs";

export const PBOC_NEWS_DATA_VERSION = "verified-pboc-news-book-v1";
export const PBOC_NEWS_HOME = "https://www.pbc.gov.cn/";
const MAX_ARTICLES = 8;
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const key = value => clean(value).replace(/\s+/gu, "");
const start = envelope => Date.parse(envelope.session.windowStart) - 72 * 3_600_000;
const end = envelope => Date.parse(envelope.session.windowEnd);
const policy = title => /政策|金融支持|货币政策|贴息|贷款|指导意见/u.test(title);
const initialBook = envelope => ({ version: PBOC_NEWS_DATA_VERSION, market: envelope.market, marketAsOf: envelope.marketAsOf, completed: false, index: null, articles: [], gaps: [] });

function original(snapshot, envelope) {
  const opened = openedSourceFromSnapshot(snapshot);
  if (opened.status !== 200 || opened.finalUrl !== snapshot.source || !/^text\/html(?:;|$)/iu.test(opened.contentType) || opened.rawBody.length > 1024 * 1024 || typeof snapshot.fetchedAt !== "string" || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || Date.parse(snapshot.fetchedAt) < end(envelope) || opened.metadataReceipts.length) throw new Error("央行原文地址、状态、类型、大小或收盘后采集记录不符");
  return opened;
}

// The native homepage supplies discovery links and titles, never publication
// clocks. Its update time and numeric article paths are not article timestamps.
export function pbocNewsIndexEntries(snapshot, envelope) {
  if (snapshot?.source !== PBOC_NEWS_HOME) throw new Error("央行新闻目录不是指定官方首页");
  const opened = original(snapshot, envelope), document = new JSDOM(decodeSourceBody(opened.rawBody, opened.contentType)).window.document;
  for (const [name, value] of [["SiteName", "中国人民银行"], ["SiteIDCode", "rmyh"], ["ColumnName", "首页"], ["ColumnType", "工作动态"]]) {
    const nodes = [...document.head.querySelectorAll(`meta[name="${name}"]`)];
    if (nodes.length !== 1 || nodes[0].content !== value) throw new Error("央行首页身份或栏目无法绑定");
  }
  const clone = document.body.cloneNode(true); clone.querySelectorAll("script,style,noscript").forEach(node => node.remove());
  if (!/网站标识码：\s*bm25000001/u.test(clone.textContent) || !/网站主办单位：中国人民银行办公厅/u.test(clone.textContent)) throw new Error("央行首页主办单位或网站标识不符");
  const entries = new Map(), discovered = new Set();
  for (const anchor of clone.querySelectorAll("a[href]")) {
    let url; try { url = new URL(anchor.getAttribute("href"), PBOC_NEWS_HOME).href; } catch { continue; }
    const identity = pbocDocumentIdentity(url);
    if (!identity) continue;
    // Calendar bounds only avoid irrelevant requests. The owned article's
    // precise Beijing clock independently determines session eligibility.
    const earliest = new Date(start(envelope) + 8 * 3_600_000).toISOString().slice(0, 10);
    if (identity.publicationDate < earliest || identity.publicationDate > envelope.marketAsOf) continue;
    discovered.add(url);
    const title = clean(anchor.getAttribute("title") || anchor.textContent);
    if (!title || /\.\.\.|…/u.test(title)) continue;
    if (entries.has(url) && key(entries.get(url).title) !== key(title)) throw new Error("央行首页同一新闻链接存在冲突的完整标题");
    entries.set(url, { url, title, date: identity.publicationDate });
  }
  if ([...discovered].some(url => !entries.has(url))) throw new Error("央行首页近期新闻缺少可绑定的完整标题，不能静默遗漏");
  return [...entries.values()].sort((a, b) => b.date.localeCompare(a.date) || a.url.localeCompare(b.url));
}

function boundDocument(snapshot, index, envelope) {
  const opened = original(snapshot, envelope), entry = pbocNewsIndexEntries(index, envelope).find(item => item.url === snapshot.source);
  const record = pbocDocumentRecord(decodeSourceBody(opened.rawBody, opened.contentType), snapshot.source);
  if (!entry || !record || key(record.title) !== key(entry.title)) throw new Error("央行新闻原文标题、正文或发布时间未与官方首页绑定");
  return record;
}

export function validateRecapPbocNewsData(book, envelope, { allowPartial = false } = {}) {
  if (book?.version !== PBOC_NEWS_DATA_VERSION || book.market !== envelope.market || book.marketAsOf !== envelope.marketAsOf || typeof book.completed !== "boolean" || (!allowPartial && !book.completed) || !Array.isArray(book.articles) || book.articles.length > MAX_ARTICLES || new Set(book.articles.map(item => item.source)).size !== book.articles.length || !Array.isArray(book.gaps) || book.gaps.length > MAX_ARTICLES + 2 || new Set(book.gaps.map(item => `${item.stage}:${item.url}`)).size !== book.gaps.length || book.gaps.some(item => !["index", "article", "capacity"].includes(item.stage) || typeof item.reason !== "string" || !item.reason || item.reason.length > 300)) throw new Error("央行新闻冻结输入版本、市场、日期、完成状态或缺口无效");
  if (envelope.market !== "CN") {
    if (!book.completed || book.index !== null || book.articles.length || book.gaps.length) throw new Error("非中国市场不能混入央行新闻采集");
    return book;
  }
  if (book.index === null) {
    if (book.articles.length || book.gaps.some(item => item.stage !== "index" || item.url !== PBOC_NEWS_HOME) || (book.completed && book.gaps.length !== 1)) throw new Error("央行目录缺失不能伪造新闻或隐藏失败");
    return book;
  }
  const all = pbocNewsIndexEntries(book.index, envelope), selected = all.slice(0, MAX_ARTICLES);
  if (book.gaps.some(item => item.stage === "index" || (item.stage === "capacity" && item.url !== PBOC_NEWS_HOME) || (item.stage === "article" && (!selected.some(entry => entry.url === item.url) || book.articles.some(snapshot => snapshot.source === item.url))))) throw new Error("央行目录与新闻失败状态矛盾");
  if (book.gaps.filter(item => item.stage === "capacity").length !== Number(all.length > MAX_ARTICLES)) throw new Error("央行新闻请求上限必须保留明确的未覆盖记录");
  const articlePositions = book.articles.map(snapshot => selected.findIndex(entry => entry.url === snapshot.source));
  if (articlePositions.some((position, i) => i > 0 && position <= articlePositions[i - 1])) throw new Error("央行冻结新闻未保持确定性目录顺序");
  for (const snapshot of book.articles) {
    if (!selected.some(entry => entry.url === snapshot.source)) throw new Error("央行新闻跳过了确定性目录顺序或超出请求上限");
    boundDocument(snapshot, book.index, envelope);
  }
  if (book.completed && selected.some(entry => !book.articles.some(snapshot => snapshot.source === entry.url) && !book.gaps.some(item => item.stage === "article" && item.url === entry.url))) throw new Error("央行新闻完成状态遗漏了目录中的未读取条目");
  return book;
}

export async function collectRecapPbocNewsData(envelope, { reader = readExternalSource, now = () => new Date(), signal, resumeBook, onCheckpoint } = {}) {
  const book = resumeBook ? structuredClone(validateRecapPbocNewsData(resumeBook, envelope, { allowPartial: true })) : initialBook(envelope);
  if (book.completed) return book;
  const checkpoint = async () => { validateRecapPbocNewsData(book, envelope, { allowPartial: true }); if (onCheckpoint) await onCheckpoint(structuredClone(book)); };
  const read = async url => {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(30_000);
    const opened = await reader(url, { includeRaw: true, lookupPublicationMetadata: false, maxBytes: 1024 * 1024, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const snapshot = snapshotFromOpenedSource(url, opened, opened.fetchedAt ?? now().toISOString());
    original(snapshot, envelope); return snapshot;
  };
  if (envelope.market === "CN") {
    if (!book.index && !book.gaps.length) {
      try {
        const snapshot = await read(PBOC_NEWS_HOME), entries = pbocNewsIndexEntries(snapshot, envelope);
        book.index = snapshot;
        if (entries.length > MAX_ARTICLES) book.gaps.push({ stage: "capacity", url: PBOC_NEWS_HOME, reason: `官方首页有${entries.length}条近期新闻，本次按日期及原文地址顺序读取前${MAX_ARTICLES}条；其余条目未读取。` });
      } catch (error) { signal?.throwIfAborted(); book.gaps.push({ stage: "index", url: PBOC_NEWS_HOME, reason: String(error.message).slice(0, 300) }); }
      await checkpoint();
    }
    for (const entry of book.index ? pbocNewsIndexEntries(book.index, envelope).slice(0, MAX_ARTICLES) : []) {
      if (book.articles.some(snapshot => snapshot.source === entry.url) || book.gaps.some(item => item.stage === "article" && item.url === entry.url)) continue;
      try { const snapshot = await read(entry.url); boundDocument(snapshot, book.index, envelope); book.articles.push(snapshot); }
      catch (error) { signal?.throwIfAborted(); book.gaps.push({ stage: "article", url: entry.url, reason: String(error.message).slice(0, 300) }); }
      await checkpoint();
    }
  }
  book.completed = true;
  await checkpoint();
  return validateRecapPbocNewsData(book, envelope);
}

// A complete owned announcement or its complete pre-attachment synopsis may
// seed a fact. Never truncate a long policy or manufacture terms from its title.
function announcement(record) {
  const body = record.text.slice(record.title.length + 1);
  if (!policy(record.title)) return { body, quote: null, scope: "not_policy" };
  if (body.length >= 24 && body.length <= 700) return { body, quote: body, scope: "complete_announcement" };
  const boundaries = [...body.matchAll(/\n附件：\n/gu)];
  const synopsis = boundaries.length === 1 ? body.slice(0, boundaries[0].index) : "";
  if (synopsis.length >= 24 && synopsis.length <= 700 && /[。！？]$/u.test(synopsis)) return { body, quote: synopsis, scope: "complete_announcement_synopsis" };
  return { body, quote: null, scope: "no_complete_excerpt_within_limit" };
}

export function pbocNewsResearchContext(book, envelope) {
  validateRecapPbocNewsData(book, envelope);
  let remaining = 64_000;
  return { gaps: book.gaps, coverage: "Bounded discovery of this frozen PBOC homepage's recent native news links; not an exhaustive policy search.", articles: book.articles.flatMap(snapshot => {
    const record = boundDocument(snapshot, book.index, envelope), publishedAt = record.publishedAtCandidates[0];
    if (Date.parse(publishedAt) < start(envelope) || Date.parse(publishedAt) > end(envelope) || !policy(record.title)) return [];
    const item = announcement(record), includeBody = item.body.length <= 20_000 && item.body.length <= remaining;
    if (includeBody) remaining -= item.body.length;
    return [{ url: snapshot.source, title: record.title, publishedAt, factScope: item.scope, announcementExcerpt: item.quote, fullOwnedBody: includeBody ? item.body : null, bodyAvailability: includeBody ? "complete_owned_body" : "frozen_original_only_above_context_limit", limitations: "A published policy fact, not proof of implementation, constituent exposure or a price cause. A synopsis covers the announcement only; inspect the complete attached terms separately." }];
  }) };
}

export function pbocNewsResearchSources(book, envelope, plan) {
  const context = pbocNewsResearchContext(book, envelope), anomaly = plan.anomalies.find(item => item.kind === "market");
  if (!anomaly && context.articles.length) throw new Error("央行公共事件缺少市场调查目标");
  return context.articles.filter(item => item.announcementExcerpt).map(item => ({ originalUrl: item.url, sourceLabel: "中国人民银行", title: item.title, publishedAt: item.publishedAt, kind: "official", supportingExcerpt: item.announcementExcerpt, facts: item.announcementExcerpt, scope: "event_only", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [], role: "facts", anomalyId: anomaly.id }));
}

export function pbocNewsSourceReader(book, fallback = readExternalSource) {
  const snapshots = new Map((book?.articles ?? []).map(item => [item.source, item])), cache = new Map();
  return async (url, options) => {
    if (!snapshots.has(url)) return fallback(url, options);
    if (!cache.has(url)) cache.set(url, openedSourceFromSnapshot(snapshots.get(url)));
    return cache.get(url);
  };
}

export function auditRecapPbocNewsSources(book, envelope, plan, ledger, sourceSnapshots) {
  for (const seed of pbocNewsResearchSources(book, envelope, plan)) {
    const original = book.articles.find(item => item.source === seed.originalUrl), replay = sourceSnapshots.snapshots.find(item => item.source === seed.originalUrl);
    if (!replay || replay.bodyHash !== original.bodyHash || replay.finalUrl !== original.finalUrl || replay.contentType !== original.contentType || replay.metadataReceipts?.length || !ledger.sources.some(item => item.url === seed.originalUrl && item.role === "facts" && item.kind === "official" && item.scope === "event_only" && stableHash(item.targets) === stableHash(seed.targets) && normalizedEvidenceText(item.supportingExcerpt) === normalizedEvidenceText(seed.supportingExcerpt))) throw new Error("央行新闻种子未由相同冻结原文进入已验证事实账本");
  }
}
