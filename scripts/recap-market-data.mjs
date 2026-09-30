import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stableHash } from "./daily-workflow-core.mjs";

const execFileAsync = promisify(execFile);
const DAY = 86_400_000;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const percent = value => Number(value.toFixed(6));
const dateInMarket = (time, market) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: market === "CN" ? "Asia/Shanghai" : "America/New_York" }).format(new Date(time));

export function tradingRequests(envelope) {
  const benchmark = envelope.markets.find(item => item.symbol === (envelope.market === "CN" ? "SSE" : "SPX"));
  if (!benchmark) throw new Error("复盘缺少基准行情");
  const metrics = [benchmark, ...envelope.sectorPerformance, ...envelope.aiChainPerformance.flatMap(item => item.constituents ?? []), ...envelope.sectorPerformance.flatMap(item => item.constituents ?? [])];
  return [...new Map(metrics.map(item => [item.symbol, {
    symbol: item.symbol,
    quoteSymbol: item.symbol === "SPX" ? "^GSPC" : item.symbol === "SSE" ? "000001.SS" : envelope.market === "CN" && /^\d{6}$/u.test(item.symbol) ? item.symbol + ".SS" : item.symbol,
    expectedReturn: Number(item.change.replace("%", "")),
    expectedClose: item.value ? Number(item.value.replaceAll(",", "")) : null,
  }])).values()];
}

