import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { marketAsOfFromInput } from "./daily-policy.mjs";
import { fetchFreshDailySnapshot } from "./daily-readback.mjs";

const inputPath = resolve(process.argv[2] ?? "work/daily-input.json");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const isAttribution = input.contractVersion === "market-attribution-v9";
const expectedReport = isAttribution
  ? JSON.parse(
      await readFile(
        resolve(process.argv[3] ?? "work/daily-report.json"),
        "utf8",
      ),
    )
  : null;
const marketAsOf = marketAsOfFromInput(input);
const { health, report } = await fetchFreshDailySnapshot(input);
const qualifiedStories = report?.stories?.filter(
  (story) => story.importance >= 3,
) ?? [];
const signalCounts = Object.fromEntries(
  ["CN", "US"].map((market) => [
    market,
    {
      core: qualifiedStories.filter(
        (story) => story.signal?.roleByMarket?.[market] === "core",
      ).length,
      supporting: qualifiedStories.filter(
        (story) => story.signal?.roleByMarket?.[market] === "supporting",
      ).length,
    },
  ]),
);
const v8Invalid =
  input.contractVersion === "codex-daily-v8" &&
  (qualifiedStories.length === 0 ||
    qualifiedStories.some(
      (story) =>
        story.signal?.version !== 2 ||
        !story.evidenceSource?.url ||
        !["first_party", "wire", "secondary"].includes(
          story.evidenceSource?.tier,
        ) ||
        !story.signal?.thesis ||
        !Array.isArray(story.signal?.transmission) ||
        story.signal.transmission.length < 1 ||
        !Array.isArray(story.signal?.exposures) ||
        story.signal.exposures.length < 1 ||
        !story.signal?.checkpoint?.dueAt ||
        story.signal.checkpoint.status !== "pending",
    ) ||
    report.stories.some(
      (story) => story.importance < 3 && story.signal !== undefined,
    ) ||
    ["CN", "US"].some((market) => {
      const marketQualified = qualifiedStories.filter((story) =>
        story.regions.includes(market),
      );
      return (
        marketQualified.length >= 3 &&
        (signalCounts[market].core !== 3 ||
          signalCounts[market].supporting > 2)
      );
    }));
