import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const HEAT_THRESHOLD = 70;

const cnSectors = [
  ["932077", "能源", "Energy"],
  ["932078", "原材料", "Materials"],
  ["932079", "工业", "Industrials"],
  ["932080", "可选消费", "Consumer Discretionary"],
  ["932081", "主要消费", "Consumer Staples"],
  ["932082", "医药卫生", "Health Care"],
  ["932083", "金融", "Financials"],
  ["931775", "房地产", "Real Estate"],
  ["932084", "信息技术", "Information Technology"],
  ["932085", "通信服务", "Communication Services"],
  ["932086", "公用事业", "Utilities"],
].map(([symbol, name, nameEn]) => ({ symbol, name, nameEn }));

const usSectors = [
  ["XLC", "通信服务", "Communication Services"],
  ["XLY", "非必需消费品", "Consumer Discretionary"],
  ["XLP", "必需消费品", "Consumer Staples"],
  ["XLE", "能源", "Energy"],
  ["XLF", "金融", "Financials"],
  ["XLV", "医疗保健", "Health Care"],
  ["XLI", "工业", "Industrials"],
  ["XLB", "原材料", "Materials"],
  ["XLRE", "房地产", "Real Estate"],
  ["XLK", "信息技术", "Information Technology"],
  ["XLU", "公用事业", "Utilities"],
].map(([symbol, name, nameEn]) => ({
  symbol,
  name,
  nameEn,
}));

function directionForChange(changeValue) {
  if (Math.abs(changeValue) < 0.005) return "flat";
  return changeValue > 0 ? "up" : "down";
}

export function sectorHeatScore(market, changeValue) {
  const fullScaleMove = market === "CN" ? 5 : 3;
  return Math.min(
    100,
    Math.max(0, Math.round((Math.abs(changeValue) / fullScaleMove) * 100)),
  );
}

function formatSector(sector, market, changeValue, asOf, source) {
  return {
    market,
    symbol: sector.symbol,
    name: sector.name,
    nameEn: sector.nameEn,
    score: sectorHeatScore(market, changeValue),
    change: `${changeValue > 0 ? "+" : ""}${changeValue.toFixed(2)}%`,
    direction: directionForChange(changeValue),
    asOf,
    source,
  };
}