export function parseTradingSnapshot(snapshot, request, envelope) {
  const url = new URL(snapshot.url);
  if (url.protocol !== "https:" || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || Date.parse(snapshot.fetchedAt) < Date.parse(envelope.session.windowEnd) || snapshot.payloadHash !== stableHash(snapshot.payload)) throw new Error(request.symbol + " 行情原文与来源不匹配或尚未收盘");
  let inputRows, source, sourceLabel, currency = null;
  if (["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(url.hostname) && decodeURIComponent(url.pathname) === "/v8/finance/chart/" + request.quoteSymbol && url.searchParams.get("interval") === "1d") {
    const result = snapshot.payload?.chart?.result?.[0];
    if (result?.meta?.symbol !== request.quoteSymbol) throw new Error(request.symbol + " 返回标的不一致");
    const quote = result.indicators?.quote?.[0];
    inputRows = (result.timestamp ?? []).map((timestamp, index) => ({
      date: dateInMarket(timestamp * 1000, envelope.market),
      open: quote?.open?.[index], high: quote?.high?.[index], low: quote?.low?.[index], close: quote?.close?.[index], volume: quote?.volume?.[index],
    }));
    source = "https://finance.yahoo.com/quote/" + encodeURIComponent(request.quoteSymbol) + "/history";
    sourceLabel = "Yahoo Finance";
    currency = result.meta.currency ?? null;
  } else if (envelope.market === "CN" && /^\d{6}$/u.test(request.symbol) && url.hostname === "www.csindex.com.cn" && url.pathname === "/csindex-home/perf/index-perf" && url.searchParams.get("indexCode") === request.symbol) {
    if (snapshot.payload.code !== "200" || !Array.isArray(snapshot.payload.data) || snapshot.payload.data.some(row => row.indexCode !== request.symbol)) throw new Error(request.symbol + " 中证日线标的不一致");
    inputRows = snapshot.payload.data.map(row => ({
      date: String(row.tradeDate).replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3"),
      open: row.open, high: row.high, low: row.low, close: row.close, volume: row.tradingVol,
    }));
    source = "https://www.csindex.com.cn/#/indices/family/detail?indexCode=" + request.symbol;
    sourceLabel = "CSI";
  } else if (envelope.market === "CN" && request.symbol === "SSE" && url.hostname === "web.ifzq.gtimg.cn" && url.pathname === "/appstock/app/fqkline/get" && /^sh000001,day,/u.test(url.searchParams.get("param") ?? "")) {
    const rows = snapshot.payload.data?.sh000001?.day;
    if (!Array.isArray(rows)) throw new Error("上证日线正文缺失");
    inputRows = rows.map(row => ({ date: row[0], open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]), volume: Number(row[5]) }));
    source = "https://gu.qq.com/sh000001/zs";
    sourceLabel = "Tencent Finance";
  } else throw new Error(request.symbol + " 行情来源与标的不匹配");
  const rows = inputRows.filter(item => item.date <= envelope.marketAsOf).sort((a, b) => a.date.localeCompare(b.date));
  if (rows.some(item => !/^\d{4}-\d{2}-\d{2}$/u.test(item.date))) throw new Error(request.symbol + " 日线日期无效");
  if (rows.some(item => ![item.open, item.high, item.low, item.close].every(value => typeof value === "number" && Number.isFinite(value) && value > 0))) throw new Error(request.symbol + " 日线存在缺失价格，不能计算历史基线");
  if (new Set(rows.map(item => item.date)).size !== rows.length || rows.some(item => item.low > Math.min(item.open, item.close) || item.high < Math.max(item.open, item.close) || item.low > item.high)) throw new Error(request.symbol + " 日线重复或高低价无效");
  const latest = rows.at(-1), previous = rows.at(-2);
  if (!latest || !previous || latest.date !== envelope.marketAsOf || previous.date !== envelope.session.previousAsOf) throw new Error(request.symbol + " 行情日期与本期及前一交易日不匹配");
  const closingReturn = (latest.close / previous.close - 1) * 100;
  if (!Number.isFinite(request.expectedReturn) || Math.abs(closingReturn - request.expectedReturn) > 0.010001 || (request.expectedClose !== null && Math.abs(latest.close - request.expectedClose) > 0.010001)) throw new Error(request.symbol + " 日线不能复核已采集的收盘行情");
  const intradayRange = (latest.high - latest.low) / previous.close * 100;
  const prior = rows.slice(1, -1).slice(-20).map(item => {
    const rowIndex = rows.findIndex(row => row.date === item.date);
    return { range: (item.high - item.low) / rows[rowIndex - 1].close * 100, volume: item.volume };
  });
  const baselineRanges = prior.map(item => item.range);
  const baselineVolumes = prior.map(item => item.volume).filter(value => typeof value === "number" && Number.isFinite(value) && value > 0);
  return {
    symbol: request.symbol, asOf: latest.date,
    source, sourceLabel, currency,
    sourceHash: snapshot.payloadHash,
    verifiedAt: snapshot.fetchedAt,
    previousClose: previous.close, open: latest.open, high: latest.high, low: latest.low, close: latest.close,
    closingReturn: percent(closingReturn), intradayRange: percent(intradayRange),
    openingGap: percent((latest.open - previous.close) / previous.close * 100),
    openToClose: percent((latest.close - latest.open) / previous.close * 100),
    volume: typeof latest.volume === "number" && Number.isFinite(latest.volume) && latest.volume > 0 ? latest.volume : null,
    baselineSessions: prior.length,
    rangeVsPrior20Median: prior.length === 20 && median(baselineRanges) > 0 ? percent(intradayRange / median(baselineRanges)) : null,
    volumeVsPrior20Median: prior.length === 20 && baselineVolumes.length === 20 && latest.volume > 0 ? percent(latest.volume / median(baselineVolumes)) : null,
    closingReturnDisplay: closingReturn.toFixed(2) + "%",
    intradayRangeDisplay: intradayRange.toFixed(2) + "%",
    openingGapDisplay: ((latest.open - previous.close) / previous.close * 100).toFixed(2) + "%",
    openToCloseDisplay: ((latest.close - latest.open) / previous.close * 100).toFixed(2) + "%",
    volumeComparisonDisplay: prior.length === 20 && baselineVolumes.length === 20 && latest.volume > 0 ? (latest.volume / median(baselineVolumes)).toFixed(2) + " 倍 (" + (latest.volume / median(baselineVolumes)).toFixed(2) + " times)" : null,
  };
}

