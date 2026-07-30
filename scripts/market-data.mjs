import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const requiredSymbols = ["SPX", "IXIC", "DJI", "DGS10", "SSE", "CSI300"];

async function executable(path) {
  if (!path || !isAbsolute(path)) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveUvPath(explicitPath) {
  const configured = [
    explicitPath,
    process.env.STOCK_ANALYSIS_UV,
    process.env.UV_BIN,
    process.env.UV,
  ].filter(Boolean);
  const known = [
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
    process.env.HOME && resolve(process.env.HOME, ".local/bin/uv"),
    process.env.HOME && resolve(process.env.HOME, ".cargo/bin/uv"),
  ].filter(Boolean);
  for (const candidate of [...configured, ...known]) {
    if (await executable(candidate)) return candidate;
  }
  try {
    const result = await execFileAsync("/usr/bin/which", ["uv"], {
      timeout: 5_000,
    });
    const candidate = result.stdout.trim();
    if (await executable(candidate)) return candidate;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error(
    "找不到 uv；请设置 STOCK_ANALYSIS_UV 为 uv 的绝对可执行路径",
  );
}

async function resolveApiRoot(explicitRoot) {
  const apiRoot = resolve(
    explicitRoot ??
      process.env.STOCK_ANALYSIS_API_ROOT ??
      resolve(projectDir, "../stock-analysis-api"),
  );
  try {
    await access(resolve(apiRoot, "scripts/market_data_query.py"));
  } catch {
    throw new Error(
      `stock-analysis-api 不可用：${apiRoot}/scripts/market_data_query.py`,
    );
  }
  return apiRoot;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`daily-pack ${label} 缺失`);
  }
  return value.trim();
}

export function normalizeDailyMarketPack(payload) {
  if (
    !payload ||
    payload.schema_version !== "market-data-query.v1" ||
    payload.status !== "ok" ||
    payload.source !== "market_data_query" ||
    payload.request?.operation !== "daily_market_pack" ||
    payload.request?.persistence !== "none" ||
    !Array.isArray(payload.data?.markets) ||
    payload.data.markets.length !== requiredSymbols.length ||
    !Array.isArray(payload.data?.failures) ||
    payload.data.failures.length !== 0
  ) {
    throw new Error("API daily-pack 状态、数量或 contract 无效");
  }

  const bySymbol = new Map(
    payload.data.markets.map((market) => [market.symbol, market]),
  );
  if (
    bySymbol.size !== requiredSymbols.length ||
    requiredSymbols.some((symbol) => !bySymbol.has(symbol))
  ) {
    throw new Error("API daily-pack 缺少必需行情");
  }

  const markets = requiredSymbols.map((symbol) => {
    const market = bySymbol.get(symbol);
    const region = market.region;
    const direction = market.direction;
    const asOf = requireText(market.as_of, `${symbol}.as_of`);
    const source = requireText(market.source, `${symbol}.source`);
    if (
      !["CN", "US"].includes(region) ||
      !["up", "down", "flat"].includes(direction) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
      !source.startsWith("https://")
    ) {
      throw new Error(`API daily-pack ${symbol} 字段无效`);
    }
    return {
      name: requireText(market.name, `${symbol}.name`),
      symbol,
      region,
      value: requireText(market.display_value, `${symbol}.display_value`),
      change: requireText(market.display_change, `${symbol}.display_change`),
      direction,
      note: `${requireText(
        market.source_label,
        `${symbol}.source_label`,
      )} · ${asOf.slice(5)}`,
      source,
      asOf,
    };
  });

  return {
    markets,
    diagnostics: {
      schemaVersion: payload.schema_version,
      status: payload.status,
      source: payload.source,
      computedAt: requireText(payload.computed_at, "computed_at"),
      cutoffAt: requireText(payload.request.cutoff_at, "request.cutoff_at"),
      persistence: payload.request.persistence,
      marketCount: markets.length,
      providers: requiredSymbols.map((symbol) => {
        const market = bySymbol.get(symbol);
        return {
          symbol,
          provider: requireText(market.provider, `${symbol}.provider`),
          asOf: market.as_of,
          attempts: Array.isArray(market.provider_attempts)
            ? market.provider_attempts
            : [],
        };
      }),
    },
  };
}

export async function fetchDailyMarketPack(
  cutoffAt,
  { apiRoot, uvPath, runner = execFileAsync } = {},
) {
  const cutoffTime = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffTime)) {
    throw new Error("cutoffAt 必须是带时区的 ISO datetime");
  }
  const [resolvedApiRoot, resolvedUvPath] = await Promise.all([
    resolveApiRoot(apiRoot),
    resolveUvPath(uvPath),
  ]);
  const result = await runner(
    resolvedUvPath,
    [
      "run",
      "python",
      "scripts/market_data_query.py",
      "daily-pack",
      "--cutoff-at",
      new Date(cutoffTime).toISOString(),
      "--persistence",
      "none",
    ],
    {
      cwd: resolvedApiRoot,
      env: process.env,
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("API daily-pack stdout 不是严格 JSON");
  }
  return normalizeDailyMarketPack(payload);
}
