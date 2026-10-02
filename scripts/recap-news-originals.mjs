import { stableHash } from "./daily-workflow-core.mjs";
import { decodeSourceBody, readExternalSource } from "./daily-source-audit.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource } from "./evidence-source-snapshots.mjs";
import { yahooLiveArticleRecord } from "./yahoo-live-article.mjs";
import { assertAccessibleOriginalArticle, assertSessionClosingClaims } from "./source-session-integrity.mjs";
import { sourceEvidenceDeadline } from "./evidence-timing.mjs";

export const NEWS_ORIGINALS_VERSION = "recap-news-originals-v1";

export function recapNewsOriginalsContext(book, envelope, leads) {
  if (book?.version !== NEWS_ORIGINALS_VERSION || book.market !== envelope.market || book.marketAsOf !== envelope.marketAsOf || book.leadsHash !== stableHash(leads) || !Array.isArray(book.snapshots) || !Array.isArray(book.accessFailures) || book.snapshots.length > 8 || book.accessFailures.length > 8 || new Set(book.snapshots.map(s => s.source)).size !== book.snapshots.length) throw new Error("新闻原件的版本、交易日或输入线索不一致");
  const allowed = new Set(leads.map(lead => lead.url));
  if ([...book.snapshots.map(s => s.source), ...book.accessFailures.map(s => s.url)].some(url => !allowed.has(url))) throw new Error("新闻原件包含未冻结的地址");
  const sources = [], gaps = [];
  for (const snapshot of book.snapshots) {
    // Broken bytes are invalid input, not ordinary unavailable reporting.
    const opened = openedSourceFromSnapshot(snapshot);
    try {
      const record = yahooLiveArticleRecord(decodeSourceBody(opened.rawBody, opened.contentType), opened.finalUrl);
      if (!record || !record.origin.identified || record.ownedBody.length < 80 || record.ownedBody.length > 12_000) throw new Error("没有可绑定的完整文章正文、署名或版本");
      const time = Date.parse(record.currentVersionAt);
      if (time < Date.parse(envelope.session.windowEnd) || time > sourceEvidenceDeadline("market_wrap", envelope.session) || time > Date.parse(snapshot.fetchedAt)) throw new Error("文章当前版本不在有效收盘报道窗口内");
      assertAccessibleOriginalArticle(opened);
      assertSessionClosingClaims(opened.text, envelope, record.currentVersionAt);
      sources.push({ url: snapshot.source, title: record.title, publishedAt: record.currentVersionAt, initialPublishedAt: record.initialPublishedAt, reportingOrigin: record.origin.key, bodyHash: snapshot.bodyHash, fetchedAt: snapshot.fetchedAt, originalText: record.ownedBody });
    } catch (error) { gaps.push({ url: snapshot.source, reason: error.message }); }
  }
  for (const failure of book.accessFailures) {
    if (typeof failure.reason !== "string" || !failure.reason.trim() || !Number.isFinite(Date.parse(failure.fetchedAt))) throw new Error("新闻原件访问失败记录无效");
    gaps.push({ url: failure.url, reason: failure.reason });
  }
  return { sources, gaps };
}

export async function collectRecapNewsOriginals(envelope, leads, { reader = readExternalSource, now = () => new Date(), signal } = {}) {
  if (!Array.isArray(leads) || leads.length > 8 || new Set(leads.map(lead => lead.url)).size !== leads.length) throw new Error("新闻原件线索数量或地址无效");
  const book = { version: NEWS_ORIGINALS_VERSION, market: envelope.market, marketAsOf: envelope.marketAsOf, leadsHash: stableHash(leads), snapshots: [], accessFailures: [] };
  // Stable order makes the same bounded input reproducible. These HTTP reads
  // consume no native search queries and produce no accepted event facts.
  for (const lead of leads) {
    signal?.throwIfAborted();
    try {
      const opened = await reader(lead.url, { includeRaw: true, signal });
      book.snapshots.push(snapshotFromOpenedSource(lead.url, opened, opened.fetchedAt ?? now().toISOString()));
    } catch (error) {
      signal?.throwIfAborted();
      book.accessFailures.push({ url: lead.url, reason: error.message, fetchedAt: now().toISOString() });
    }
  }
  recapNewsOriginalsContext(book, envelope, leads);
  return book;
}

export function recapNewsOriginalsSourceReader(book, fallback = readExternalSource) {
  const originals = new Map(book.snapshots.map(snapshot => [snapshot.source, snapshot]));
  const cache = new Map();
  return async (url, options) => {
    if (!originals.has(url)) return fallback(url, options);
    if (!cache.has(url)) cache.set(url, openedSourceFromSnapshot(originals.get(url)));
    return cache.get(url);
  };
}