export function validateRecapTradingData(book, envelope) {
  if (book.market !== envelope.market || book.marketAsOf !== envelope.marketAsOf || !Array.isArray(book.snapshots) || !Array.isArray(book.gaps)) throw new Error("复盘日线记录日期或结构不一致");
  const requests = new Map(tradingRequests(envelope).map(item => [item.symbol, item]));
  const seen = new Set();
  const entries = book.snapshots.map(snapshot => {
    if (!requests.has(snapshot.symbol) || seen.has(snapshot.symbol)) throw new Error("复盘日线标的未知或重复");
    seen.add(snapshot.symbol);
    return parseTradingSnapshot(snapshot, requests.get(snapshot.symbol), envelope);
  });
  for (const gap of book.gaps) {
    if (!requests.has(gap.symbol) || seen.has(gap.symbol) || typeof gap.reason !== "string" || !gap.reason) throw new Error("复盘日线缺口重复或无效");
    seen.add(gap.symbol);
  }
  if (seen.size !== requests.size || stableHash(entries) !== stableHash(book.entries)) throw new Error("复盘日线派生值被修改或标的有遗漏");
  return book;
}

async function fetchPayload(url) {
  const result = await execFileAsync("curl", ["--fail", "--location", "--silent", "--show-error", "--max-time", "15", "--user-agent", "Mozilla/5.0 StockDaily/1.0", "--referer", new URL(url).origin + "/", url], { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

export async function collectRecapTradingData(envelope, { fetchJson = fetchPayload, now = () => new Date() } = {}) {
  const book = { market: envelope.market, marketAsOf: envelope.marketAsOf, snapshots: [], entries: [], gaps: [] };
  const requests = tradingRequests(envelope);
  const end = Date.parse(envelope.session.wrapDeadline);
  let cursor = 0;
  const results = new Array(requests.length);
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (cursor < requests.length) {
      const index = cursor++, request = requests[index];
      let failure;
      const urls = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"].map(host => {
        const url = new URL("https://" + host + "/v8/finance/chart/" + encodeURIComponent(request.quoteSymbol));
        url.search = new URLSearchParams({ period1: String(Math.floor((end - 65 * DAY) / 1000)), period2: String(Math.floor(end / 1000)), interval: "1d" });
        return url;
      });
      if (envelope.market === "CN" && /^\d{6}$/u.test(request.symbol)) {
        const url = new URL("https://www.csindex.com.cn/csindex-home/perf/index-perf");
        url.search = new URLSearchParams({ indexCode: request.symbol, startDate: new Date(end - 65 * DAY).toISOString().slice(0, 10).replaceAll("-", ""), endDate: envelope.marketAsOf.replaceAll("-", "") });
        urls.unshift(url);
      } else if (envelope.market === "CN" && request.symbol === "SSE") {
        const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
        url.search = new URLSearchParams({ param: ["sh000001", "day", new Date(end - 65 * DAY).toISOString().slice(0, 10), envelope.marketAsOf, "60", "qfq"].join(",") });
        urls.unshift(url);
      }
      for (const url of urls) {
        try {
          const payload = await fetchJson(url.href);
          const snapshot = { symbol: request.symbol, url: url.href, payload, payloadHash: stableHash(payload), fetchedAt: now().toISOString() };
          results[index] = { snapshot, entry: parseTradingSnapshot(snapshot, request, envelope) };
          break;
        } catch (error) { failure = error.message; }
      }
      if (!results[index]) results[index] = { gap: { symbol: request.symbol, reason: failure ?? "行情不可访问" } };
    }
  }));
  for (const result of results) {
    if (result.gap) book.gaps.push(result.gap);
    else { book.snapshots.push(result.snapshot); book.entries.push(result.entry); }
  }
  return validateRecapTradingData(book, envelope);
}
