import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessDailyFreshness } from "./daily-policy.mjs";

const DEFAULT_BASE_URL = "https://stock-daily-8k4.pages.dev";

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

export async function fetchComparisonReport(input, baseUrl = DEFAULT_BASE_URL) {
  const cacheBust = Date.now();
  const sameDate = await fetchJson(
    `${baseUrl}/api/reports/${input.reportDate}?_=${cacheBust}`,
  );
  if (sameDate?.data) return sameDate.data;

  const archive = await fetchJson(
    `${baseUrl}/api/reports?limit=1&_=${cacheBust}`,
  );
  const latestDate = archive?.data?.[0]?.reportDate;
  if (!latestDate || latestDate === input.reportDate) return null;
  const latest = await fetchJson(
    `${baseUrl}/api/reports/${latestDate}?_=${cacheBust}`,
  );
  return latest?.data ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  const baseUrlIndex = args.indexOf("--base-url");
  const inputPath = resolve(
    inputIndex >= 0 ? args[inputIndex + 1] : "work/daily-input.json",
  );
  const baseUrl =
    baseUrlIndex >= 0
      ? args[baseUrlIndex + 1]
      : process.env.STOCK_DAILY_BASE_URL ?? DEFAULT_BASE_URL;
  const input = JSON.parse(await readFile(inputPath, "utf8"));

  const closeGate = assessDailyFreshness(input, null);
  if (
    closeGate.reason === "cn_close_not_available"
  ) {
    console.log(JSON.stringify({ status: "skipped", ...closeGate }, null, 2));
    process.exitCode = closeGate.retryable ? 11 : 10;
    return;
  }

  let previousReport;
  try {
    previousReport = await fetchComparisonReport(input, baseUrl);
  } catch (error) {
    console.warn(
      JSON.stringify(
        {
          status: "fresh",
          reason: "comparison_unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = assessDailyFreshness(input, previousReport);
  console.log(
    JSON.stringify(
      {
        status: result.publish ? "fresh" : "skipped",
        comparedWith: previousReport?.reportDate ?? null,
        ...result,
      },
      null,
      2,
    ),
  );
  if (!result.publish) process.exitCode = result.retryable ? 11 : 10;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
