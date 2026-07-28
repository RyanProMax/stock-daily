import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

function weeklyFixture() {
  return {
    weekStart: "2026-07-20",
    weekEnd: "2026-07-26",
    generatedAt: "2026-07-26T13:00:00.000Z",
    headline: "一周复盘",
    summary: "下周关注政策与经济数据。",
    overview: {
      tone: "mixed",
      interpretation: "事件密集，等待官方数据落地。",
      positive: [],
      negative: [],
    },
    highlights: [],
    outlook: { base: "", upside: "", downside: "" },
    events: [
      {
        id: "fed-fomc-2026-07-29",
        date: "2026-07-29",
        title: "美联储 FOMC 利率决议",
        whyItMatters: "决定美元流动性与风险资产折现率。",
        source:
          "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        sourceLabel: "Federal Reserve",
        status: "scheduled",
      },
      {
        id: "bea-gdp-2026-07-29",
        date: "2026-07-29",
        title: "美国 GDP 初值",
        whyItMatters: "检验增长与降息预期。",
        source: "https://www.bea.gov/news/schedule",
        sourceLabel: "BEA",
        status: "scheduled",
      },
      {
        id: "bls-jobs-2026-08-01",
        date: "2026-08-01",
        title: "美国就业报告",
        whyItMatters: "观察劳动力市场是否继续降温。",
        source: "https://www.bls.gov/schedule/",
        sourceLabel: "BLS",
        status: "scheduled",
      },
    ],
    agentModel: "codex",
    translations: {
      en: {
        headline: "Weekly review",
        summary: "Policy and macro data lead the coming week.",
        overview: {
          interpretation: "A dense event calendar awaits official releases.",
          positive: [],
          negative: [],
        },
        highlights: [],
        outlook: { base: "", upside: "", downside: "" },
        events: [
          {
            title: "Federal Reserve FOMC decision",
            whyItMatters: "Sets the discount-rate backdrop for risk assets.",
          },
          {
            title: "U.S. advance GDP",
            whyItMatters: "Tests growth and easing expectations.",
          },
          {
            title: "U.S. employment report",
            whyItMatters: "Shows whether labor demand is cooling.",
          },
        ],
      },
    },
  };
}

function outcomeReports() {
  return [
    {
      reportDate: "2026-07-29",
      stories: [
        {
          id: "fomc-outcome",
          regions: ["US"],
          category: "宏观",
          importance: 5,
          title: "FOMC 公布 7 月利率决议",
          summary: "美联储维持政策利率不变，并重申依赖后续数据。",
          evidence: "官方声明已发布。",
          source:
            "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
          sourceLabel: "Federal Reserve",
          publishedAt: "2026-07-29T18:00:00.000Z",
        },
      ],
      translations: {
        en: {
          stories: [
            {
              summary:
                "The Fed held its policy rate and reiterated a data-dependent stance.",
            },
          ],
        },
      },
    },
  ];
}

test("market close labels are relative to the selected report date", async () => {
  const { formatMarketAsOfLabel } = await vite.ssrLoadModule(
    "/src/lib/i18n.ts",
  );

  assert.match(
    formatMarketAsOfLabel("2026-07-28", "2026-07-28", "CN", "zh"),
    /A股数据截至今天（7月28日）收盘/,
  );
  assert.match(
    formatMarketAsOfLabel("2026-07-27", "2026-07-28", "US", "zh"),
    /美股数据截至昨天（7月27日）收盘/,
  );
  assert.match(
    formatMarketAsOfLabel("2026-07-24", "2026-07-27", "US", "zh"),
    /美股数据截至最近交易日（7月24日）收盘/,
  );
  assert.match(
    formatMarketAsOfLabel("2026-07-27", "2026-07-28", "US", "en"),
    /U\.S\. data through yesterday's close \(Jul 27\)/,
  );
});

