import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDailyMarketPack } from "./market-data.mjs";
import { collectNews } from "./news-pipeline.mjs";
import {
  collectSectorPerformance,
  topSectorHeat,
} from "./sector-heat.mjs";
import {
  buildMarketSessions,
  evidenceFitsSession,
} from "./market-attribution.mjs";
import {
  DAILY_UPDATE_KINDS,
  dailyCutoffAt,
} from "./daily-policy.mjs";
import { collectAiChainPerformance } from "./ai-chain.mjs";

export {
  canonicalizeUrl,
  classifyMarketRegions,
  deduplicateNews,
  extractArticleFacts,
  getNewsBudget,
  normalizeTextKey,
  parseBeaReleases,
  parseFeed,
  relevanceScore,
  selectNews,
  shouldHydrateFacts,
  usefulFacts,
} from "./news-pipeline.mjs";

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
  const [
    marketPack,
    sectorPerformance,
    aiChainPerformance,
    newsResult,
  ] = await Promise.all([
    fetchDailyMarketPack(cutoffAt),
    sectorPerformanceOverride
      ? Promise.resolve(sectorPerformanceOverride)
      : collectSectorPerformance(cutoffTime),
    aiChainPerformanceOverride
      ? Promise.resolve(aiChainPerformanceOverride)
      : collectAiChainPerformance(cutoffTime),
    collectNews(cutoffTime, reportDate),
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
  const news = newsResult.news
    .map((item) => ({
      ...item,
      regions: item.regions.filter((market) => {
        const session = marketSessions.find((candidate) => candidate.market === market);
        return session ? evidenceFitsSession(item, session) : false;
      }),
    }))
    .filter((item) => item.regions.length > 0);
  const selectedByMarket = Object.fromEntries(
    ["CN", "US"].map((market) => [
      market,
      news.filter((item) => item.regions.includes(market)).length,
    ]),
  );
  return {
    schemaVersion: 9,
    contractVersion: "market-attribution-v9",
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
    news,
    newsDiagnostics: {
      ...newsResult.diagnostics,
      selectedByMarket,
    },
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
