import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cnBenchmarks = [
  {
    layer: "chips",
    name: "芯片与设备",
    nameEn: "Chips & equipment",
    benchmark: "中证半导体产业指数",
    benchmarkEn: "CSI Semiconductor Industry Index",
    symbol: "931865",
  },
  {
    layer: "interconnect",
    name: "光互连与网络",
    nameEn: "Optical interconnects & networks",
    benchmark: "中证5G通信主题指数",
    benchmarkEn: "CSI 5G Communication Theme Index",
    symbol: "931079",
  },
  {
    layer: "infrastructure",
    name: "云与算力基础设施",
    nameEn: "Cloud & compute infrastructure",
    benchmark: "中证云计算与大数据主题指数",
    benchmarkEn: "CSI Cloud Computing & Big Data Theme Index",
    symbol: "930851",
  },
  {
    layer: "applications",
    name: "软件与应用",
    nameEn: "Software & applications",
    benchmark: "中证软件服务指数",
    benchmarkEn: "CSI Software Services Index",
    symbol: "930601",
  },
];

const usBenchmarks = [
  {
    layer: "chips",
    name: "芯片与设备",
    nameEn: "Chips & equipment",
    benchmark: "SOXX ETF 代理",
    benchmarkEn: "SOXX ETF proxy",
    symbol: "SOXX",
  },
  {
    layer: "interconnect",
    name: "网络与连接",
    nameEn: "Networks & connectivity",
    benchmark: "IYZ ETF 代理",
    benchmarkEn: "IYZ ETF proxy",
    symbol: "IYZ",
  },
  {
    layer: "infrastructure",
    name: "数据中心基础设施",
    nameEn: "Data-center infrastructure",
    benchmark: "SRVR ETF 代理",
    benchmarkEn: "SRVR ETF proxy",
    symbol: "SRVR",
  },
  {
    layer: "applications",
    name: "云与软件",
    nameEn: "Cloud & software",
    benchmark: "SKYY ETF 代理",
    benchmarkEn: "SKYY ETF proxy",
    symbol: "SKYY",
  },
];

function directionForChange(change) {
  if (Math.abs(change) < 0.005) return "flat";
  return change > 0 ? "up" : "down";
}

function compactDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");
}

async function fetchJson(url, referer) {
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

function formatMetric(benchmark, market, change, asOf, source) {
  return {
    market,
    ...benchmark,
    benchmarkKind: market === "CN" ? "index" : "etf_proxy",
    change: `${change > 0 ? "+" : ""}${change.toFixed(2)}%`,
    direction: directionForChange(change),
    asOf,
    source,
  };
}

async function fetchCnMetric(benchmark, cutoffTime) {
  const url = new URL("https://www.csindex.com.cn/csindex-home/perf/index-perf");
  url.search = new URLSearchParams({
    indexCode: benchmark.symbol,
    startDate: compactDate(cutoffTime - 10 * 24 * 60 * 60 * 1_000),
    endDate: compactDate(cutoffTime),
  });
  const payload = await fetchJson(url, "https://www.csindex.com.cn/");
  const latest = Array.isArray(payload.data)
    ? payload.data
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
            Number.isFinite(point.change) &&
            Date.parse(`${point.date}T23:59:59Z`) <= cutoffTime,
        )
        .sort((left, right) => left.date.localeCompare(right.date))
        .at(-1)
    : null;
  if (payload.code !== "200" || !latest) {
    throw new Error(`${benchmark.symbol}: CSI AI-chain history unavailable`);
  }
  return formatMetric(
    benchmark,
    "CN",
    latest.change,
    latest.date,
    `https://www.csindex.com.cn/#/indices/family/detail?indexCode=${benchmark.symbol}`,
  );
}

async function fetchUsMetric(benchmark, cutoffTime) {
  let lastError = "request failed";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = new URL(
      `https://${host}/v8/finance/chart/${encodeURIComponent(benchmark.symbol)}`,
    );
    url.searchParams.set(
      "period1",
      String(Math.floor((cutoffTime - 10 * 24 * 60 * 60 * 1_000) / 1_000)),
    );
    url.searchParams.set("period2", String(Math.floor(cutoffTime / 1_000)));
    url.searchParams.set("interval", "1d");
    try {
      const payload = await fetchJson(url, "https://finance.yahoo.com/");
      const result = payload?.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      const points = timestamps
        .map((timestamp, index) => ({
          timestamp: Number(timestamp) * 1_000,
          close: Number(closes[index]),
        }))
        .filter(
          (point) =>
            Number.isFinite(point.timestamp) &&
            Number.isFinite(point.close) &&
            point.close > 0 &&
            point.timestamp <= cutoffTime,
        )
        .sort((left, right) => left.timestamp - right.timestamp);
      if (points.length < 2) throw new Error("fewer than two closes");
      const previous = points.at(-2);
      const latest = points.at(-1);
      const change = ((latest.close - previous.close) / previous.close) * 100;
      return formatMetric(
        benchmark,
        "US",
        change,
        new Date(latest.timestamp).toISOString().slice(0, 10),
        `https://finance.yahoo.com/quote/${benchmark.symbol}/history`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
  }
  throw new Error(`${benchmark.symbol}: ${lastError}`);
}

export async function collectAiChainPerformance(cutoffTime) {
  if (!Number.isFinite(cutoffTime)) {
    throw new Error("cutoffTime must be a finite timestamp");
  }
  const [cn, us] = await Promise.all([
    Promise.all(cnBenchmarks.map((benchmark) => fetchCnMetric(benchmark, cutoffTime))),
    Promise.all(usBenchmarks.map((benchmark) => fetchUsMetric(benchmark, cutoffTime))),
  ]);
  return [...cn, ...us];
}

export const AI_CHAIN_LAYERS = [
  "chips",
  "interconnect",
  "infrastructure",
  "applications",
];
