import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function yahooUrl(host, series, cutoffTime) {
  const url = new URL(
    `https://${host}/v8/finance/chart/${encodeURIComponent(series.yahoo)}`,
  );
  url.searchParams.set(
    "period1",
    String(Math.floor((cutoffTime - 32 * 24 * 60 * 60 * 1000) / 1000)),
  );
  url.searchParams.set("period2", String(Math.floor(cutoffTime / 1000)));
  url.searchParams.set("interval", "1d");
  return url;
}

function yahooPoints(payload, cutoffTime) {
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  return timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1_000).toISOString().slice(0, 10),
      value: closes[index],
    }))
    .filter(
      (point, index) =>
        Number.isFinite(point.value) &&
        Number(timestamps[index]) * 1_000 <= cutoffTime,
    );
}

export async function fetchYahooPoints(series, cutoffTime) {
  let lastError = "request failed";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = yahooUrl(host, series, cutoffTime);
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
      const points = yahooPoints(JSON.parse(result.stdout), cutoffTime);
      if (points.length >= 2) {
        return {
          points: points.slice(-2),
          source: url.toString(),
          sourceLabel: "Yahoo Finance 日收盘",
        };
      }
      lastError = "缺少两个有效交易日";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
  }
  throw new Error(`${series.yahoo}: ${lastError}`);
}
