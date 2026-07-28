import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetchYahooPoints } from "./market-data.mjs";
import { collectNews } from "./news-pipeline.mjs";
import { collectSectorHeat } from "./sector-heat.mjs";
import {
  DAILY_UPDATE_KINDS,
  dailyCutoffAt,
} from "./daily-policy.mjs";

export {
  canonicalizeUrl,
  classifyMarketRegions,
  deduplicateNews,
  extractArticleFacts,
  getNewsBudget,
  normalizeTextKey,
  parseFeed,
  relevanceScore,
  selectNews,
  usefulFacts,
} from "./news-pipeline.mjs";

const marketSeries = [
  {
    id: "SP500",
    yahoo: "^GSPC",
    name: "S&P 500",
    symbol: "SPX",
    region: "US",
    kind: "index",
  },
  {
    id: "NASDAQCOM",
    yahoo: "^IXIC",
    name: "NASDAQ",
    symbol: "IXIC",
    region: "US",
    kind: "index",
  },
  {
    id: "DJIA",
    yahoo: "^DJI",
    name: "DOW",
    symbol: "DJI",
    region: "US",
    kind: "index",
  },
  {
    id: "DGS10",
    yahoo: "^TNX",
    name: "美国 10Y",
    symbol: "DGS10",
    region: "US",
    kind: "yield",
  },
  {
    yahoo: "000001.SS",
    eastmoney: "1.000001",
    tencent: "sh000001",
    name: "上证指数",
    symbol: "SSE",
    region: "CN",
    kind: "index",
  },
  {
    yahoo: "000300.SS",
    eastmoney: "1.000300",
    tencent: "sh000300",
    name: "沪深 300",
    symbol: "CSI300",
    region: "CN",
    kind: "index",
  },
];

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseFredCsv(csv, seriesId) {
  const points = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [date, rawValue] = line.split(",");
      return { date, value: Number(rawValue) };
    })
    .filter((point) => point.date && Number.isFinite(point.value));

  if (points.length < 2) {
    throw new Error(`${seriesId} 缺少两个有效交易日`);
  }
  return points;
}

