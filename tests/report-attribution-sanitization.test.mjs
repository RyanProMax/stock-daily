import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 24681 } },
  });
});

after(async () => {
  await vite?.close();
});

test("stored reports hide legacy attribution that lacks authoritative external evidence", async () => {
  const { getDailyReport } = await vite.ssrLoadModule("/src/server/reports.ts");
  const input = fixtureInput();
  const content = fixtureReport(input);
  content.overview = {
    tone: "mixed",
    interpretation: "市场分化",
    positive: [],
    negative: [],
  };
  content.markets = input.markets;
  content.sectorHeat = input.sectorHeat;
  content.sectorPerformance = input.sectorPerformance;
  content.aiChainPerformance = input.aiChainPerformance;
  content.stories = [];
  content.marketViews.CN.overview = content.overview;
  content.marketViews.US.overview = content.overview;

  content.drivers.forEach((driver, index) => {
    driver.id = `driver-${index + 1}`;
  });
  content.drivers[1].basis = "structural";
  content.drivers[1].evidence = content.drivers[1].evidence.slice(0, 1);
  content.drivers[1].mechanism =
    "原因未证实：公用事业行业下跌只能说明盘面贡献，不能证明外部原因。";
  content.translations.en.drivers[1].mechanism =
    "Cause unverified: utilities only describe the market contribution.";

  content.aiChainUpdates[0].id = "ai-update-1";
  content.aiChainUpdates[0].evidence =
    content.aiChainUpdates[0].evidence.slice(0, 1);
  content.aiChainViews.CN.driverStatus = "structural";
  content.aiChainViews.CN.mechanism =
    "原因未证实：光互连下跌只能说明篮子表现。";
  content.translations.en.aiChainViews.CN.mechanism =
    "Cause unverified: the basket move only describes performance.";

  const row = {
    reportDate: "2026-08-22",
    edition: 1,
    headline: content.headline,
    summary: content.summary,
    generatedAt: "2026-08-22T01:10:00.000Z",
    dataCut: "2026-08-22T01:00:00.000Z",
    agentModel: "fixture",
    content: JSON.stringify(content),
  };
  const db = {
    prepare() {
      return {
        async first() {
          return row;
        },
      };
    },
  };

  const report = await getDailyReport(db);
  assert.equal(report.drivers.length, 3);
  assert.ok(report.drivers.every((driver) => driver.basis !== "structural"));
  assert.equal(report.aiChainUpdates.length, 0);
  assert.equal(report.aiChainViews.CN.driverStatus, "insufficient");
  assert.equal(report.aiChainViews.CN.mechanism, undefined);
  assert.equal(report.translations.en.drivers.length, 3);
  assert.equal(report.translations.en.aiChainUpdates.length, 0);
  assert.equal(report.translations.en.aiChainViews.CN.mechanism, undefined);
  assert.doesNotMatch(JSON.stringify(report), /原因未证实|Cause unverified/);
});
