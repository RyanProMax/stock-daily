import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { marketAsOfFromInput } from "./daily-policy.mjs";

const inputPath = resolve(process.argv[2] ?? "work/daily-input.json");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const marketAsOf = marketAsOfFromInput(input);
const baseUrl = "https://stock-daily-4ip.pages.dev";
const cacheBust = Date.now();

const [healthResponse, reportResponse] = await Promise.all([
  fetch(`${baseUrl}/api/health?_=${cacheBust}`, {
    signal: AbortSignal.timeout(20_000),
  }),
  fetch(`${baseUrl}/api/reports/${input.reportDate}?_=${cacheBust}`, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(20_000),
  }),
]);

if (!healthResponse.ok || !reportResponse.ok) {
  throw new Error(
    `线上回读失败：health=${healthResponse.status}, report=${reportResponse.status}`,
  );
}

const health = (await healthResponse.json()).data;
const report = (await reportResponse.json()).data;
if (
  health?.database !== "connected" ||
  health?.latestIngestion?.status !== "completed" ||
  health?.latestIngestion?.reportDate !== input.reportDate ||
  report?.reportDate !== input.reportDate ||
  report?.isSample !== false ||
  report?.agentModel !== "openai/codex-scheduled" ||
  report?.updateKind !== input.updateKind ||
  report?.marketAsOf?.CN !== marketAsOf.CN ||
  report?.marketAsOf?.US !== marketAsOf.US ||
  report?.markets?.length !== input.markets.length ||
  report.markets.some(
    (market, index) =>
      market.region !== input.markets[index]?.region ||
      market.symbol !== input.markets[index]?.symbol,
  ) ||
  !report?.marketViews?.CN ||
  !report?.marketViews?.US ||
  report?.sectorHeat?.length !== input.sectorHeat?.length ||
  report.sectorHeat.some(
    (sector, index) =>
      !Number.isInteger(sector.score) ||
      sector.score < 0 ||
      sector.score > 100 ||
      sector.market !== input.sectorHeat[index]?.market ||
      sector.symbol !== input.sectorHeat[index]?.symbol ||
      sector.asOf !== input.sectorHeat[index]?.asOf ||
      sector.change !== input.sectorHeat[index]?.change ||
      sector.direction !== input.sectorHeat[index]?.direction,
  ) ||
  report?.stories?.length !== input.news.length ||
  report.stories.some(
    (story, index) =>
      JSON.stringify(story.regions) !==
      JSON.stringify(input.news[index]?.regions),
  )
) {
  throw new Error("线上日报与本次输入或 Codex 溯源字段不一致");
}

console.log(
  JSON.stringify(
    {
      status: "verified",
      reportDate: report.reportDate,
      updateKind: report.updateKind,
      marketAsOf: report.marketAsOf,
      marketCount: report.markets.length,
      heatCount: report.sectorHeat.length,
      storyCount: report.stories.length,
      markets: ["CN", "US"],
      agentModel: report.agentModel,
    },
    null,
    2,
  ),
);