test("weekly events turn green only after an official result is verified", async () => {
  const { buildWeeklyEventTimeline } = await vite.ssrLoadModule(
    "/src/server/reports.ts",
  );
  const timeline = buildWeeklyEventTimeline(
    weeklyFixture(),
    "2026-07-30",
    outcomeReports(),
  );

  assert.equal(timeline.weekStart, "2026-07-27");
  assert.equal(timeline.weekEnd, "2026-08-02");
  assert.deepEqual(
    timeline.events.map((event) => event.displayStatus),
    ["realized", "awaiting", "scheduled"],
  );
  assert.equal(
    timeline.events[0].result,
    "美联储维持政策利率不变，并重申依赖后续数据。",
  );
  assert.equal(
    timeline.events[0].resultSource,
    "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
  );
  assert.ok(timeline.events[0].resultVerifiedAt);
  assert.equal(timeline.events[1].result, undefined);

  const beaOutcome = {
    reportDate: "2026-07-30",
    stories: [
      {
        id: "bea-gdp-outcome",
        title: "Gross Domestic Product, 2nd Quarter 2026",
        summary: "美国第二季度实际 GDP 折年率增长 2.4%。",
        evidence: "BEA 已发布预估数据。",
        source:
          "https://www.bea.gov/news/2026/gross-domestic-product-2nd-quarter-2026",
        sourceLabel: "U.S. Bureau of Economic Analysis",
        publishedAt: "2026-07-30T12:30:00.000Z",
      },
    ],
    translations: {
      en: {
        stories: [
          {
            summary:
              "U.S. real GDP increased at a 2.4% annual rate in the second quarter.",
          },
        ],
      },
    },
  };
  const withBeaResult = buildWeeklyEventTimeline(
    weeklyFixture(),
    "2026-07-30",
    [...outcomeReports(), beaOutcome],
  );
  assert.equal(withBeaResult.events[1].displayStatus, "realized");
  assert.match(withBeaResult.events[1].result, /GDP/);

  const sameDay = weeklyFixture();
  sameDay.events[1].date = "2026-07-30";
  assert.equal(
    buildWeeklyEventTimeline(sameDay, "2026-07-30", []).events[1]
      .displayStatus,
    "scheduled",
  );

  const unsafeStoredResult = weeklyFixture();
  unsafeStoredResult.events[0] = {
    ...unsafeStoredResult.events[0],
    status: "realized",
    result: "Unverified result",
    resultSource: "https://example.com/unverified",
    resultVerifiedAt: "2026-07-29T18:00:00.000Z",
  };
  assert.equal(
    buildWeeklyEventTimeline(
      unsafeStoredResult,
      "2026-07-30",
      [],
    ).events[0].displayStatus,
    "awaiting",
  );

  const outcomeWithoutTimestamp = outcomeReports();
  delete outcomeWithoutTimestamp[0].stories[0].publishedAt;
  assert.equal(
    buildWeeklyEventTimeline(
      weeklyFixture(),
      "2026-07-30",
      outcomeWithoutTimestamp,
    ).events[0].displayStatus,
    "awaiting",
  );
});

test("daily SSR places the weekly event grid above the report hero", async () => {
  const [{ default: Document }, { buildWeeklyEventTimeline }] =
    await Promise.all([
      vite.ssrLoadModule("/src/App.tsx"),
      vite.ssrLoadModule("/src/server/reports.ts"),
    ]);
  const reports = JSON.parse(
    await readFile(new URL("../data/reports.json", import.meta.url), "utf8"),
  );
  const report = reports[0];
  const timeline = buildWeeklyEventTimeline(
    weeklyFixture(),
    "2026-07-30",
    outcomeReports(),
  );
  const data = {
    kind: "daily",
    language: "zh",
    market: "US",
    requestUrl: "https://stock-daily.example/?date=2026-07-30&market=us",
    report,
    archive: [],
    sectorHeat: {
      current: report.sectorHeat,
      streaks: [],
      threshold: 70,
    },
    weekEvents: timeline,
  };
  const markup = renderToStaticMarkup(React.createElement(Document, { data }));
  const dom = new JSDOM(`<!doctype html>${markup}`);
  const { document, Node } = dom.window;
  const eventSection = document.querySelector("[data-weekly-events]");
  const hero = document.querySelector(".hero");

  assert.ok(eventSection);
  assert.ok(hero);
  assert.ok(
    eventSection.compareDocumentPosition(hero) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(
    document.querySelectorAll('[data-event-state="realized"]').length,
    1,
  );
  assert.equal(
    document.querySelectorAll('[data-event-state="awaiting"]').length,
    1,
  );
  assert.equal(
    document.querySelectorAll('[data-event-state="scheduled"]').length,
    1,
  );
  assert.equal(document.querySelectorAll("[data-event-check]").length, 1);
  assert.equal(document.querySelectorAll("[data-event-result]").length, 1);
  assert.match(
    document.querySelector("[data-event-result]").textContent,
    /美联储维持政策利率不变/,
  );

  const malformed = structuredClone(timeline);
  malformed.events[1].displayStatus = "realized";
  const unsafeMarkup = renderToStaticMarkup(
    React.createElement(Document, {
      data: { ...data, weekEvents: malformed },
    }),
  );
  const unsafeDocument = new JSDOM(`<!doctype html>${unsafeMarkup}`).window
    .document;
  assert.equal(
    unsafeDocument.querySelectorAll('[data-event-state="realized"]').length,
    1,
  );
  assert.equal(
    unsafeDocument.querySelectorAll('[data-event-state="awaiting"]').length,
    1,
  );
});
