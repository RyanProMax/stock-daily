import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HANDLED_PUBLICATION_STATUSES = new Set(["published", "superseded"]);
const SUPPORTED_MARKETS = new Set(["CN", "US"]);
const MARKET_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function confirmedMarketDate(value, market) {
  const candidate = typeof value === "string" ? value : value?.[market];
  return typeof candidate === "string" && MARKET_DATE_PATTERN.test(candidate)
    ? candidate
    : null;
}

export function handledMarketUpdates(result) {
  const updates = {};
  const record = (market, status, marketAsOf) => {
    if (
      !SUPPORTED_MARKETS.has(market) ||
      !HANDLED_PUBLICATION_STATUSES.has(status)
    ) {
      return;
    }
    const confirmedDate = confirmedMarketDate(marketAsOf, market);
    if (confirmedDate && confirmedDate > String(updates[market] ?? "")) {
      updates[market] = confirmedDate;
    }
  };

  for (const item of result?.results ?? []) {
    if (item?.status !== "ready") continue;
    record(
      item.market,
      item.publication?.status,
      item.publication?.marketAsOf,
    );
  }
  for (const recovery of result?.recoveries ?? []) {
    record(recovery?.market, recovery?.status, recovery?.marketAsOf);
  }
  return updates;
}

export function mergeHandledMarketState(state, result) {
  const merged = state && typeof state === "object" && !Array.isArray(state)
    ? { ...state }
    : {};
  for (const [market, confirmedDate] of Object.entries(
    handledMarketUpdates(result),
  )) {
    if (confirmedDate > String(merged[market] ?? "")) {
      merged[market] = confirmedDate;
    }
  }
  return merged;
}

export async function persistHandledMarketState(resultPath, statePath) {
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  let state = {};
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const merged = mergeHandledMarketState(state, result);
  const temporary = `${statePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, statePath);
  return merged;
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [resultPath, statePath] = process.argv.slice(2);
  if (!resultPath || !statePath) {
    throw new Error(
      "Usage: node scripts/daily-handled-markets.mjs RESULT_PATH STATE_PATH",
    );
  }
  await persistHandledMarketState(resultPath, statePath);
}