async function fetchEastmoneyPoints(series, cutoffTime) {
  const endDate = new Date(cutoffTime).toISOString().slice(0, 10);
  const startDate = new Date(cutoffTime - 20 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const url = new URL(
    "https://push2his.eastmoney.com/api/qt/stock/kline/get",
  );
  url.search = new URLSearchParams({
    secid: series.eastmoney,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: "101",
    fqt: "1",
    beg: startDate.replaceAll("-", ""),
    end: endDate.replaceAll("-", ""),
  });
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://quote.eastmoney.com/",
      "User-Agent": "Mozilla/5.0 StockDaily/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${series.eastmoney}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const points = (payload.data?.klines ?? [])
    .map((line) => {
      const [date, _open, close] = String(line).split(",");
      return { date, value: Number(close) };
    })
    .filter(
      (point) =>
        /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
        Number.isFinite(point.value) &&
        Date.parse(`${point.date}T15:00:00+08:00`) <= cutoffTime,
    );
  if (points.length < 2) {
    throw new Error(`${series.eastmoney}: 缺少两个有效交易日`);
  }
  return {
    points: points.slice(-2),
    source: url.toString(),
    sourceLabel: "东方财富日收盘",
  };
}

async function fetchTencentPoints(series, cutoffTime) {
  if (!series.tencent) throw new Error(`${series.symbol}: Tencent 不支持该市场`);
  const endDate = new Date(cutoffTime).toISOString().slice(0, 10);
  const startDate = new Date(cutoffTime - 20 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const url = new URL(
    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
  );
  url.searchParams.set(
    "param",
    `${series.tencent},day,${startDate},${endDate},40,qfq`,
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://gu.qq.com/",
      "User-Agent": "Mozilla/5.0 StockDaily/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${series.tencent}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const points = (payload.data?.[series.tencent]?.day ?? [])
    .map((row) => ({
      date: String(row[0]),
      value: Number(row[2]),
    }))
    .filter(
      (point) =>
        /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
        Number.isFinite(point.value) &&
        Date.parse(`${point.date}T15:00:00+08:00`) <= cutoffTime,
    )
    .slice(-2);
  if (points.length < 2) {
    throw new Error(`${series.tencent}: 缺少两个有效交易日`);
  }
  return {
    points,
    source: url.toString(),
    sourceLabel: "腾讯证券日收盘",
  };
}

async function fetchFredPoints(series, cutoffTime) {
  if (!series.id) throw new Error(`${series.symbol}: FRED 不支持该市场`);
  const end = new Date(cutoffTime);
  const start = new Date(end.getTime() - 16 * 24 * 60 * 60 * 1000);
  const url = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
  url.searchParams.set("id", series.id);
  url.searchParams.set("cosd", toIsoDate(start));
  url.searchParams.set("coed", toIsoDate(end));
  const response = await fetch(url, {
    headers: { Accept: "text/csv" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${series.id}: HTTP ${response.status}`);
  const cutoffDate = toIsoDate(new Date(cutoffTime));
  const points = parseFredCsv(await response.text(), series.id)
    .filter((point) => point.date < cutoffDate)
    .slice(-2);
  if (points.length < 2) {
    throw new Error(`${series.id} 在截点前缺少两个有效交易日`);
  }
  return {
    points,
    source: `https://fred.stlouisfed.org/series/${series.id}`,
    sourceLabel: "FRED 日收盘",
  };
}

function formatMarket(series, points, source, sourceLabel) {
  const [previous, latest] = points;
  const difference = latest.value - previous.value;
  const direction =
    Math.abs(difference) < 0.0001 ? "flat" : difference > 0 ? "up" : "down";

  if (series.kind === "yield") {
    const basisPoints = difference * 100;
    return {
      name: series.name,
      symbol: series.symbol,
      region: series.region,
      value: `${latest.value.toFixed(2)}%`,
      change: `${basisPoints > 0 ? "+" : ""}${basisPoints.toFixed(0)} bp`,
      direction,
      note: `${sourceLabel} · ${latest.date.slice(5)}`,
      source,
      asOf: latest.date,
    };
  }

  const percent = (difference / previous.value) * 100;
  return {
    name: series.name,
    symbol: series.symbol,
    region: series.region,
    value: new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(latest.value),
    change: `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`,
    direction,
    note: sourceLabel,
    source,
    asOf: latest.date,
  };
}

async function fetchMarket(series, cutoffTime) {
  if (series.tencent) {
    try {
      const tencent = await fetchTencentPoints(series, cutoffTime);
      return formatMarket(
        series,
        tencent.points,
        tencent.source,
        tencent.sourceLabel,
      );
    } catch {
      // Continue to the secondary mainland market source.
    }
  }
  if (series.eastmoney) {
    try {
      const eastmoney = await fetchEastmoneyPoints(series, cutoffTime);
      return formatMarket(
        series,
        eastmoney.points,
        eastmoney.source,
        eastmoney.sourceLabel,
      );
    } catch {
      // Continue to the cross-market fallback below.
    }
  }
  if (series.id) {
    try {
      const fred = await fetchFredPoints(series, cutoffTime);
      return formatMarket(series, fred.points, fred.source, fred.sourceLabel);
    } catch {
      // Continue to the exchange-chart fallback.
    }
  }
  try {
    const yahoo = await fetchYahooPoints(series, cutoffTime);
    return formatMarket(series, yahoo.points, yahoo.source, yahoo.sourceLabel);
  } catch (yahooError) {
    try {
      const fred = await fetchFredPoints(series, cutoffTime);
      return formatMarket(series, fred.points, fred.source, fred.sourceLabel);
    } catch (fredError) {
      const yahooMessage =
        yahooError instanceof Error ? yahooError.message : "Yahoo failed";
      const fredMessage =
        fredError instanceof Error ? fredError.message : "FRED failed";
      throw new Error(`${yahooMessage}; fallback ${fredMessage}`);
    }
  }
}

async function fetchMarkets(cutoffTime) {
  return Promise.all(
    marketSeries.map((series) => fetchMarket(series, cutoffTime)),
  );
}

function validateMarketDates(markets, sectorHeat) {
  for (const region of ["CN", "US"]) {
    const heatDates = [
      ...new Set(
        sectorHeat
          .filter((sector) => sector.market === region)
          .map((sector) => sector.asOf),
      ),
    ];
    if (heatDates.length !== 1) {
      throw new Error(`${region} 板块交易日不一致`);
    }
    const equityDates = [
      ...new Set(
        markets
          .filter(
            (market) =>
              market.region === region && market.symbol !== "DGS10",
          )
          .map((market) => market.asOf),
      ),
    ];
    if (equityDates.length !== 1 || equityDates[0] !== heatDates[0]) {
      throw new Error(
        `${region} 指数日期 ${equityDates.join(",")} 与板块日期 ${heatDates[0]} 不一致`,
      );
    }
  }
}

export async function collectDailyInput({
  reportDate = shanghaiDate(),
  updateKind = "morning",
  sectorHeatOverride,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new Error("reportDate 必须是 YYYY-MM-DD");
  }
  if (!DAILY_UPDATE_KINDS.includes(updateKind)) {
    throw new Error("updateKind 必须是 morning、close 或 evening");
  }
  const cutoffAt = dailyCutoffAt(reportDate, updateKind);
  const cutoffTime = Date.parse(cutoffAt);
  const [markets, sectorHeat, newsResult] = await Promise.all([
    fetchMarkets(cutoffTime),
    sectorHeatOverride
      ? Promise.resolve(sectorHeatOverride)
      : collectSectorHeat(cutoffTime),
    collectNews(cutoffTime, reportDate),
  ]);
  validateMarketDates(markets, sectorHeat);
  return {
    schemaVersion: 7,
    contractVersion: "codex-daily-v7",
    runId: randomUUID(),
    reportDate,
    updateKind,
    cutoffAt,
    collectedAt: new Date().toISOString(),
    markets,
    sectorHeat,
    news: newsResult.news,
    newsDiagnostics: newsResult.diagnostics,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dateIndex = args.indexOf("--report-date");
  const outputIndex = args.indexOf("--output");
  const heatInputIndex = args.indexOf("--heat-input");
  const updateKindIndex = args.indexOf("--update-kind");
  const reportDate = dateIndex >= 0 ? args[dateIndex + 1] : shanghaiDate();
  const updateKind =
    updateKindIndex >= 0 ? args[updateKindIndex + 1] : "morning";
  const positional = args.find((argument, index) => {
    if (argument.startsWith("--")) return false;
    if (
      index === dateIndex + 1 ||
      index === outputIndex + 1 ||
      index === heatInputIndex + 1 ||
      index === updateKindIndex + 1
    ) {
      return false;
    }
    return true;
  });
  const outputPath = resolve(
    outputIndex >= 0
      ? args[outputIndex + 1]
      : positional ?? "work/daily-input.json",
  );
  let sectorHeatOverride;
  if (heatInputIndex >= 0) {
    const heatInput = args[heatInputIndex + 1];
    const payload = heatInput.startsWith("https://")
      ? await fetch(heatInput, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        }).then((response) => {
          if (!response.ok) {
            throw new Error(`--heat-input HTTP ${response.status}`);
          }
          return response.json();
        })
      : JSON.parse(await readFile(resolve(heatInput), "utf8"));
    sectorHeatOverride = payload.data?.sectorHeat ?? payload.sectorHeat;
  }
  if (
    heatInputIndex >= 0 &&
    (!Array.isArray(sectorHeatOverride) || sectorHeatOverride.length !== 6)
  ) {
    throw new Error("--heat-input 必须包含六项已审计 sectorHeat");
  }
  const input = await collectDailyInput({
    reportDate,
    updateKind,
    sectorHeatOverride,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        status: "collected",
        outputPath,
        reportDate: input.reportDate,
        updateKind: input.updateKind,
        cutoffAt: input.cutoffAt,
        marketCount: input.markets.length,
        heatCount: input.sectorHeat.length,
        newsCount: input.news.length,
        newsByMarket: input.newsDiagnostics.selectedByMarket,
        newsCandidates: input.newsDiagnostics.candidateCount,
        failedNewsSources: input.newsDiagnostics.sources.filter(
          (source) => source.status === "error",
        ).length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
