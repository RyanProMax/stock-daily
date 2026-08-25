import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDailyMarketPack } from "./market-data.mjs";
import {
  collectSectorPerformance,
  topSectorHeat,
} from "./sector-heat.mjs";
import { buildMarketSessions } from "./market-attribution.mjs";
import {
  DAILY_UPDATE_KINDS,
  dailyCutoffAt,
} from "./daily-policy.mjs";
import { collectAiChainPerformance } from "./ai-chain.mjs";

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function validateMarketDates(markets, sectorPerformance, aiChainPerformance) {
  for (const region of ["CN", "US"]) {
    const heatDates = [
      ...new Set(
        sectorPerformance
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
    const aiDates = [
      ...new Set(
        aiChainPerformance
          .filter((metric) => metric.market === region)
          .map((metric) => metric.asOf),
      ),
    ];
    if (aiDates.length !== 1 || aiDates[0] !== heatDates[0]) {
      throw new Error(
        `${region} AI 产业链日期 ${aiDates.join(",")} 与板块日期 ${heatDates[0]} 不一致`,
      );
    }
  }
}

function numericChange(item) {
  const value = Number.parseFloat(String(item?.change ?? "").replace("%", ""));
  return Number.isFinite(value) ? value : 0;
}

function compactMetric(item) {
  return {
    symbol: item.symbol,
    name: item.name,
    nameEn: item.nameEn,
    change: item.change,
    direction: item.direction,
  };
}

function constituentExtremes(rows, limit = 5) {
  const unique = new Map();
  for (const row of rows) {
    for (const constituent of row.constituents ?? []) {
      if (!unique.has(constituent.symbol)) {
        unique.set(constituent.symbol, constituent);
      }
    }
  }
  const ranked = [...unique.values()].sort(
    (left, right) => numericChange(right) - numericChange(left),
  );
  return {
    leaders: ranked.slice(0, limit).map(compactMetric),
    laggards: ranked.slice(-limit).reverse().map(compactMetric),
  };
}

export function buildMarketBriefs({
  markets,
  marketSessions,
  sectorPerformance,
  aiChainPerformance,
}) {
  return Object.fromEntries(
    ["CN", "US"].map((market) => {
      const marketMetrics = markets.filter((item) => item.region === market);
      const sectors = sectorPerformance.filter((item) => item.market === market);
      const aiLayers = aiChainPerformance.filter((item) => item.market === market);
      const rankedSectors = [...sectors].sort(
        (left, right) => numericChange(right) - numericChange(left),
      );
      const rankedAiLayers = [...aiLayers].sort(
        (left, right) => numericChange(right) - numericChange(left),
      );
      return [
        market,
        {
          market,
          session: marketSessions.find((item) => item.market === market),
          indexMoves: marketMetrics.map(compactMetric),
          sectorBreadth: {
            advancing: sectors.filter((item) => item.direction === "up").length,
            declining: sectors.filter((item) => item.direction === "down").length,
            flat: sectors.filter((item) => item.direction === "flat").length,
          },
          sectorLeaders: rankedSectors.slice(0, 3).map(compactMetric),
          sectorLaggards: rankedSectors.slice(-3).reverse().map(compactMetric),
          aiLeaders: rankedAiLayers.slice(0, 2).map((item) => ({
            layer: item.layer,
            ...compactMetric(item),
          })),
          aiLaggards: rankedAiLayers.slice(-2).reverse().map((item) => ({
            layer: item.layer,
            ...compactMetric(item),
          })),
          constituentExtremes: constituentExtremes(sectors),
        },
      ];
    }),
  );
}

export async function collectDailyInput({
  reportDate = shanghaiDate(),
  updateKind = "morning",
  sectorPerformanceOverride,
  aiChainPerformanceOverride,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new Error("reportDate 必须是 YYYY-MM-DD");
  }
  if (!DAILY_UPDATE_KINDS.includes(updateKind)) {
    throw new Error("updateKind 必须是 morning、close 或 evening");
  }
  const cutoffAt = dailyCutoffAt(reportDate, updateKind);
  const cutoffTime = Date.parse(cutoffAt);
  const marketPackPromise = fetchDailyMarketPack(cutoffAt);
  const sectorPerformancePromise = sectorPerformanceOverride
    ? Promise.resolve(sectorPerformanceOverride)
    : collectSectorPerformance(cutoffTime);
  const aiChainPerformancePromise = aiChainPerformanceOverride
    ? Promise.resolve(aiChainPerformanceOverride)
    : collectAiChainPerformance(cutoffTime);
  const [marketPack, sectorPerformance, aiChainPerformance] = await Promise.all([
    marketPackPromise,
    sectorPerformancePromise,
    aiChainPerformancePromise,
  ]);
  validateMarketDates(
    marketPack.markets,
    sectorPerformance,
    aiChainPerformance,
  );
  const sectorHeat = [
    ...topSectorHeat(sectorPerformance.filter((item) => item.market === "CN")),
    ...topSectorHeat(sectorPerformance.filter((item) => item.market === "US")),
  ];
  const marketSessions = buildMarketSessions(marketPack.markets);
  const marketBriefs = buildMarketBriefs({
    markets: marketPack.markets,
    marketSessions,
    sectorPerformance,
    aiChainPerformance,
  });
  return {
    schemaVersion: 10,
    contractVersion: "codex-market-research-v10",
    runId: randomUUID(),
    reportDate,
    updateKind,
    cutoffAt,
    collectedAt: new Date().toISOString(),
    markets: marketPack.markets,
    marketDataDiagnostics: marketPack.diagnostics,
    marketSessions,
    sectorPerformance,
    aiChainPerformance,
    sectorHeat,
    marketBriefs,
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
  let sectorPerformanceOverride;
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
    sectorPerformanceOverride =
      payload.data?.sectorPerformance ?? payload.sectorPerformance;
  }
  if (
    heatInputIndex >= 0 &&
    (!Array.isArray(sectorPerformanceOverride) ||
      sectorPerformanceOverride.length !== 11 * 2)
  ) {
    throw new Error(
      "--heat-input 必须包含 CN、US 各 11 项已审计 sectorPerformance",
    );
  }
  const input = await collectDailyInput({
    reportDate,
    updateKind,
    sectorPerformanceOverride,
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
        marketDataSource: input.marketDataDiagnostics.source,
        heatCount: input.sectorHeat.length,
        sectorPerformanceCount: input.sectorPerformance.length,
        aiChainPerformanceCount: input.aiChainPerformance.length,
        researchMarkets: Object.keys(input.marketBriefs),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