const v9Invalid =
  isAttribution &&
  (report?.contractVersion !== "market-attribution-v9" ||
    report?.stories?.length !== 0 ||
    report?.sectorPerformance?.length !== input.sectorPerformance?.length ||
    report.sectorPerformance.some(
      (sector, index) =>
        sector.market !== input.sectorPerformance[index]?.market ||
        sector.symbol !== input.sectorPerformance[index]?.symbol ||
        sector.asOf !== input.sectorPerformance[index]?.asOf ||
        sector.change !== input.sectorPerformance[index]?.change ||
        sector.direction !== input.sectorPerformance[index]?.direction ||
        JSON.stringify(sector.constituents) !==
          JSON.stringify(input.sectorPerformance[index]?.constituents),
    ) ||
    report?.aiChainPerformance?.length !== input.aiChainPerformance?.length ||
    report.aiChainPerformance.some(
      (metric, index) =>
        metric.market !== input.aiChainPerformance[index]?.market ||
        metric.layer !== input.aiChainPerformance[index]?.layer ||
        metric.symbol !== input.aiChainPerformance[index]?.symbol ||
        metric.asOf !== input.aiChainPerformance[index]?.asOf ||
        metric.change !== input.aiChainPerformance[index]?.change ||
        metric.direction !== input.aiChainPerformance[index]?.direction ||
        JSON.stringify(metric.constituents) !==
          JSON.stringify(input.aiChainPerformance[index]?.constituents),
    ) ||
    report?.drivers?.length !== expectedReport.drivers.length ||
    report.drivers.some((driver, index) => {
      const expected = expectedReport.drivers[index];
      const expectedSources = [...new Set(
        expected.evidenceIndexes.map(
          (evidenceIndex) => input.news[evidenceIndex]?.url,
        ),
      )];
      return (
        driver.market !== expected.market ||
        driver.role !== expected.role ||
        driver.direction !== expected.direction ||
        driver.title !== expected.title ||
        driver.summary !== expected.summary ||
        driver.mechanism !== expected.mechanism ||
        JSON.stringify(driver.sectorSymbols) !==
          JSON.stringify(expected.sectorSymbols) ||
        JSON.stringify(driver.evidence.map((item) => item.source)) !==
          JSON.stringify(expectedSources)
      );
    }) ||
    report?.aiChainUpdates?.length !== expectedReport.aiChainUpdates.length ||
    report.aiChainUpdates.some((update, index) => {
      const expected = expectedReport.aiChainUpdates[index];
      const expectedSources = [...new Set(
        expected.evidenceIndexes.map(
          (evidenceIndex) => input.news[evidenceIndex]?.url,
        ),
      )];
      return (
        update.market !== expected.market ||
        update.layer !== expected.layer ||
        update.title !== expected.title ||
        update.summary !== expected.summary ||
        update.implication !== expected.implication ||
        JSON.stringify(update.evidence.map((item) => item.source)) !==
          JSON.stringify(expectedSources)
      );
    }) ||
    ["CN", "US"].some((market) =>
      ["headline", "summary", "driverStatus"].some(
        (key) =>
          report.marketViews?.[market]?.[key] !==
          expectedReport.marketViews[market][key],
      ),
    ) ||
    ["CN", "US"].some((market) =>
      ["headline", "summary", "driverStatus"].some(
        (key) =>
          report.aiChainViews?.[market]?.[key] !==
          expectedReport.aiChainViews[market][key],
      ),
    ) ||
    report.headline !== expectedReport.headline ||
    report.summary !== expectedReport.summary ||
    report.translations?.en?.headline !==
      expectedReport.translations.en.headline ||
    report.translations?.en?.summary !==
      expectedReport.translations.en.summary ||
    ["CN", "US"].some((market) =>
      ["headline", "summary"].some(
        (key) =>
          report.translations?.en?.marketViews?.[market]?.[key] !==
          expectedReport.translations.en.marketViews[market][key],
      ),
    ) ||
    ["CN", "US"].some((market) =>
      ["headline", "summary"].some(
        (key) =>
          report.translations?.en?.aiChainViews?.[market]?.[key] !==
          expectedReport.translations.en.aiChainViews[market][key],
      ),
    ) ||
    report.translations?.en?.drivers?.length !==
      expectedReport.translations.en.drivers.length ||
    report.translations?.en?.drivers?.some((driver, index) =>
      ["title", "summary", "mechanism"].some(
        (key) =>
          driver[key] !== expectedReport.translations.en.drivers[index]?.[key],
        ),
    ) ||
    report.translations?.en?.aiChainUpdates?.length !==
      expectedReport.translations.en.aiChainUpdates.length ||
    report.translations?.en?.aiChainUpdates?.some((update, index) =>
      ["title", "summary", "implication"].some(
        (key) =>
          update[key] !==
          expectedReport.translations.en.aiChainUpdates[index]?.[key],
      ),
    ));
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
  (!isAttribution &&
    (report?.stories?.length !== input.news.length ||
      report.stories.some(
        (story, index) =>
          JSON.stringify(story.regions) !==
          JSON.stringify(input.news[index]?.regions),
      ))) ||
  v8Invalid ||
  v9Invalid
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
      qualifiedSignalCount: qualifiedStories.length,
      signalCounts,
      driverCount: report.drivers?.length ?? 0,
      driverStatus: Object.fromEntries(
        ["CN", "US"].map((market) => [
          market,
          report.marketViews?.[market]?.driverStatus,
        ]),
      ),
      markets: ["CN", "US"],
      agentModel: report.agentModel,
    },
    null,
    2,
  ),
);