function topHeat(metrics) {
  return metrics
    .sort(
      (left, right) =>
        right.score - left.score ||
        Math.abs(Number.parseFloat(right.change)) -
          Math.abs(Number.parseFloat(left.change)) ||
        left.symbol.localeCompare(right.symbol),
    )
    .slice(0, 3);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

async function fetchEastmoneyJson(url) {
  const result = await execFileAsync(
    "curl",
    [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "15",
      "--retry",
      "2",
      "--retry-delay",
      "1",
      "--retry-all-errors",
      "--header",
      "Accept: application/json",
      "--header",
      "Referer: https://quote.eastmoney.com/",
      "--user-agent",
      "Mozilla/5.0 StockDaily/1.0",
      url.toString(),
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

async function fetchOfficialJson(url, referer) {
  const result = await execFileAsync(
    "curl",
    [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "20",
      "--retry",
      "2",
      "--retry-delay",
      "1",
      "--retry-all-errors",
      "--header",
      "Accept: application/json, text/plain, */*",
      "--header",
      `Referer: ${referer}`,
      "--user-agent",
      "Mozilla/5.0 StockDaily/1.0",
      url.toString(),
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

export function yahooSectorPoint(payload, cutoffTime) {
  const meta = payload?.chart?.result?.[0]?.meta;
  const quoteTime = Number(meta?.regularMarketTime) * 1_000;
  const latest = Number(meta?.regularMarketPrice);
  const previous = Number(meta?.chartPreviousClose);
  const settlementGraceMs = 5 * 60 * 1_000;
  if (
    !Number.isFinite(quoteTime) ||
    !Number.isFinite(latest) ||
    !Number.isFinite(previous) ||
    previous <= 0 ||
    quoteTime > cutoffTime + settlementGraceMs
  ) {
    return null;
  }
  return {
    asOf: new Date(quoteTime).toISOString().slice(0, 10),
    change: ((latest - previous) / previous) * 100,
  };
}

function sectorMarketId(market) {
  return market === "CN" ? "2" : "107";
}

function sectorQuoteUrl(market, symbol) {
  return market === "CN"
    ? `https://www.csindex.com.cn/#/indices/family/detail?indexCode=${symbol}`
    : `https://www.nasdaq.com/market-activity/etf/${symbol.toLowerCase()}/historical`;
}

async function fetchCurrentSectors(sectors, market, cutoffTime) {
  const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
  url.search = new URLSearchParams({
    fltt: "2",
    invt: "2",
    fields: "f12,f14,f2,f3,f6,f124",
    secids: sectors
      .map((sector) => `${sectorMarketId(market)}.${sector.symbol}`)
      .join(","),
  });
  const payload = await fetchEastmoneyJson(url);
  const rows = payload.data?.diff ?? [];
  if (rows.length !== sectors.length) {
    throw new Error(`${market} sectors: ${rows.length}/${sectors.length}`);
  }
  if (
    rows.some(
      (row) =>
        !Number.isFinite(row.f3) ||
        !Number.isFinite(row.f124) ||
        row.f124 * 1_000 > cutoffTime,
    )
  ) {
    return null;
  }
  const bySymbol = new Map(rows.map((row) => [row.f12, row]));
  return sectors.map((sector) => {
    const row = bySymbol.get(sector.symbol);
    return formatSector(
      sector,
      market,
      Number(row.f3),
      new Date(Number(row.f124) * 1_000).toISOString().slice(0, 10),
      sectorQuoteUrl(market, sector.symbol),
    );
  });
}

async function fetchYahooCurrentSector(sector, cutoffTime) {
  let lastError = "request failed";
  const symbol = `${sector.symbol}.SS`;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = new URL(
      `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    url.searchParams.set(
      "period1",
      String(Math.floor((cutoffTime - 7 * 24 * 60 * 60 * 1_000) / 1_000)),
    );
    url.searchParams.set("period2", String(Math.floor(cutoffTime / 1_000)));
    url.searchParams.set("interval", "1d");
    try {
      const result = await execFileAsync(
        "curl",
        [
          "-L",
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "15",
          "--header",
          "Accept: application/json",
          "--user-agent",
          "Mozilla/5.0 StockDaily/1.0",
          url.toString(),
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const point = yahooSectorPoint(JSON.parse(result.stdout), cutoffTime);
      if (point) {
        return formatSector(
          sector,
          "CN",
          point.change,
          point.asOf,
          `https://finance.yahoo.com/quote/${symbol}/history`,
        );
      }
      lastError = "quote is outside the cutoff";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
  }
  throw new Error(`${symbol}: ${lastError}`);
}

async function fetchYahooCurrentCnHeat(cutoffTime) {
  try {
    const metrics = await mapWithConcurrency(
      cnSectors,
      4,
      (sector) => fetchYahooCurrentSector(sector, cutoffTime),
    );
    return topHeat(metrics);
  } catch {
    return null;
  }
}

function compactDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");
}

async function fetchCnSectorPoints(
  sector,
  firstCutoffTime,
  lastCutoffTime,
) {
  const url = new URL(
    "https://www.csindex.com.cn/csindex-home/perf/index-perf",
  );
  url.search = new URLSearchParams({
    indexCode: sector.symbol,
    startDate: compactDate(firstCutoffTime - 32 * 24 * 60 * 60 * 1000),
    endDate: compactDate(lastCutoffTime),
  });
  const payload = await fetchOfficialJson(url, "https://www.csindex.com.cn/");
  if (payload.code !== "200" || !Array.isArray(payload.data)) {
    throw new Error(`${sector.symbol}: CSI history unavailable`);
  }
  return payload.data
    .map((row) => ({
      date: String(row.tradeDate).replace(
        /^(\d{4})(\d{2})(\d{2})$/,
        "$1-$2-$3",
      ),
      change: Number(row.changePct),
    }))
    .filter(
      (point) =>
        /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
        Number.isFinite(point.change),
    );
}

function parseNasdaqDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value));
  return match ? `${match[3]}-${match[1]}-${match[2]}` : "";
}

async function fetchUsSectorPoints(
  sector,
  firstCutoffTime,
  lastCutoffTime,
) {
  const url = new URL(
    `https://api.nasdaq.com/api/quote/${sector.symbol}/historical`,
  );
  url.search = new URLSearchParams({
    assetclass: "etf",
    fromdate: new Date(firstCutoffTime - 32 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    todate: new Date(lastCutoffTime).toISOString().slice(0, 10),
    limit: "100",
  });
  const payload = await fetchOfficialJson(url, "https://www.nasdaq.com/");
  const rows = payload.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`${sector.symbol}: Nasdaq history unavailable`);
  }
  const closes = rows
    .map((row) => ({
      date: parseNasdaqDate(row.date),
      value: Number(String(row.close).replaceAll(/[$,]/g, "")),
    }))
    .filter(
      (point) =>
        /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
        Number.isFinite(point.value),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  return closes.slice(1).map((point, index) => ({
    date: point.date,
    change: ((point.value - closes[index].value) / closes[index].value) * 100,
  }));
}

function fetchHistoricalSectorPoints(
  sector,
  market,
  firstCutoffTime,
  lastCutoffTime,
) {
  return market === "CN"
    ? fetchCnSectorPoints(sector, firstCutoffTime, lastCutoffTime)
    : fetchUsSectorPoints(sector, firstCutoffTime, lastCutoffTime);
}

function metricAtCutoff(sector, market, points, cutoffTime) {
  const latest = points
    .filter(
      (point) => Date.parse(`${point.date}T23:59:59Z`) <= cutoffTime,
    )
    .at(-1);
  if (!latest) throw new Error(`${sector.symbol}: no historical close`);
  return formatSector(
    sector,
    market,
    latest.change,
    latest.date,
    sectorQuoteUrl(market, sector.symbol),
  );
}

async function fetchCurrentMarketHeat(sectors, market, cutoffTime) {
  try {
    const current = await fetchCurrentSectors(sectors, market, cutoffTime);
    return current ? topHeat(current) : null;
  } catch {
    return null;
  }
}

async function collectHistoricalMarketHeat(
  sectors,
  market,
  cutoffTimes,
) {
  const firstCutoffTime = Math.min(...cutoffTimes);
  const lastCutoffTime = Math.max(...cutoffTimes);
  const histories = await mapWithConcurrency(sectors, 2, async (sector) => ({
    sector,
    points: await fetchHistoricalSectorPoints(
      sector,
      market,
      firstCutoffTime,
      lastCutoffTime,
    ),
  }));
  return cutoffTimes.map((cutoffTime) =>
    topHeat(
      histories.map(({ sector, points }) =>
        metricAtCutoff(sector, market, points, cutoffTime),
      ),
    ),
  );
}

export async function collectSectorHeat(cutoffTime) {
  const [currentCn, currentUs] = await Promise.all([
    fetchCurrentMarketHeat(cnSectors, "CN", cutoffTime),
    fetchCurrentMarketHeat(usSectors, "US", cutoffTime),
  ]);
  const [cn, us] = await Promise.all([
    (async () => {
      if (currentCn) return currentCn;
      const yahooCn = await fetchYahooCurrentCnHeat(cutoffTime);
      if (yahooCn) return yahooCn;
      const [historicalCn] = await collectHistoricalMarketHeat(
        cnSectors,
        "CN",
        [cutoffTime],
      );
      return historicalCn;
    })(),
    currentUs
      ? Promise.resolve(currentUs)
      : collectHistoricalMarketHeat(usSectors, "US", [cutoffTime]).then(
          ([historicalUs]) => historicalUs,
        ),
  ]);
  return [...cn, ...us];
}

export async function collectSectorHeatSeries(cutoffTimes) {
  if (
    !Array.isArray(cutoffTimes) ||
    cutoffTimes.length === 0 ||
    cutoffTimes.some((cutoffTime) => !Number.isFinite(cutoffTime))
  ) {
    throw new Error("cutoffTimes must contain finite timestamps");
  }
  const [cnByCutoff, usByCutoff] = await Promise.all([
    collectHistoricalMarketHeat(cnSectors, "CN", cutoffTimes),
    collectHistoricalMarketHeat(usSectors, "US", cutoffTimes),
  ]);
  return cutoffTimes.map((_, index) => [
    ...cnByCutoff[index],
    ...usByCutoff[index],
  ]);
}
