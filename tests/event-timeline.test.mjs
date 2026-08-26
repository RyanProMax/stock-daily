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
        expectation: "市场预期维持政策利率不变。",
        expectationSource: "https://www.reuters.com/markets/rates-bonds/",
        expectationSourceLabel: "Reuters",
        impactTone: "negative",
        assessment: "结果符合基准预期，但投票结构偏鹰。",
        nextWatch: "后续利率方向取决于通胀和就业。",
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
            expectation: "Markets expected the policy rate to remain unchanged.",
            assessment: "The result matched the base case, but the vote was hawkish.",
            nextWatch: "The next rate move depends on inflation and employment.",
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

function dailyFixture() {
  const markets = [
    ["US", "S&P 500", "SPX", "7,500.00", "+0.50%", "up"],
    ["US", "NASDAQ", "IXIC", "25,000.00", "+0.80%", "up"],
    ["US", "DOW", "DJI", "52,000.00", "+0.20%", "up"],
    ["US", "美国 10Y", "DGS10", "4.50%", "-3 bp", "down"],
    ["CN", "上证指数", "SSE", "3,800.00", "+0.30%", "up"],
    ["CN", "沪深 300", "CSI300", "4,600.00", "+0.40%", "up"],
  ].map(([region, name, symbol, value, change, direction]) => ({
    region,
    name,
    symbol,
    value,
    change,
    direction,
    note: "收盘",
    source: `https://example.com/market/${symbol}`,
  }));
  const sectorHeat = [
    ["CN", "932084", "信息技术", "Information Technology"],
    ["CN", "932083", "金融", "Financials"],
    ["CN", "932078", "原材料", "Materials"],
    ["US", "XLK", "信息技术", "Information Technology"],
    ["US", "XLF", "金融", "Financials"],
    ["US", "XLE", "能源", "Energy"],
  ].map(([market, symbol, name, nameEn], index) => ({
    market,
    symbol,
    name,
    nameEn,
    score: 80 - index,
    change: index === 5 ? "-0.50%" : "+0.50%",
    direction: index === 5 ? "down" : "up",
    asOf: "2026-07-26",
    source: `https://example.com/sector/${symbol}`,
  }));
  const story = {
    id: "verified-us-update",
    regions: ["US"],
    category: "公司",
    importance: 5,
    title: "公司上调收入指引",
    summary: "公司上调收入和现金流指引。",
    evidence: "公司公告确认最新指引。",
    source: "https://example.com/company/update",
    sourceLabel: "Company",
    publishedAt: "2026-07-26T12:00:00.000Z",
    ai: {
      tone: "positive",
      interpretation: "更高指引改善收入和现金流预期。",
      sectors: ["信息技术"],
      tickers: ["TEST"],
    },
  };
  const overview = {
    tone: "mixed",
    interpretation: "中美市场上涨，但行业表现仍有分化。",
    positive: ["信息技术"],
    negative: ["能源"],
  };
  return {
    reportDate: "2026-07-26",
    edition: 1,
    generatedAt: "2026-07-26T13:00:00.000Z",
    dataCut: "CN 2026-07-26 · US 2026-07-25",
    headline: "市场上涨但行业分化",
    summary: "主要指数上涨，信息技术强于能源。",
    overview,
    marketViews: {
      CN: { headline: "A股上涨", summary: "主要指数上涨。", overview },
      US: { headline: "美股上涨", summary: "主要指数上涨。", overview },
    },
    markets,
    sectorHeat,
    stories: [story],
    agentModel: "test-fixture",
    isSample: false,
    translations: {
      en: {
        headline: "Markets rose with sector divergence",
        summary: "Major indexes rose as technology outpaced energy.",
        overview: {
          interpretation: "Markets advanced while sectors diverged.",
          positive: ["Technology"],
          negative: ["Energy"],
        },
        marketViews: {
          CN: { headline: "China rose", summary: "Major indexes advanced." },
          US: { headline: "U.S. rose", summary: "Major indexes advanced." },
        },
        stories: [
          {
            title: "Company raises revenue guidance",
            summary: "The company raised revenue and cash-flow guidance.",
            interpretation: "Higher guidance supports revenue expectations.",
            sectors: ["Technology"],
          },
        ],
      },
    },
  };
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

test("event dates render both calendar dates and ISO checkpoint timestamps", async () => {
  const { eventDate } = await vite.ssrLoadModule(
    "/src/components/HotspotBoard.tsx",
  );

  assert.match(eventDate("2026-07-29", "zh"), /7.*29/);
  assert.match(eventDate("2026-08-03T13:00:00.000Z", "en"), /Aug 3/);
  assert.equal(eventDate("not-a-date", "en"), "not-a-date");
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

test("thesis ledger resolves only against timestamped first-party or wire follow-up", async () => {
  const { deriveThesisLedger } = await vite.ssrLoadModule(
    "/src/server/reports.ts",
  );
  const origin = {
    reportDate: "2026-07-20",
    stories: [
      {
        id: "apple-guidance",
        regions: ["US"],
        title: "苹果上调指引",
        signal: {
          thesis: "指引上调改善现金流预期。",
          roleByMarket: { US: "core" },
          exposures: [
            { name: "Apple", ticker: "AAPL", exchange: "NASDAQ" },
          ],
          horizon: "1-5d",
          confidence: "medium",
          checkpoint: {
            metric: "Apple revenue guidance",
            dueAt: "2026-07-22T13:00:00.000Z",
            confirmIf: "后续收入指引维持。",
            invalidateIf: "后续收入指引下修。",
            status: "pending",
          },
        },
      },
    ],
    translations: {
      en: {
        stories: [
          {
            title: "Apple raises guidance",
            signal: { thesis: "Guidance improves the cash-flow outlook." },
          },
        ],
      },
    },
  };
  const verifiedFollowUp = {
    reportDate: "2026-07-23",
    stories: [
      {
        id: "apple-follow-up",
        regions: ["US"],
        title: "苹果更新收入指引",
        summary: "Apple维持最新收入指引。",
        evidence: "Reuters published the company update.",
        source: "https://www.reuters.com/example/apple",
        sourceLabel: "Reuters",
        publishedAt: "2026-07-23T12:00:00.000Z",
        evidenceSource: {
          url: "https://www.reuters.com/example/apple",
          label: "Reuters",
          tier: "wire",
        },
        ai: { tickers: ["AAPL"] },
      },
    ],
  };
  const [resolved] = deriveThesisLedger(
    [origin, verifiedFollowUp],
    "2026-07-24",
    "US",
    "2026-07-20",
  );
  assert.equal(resolved.checkpoint.status, "inconclusive");
  assert.equal(resolved.checkpoint.resultSource.tier, "wire");
  assert.match(resolved.checkpoint.observation, /维持最新收入指引/);

  const unverified = structuredClone(verifiedFollowUp);
  delete unverified.stories[0].evidenceSource;
  const [pending] = deriveThesisLedger(
    [origin, unverified],
    "2026-07-24",
    "US",
    "2026-07-20",
  );
  assert.equal(pending.checkpoint.status, "pending");
});

test("daily SSR merges weekly events and analysis into the hotspot board", async () => {
  const [{ default: Document }, { buildWeeklyEventTimeline }] =
    await Promise.all([
      vite.ssrLoadModule("/src/App.tsx"),
      vite.ssrLoadModule("/src/server/reports.ts"),
    ]);
  const report = dailyFixture();
  const ledgerStory = report.stories.find((story) =>
    story.regions.includes("US"),
  );
  assert.ok(ledgerStory);
  ledgerStory.signal = {
    version: 2,
    score: 88,
    scoreReason: "该事件直接改变需求与现金流预期。",
    rankByMarket: { US: 1 },
    roleByMarket: { US: "core" },
    thesis: "已核验事实改变了短期需求与现金流的定价基准。",
    baselineKind: "company_guidance",
    metrics: [],
    reactions: [],
    transmission: [
      {
        order: 1,
        from: ledgerStory.title,
        to: "现金流预期",
        mechanism: "已核验变化影响收入与现金流基准。",
        conditional: false,
      },
    ],
    exposures: [
      {
        name: "相关公司",
        direction: "mixed",
        basis: "定价取决于后续收入与现金流验证。",
      },
    ],
    horizon: "1-5d",
    confidence: "medium",
    checkpoint: {
      metric: "后续收入与现金流披露",
      dueAt: "2026-07-30T13:00:00.000Z",
      confirmIf: "后续披露支持收入与现金流基准。",
      invalidateIf: "后续披露否定收入与现金流基准。",
      status: "pending",
    },
  };
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
    thesisLedger: [
      {
        id: `${report.reportDate}:${ledgerStory.id}:US`,
        reportDate: report.reportDate,
        storyId: ledgerStory.id,
        market: "US",
        title: ledgerStory.title,
        thesis: ledgerStory.signal.thesis,
        horizon: ledgerStory.signal.horizon,
        confidence: ledgerStory.signal.confidence,
        checkpoint: {
          ...ledgerStory.signal.checkpoint,
          status: "confirmed",
          observation: "后续一手结果与原定价逻辑一致。",
          resultSource: {
            url: ledgerStory.source,
            label: ledgerStory.sourceLabel,
            tier: "first_party",
          },
          verifiedAt: "2026-07-30T13:00:00.000Z",
        },
      },
    ],
    thesisHistory: [
      {
        id: `2026-07-29:${ledgerStory.id}:US`,
        reportDate: "2026-07-29",
        storyId: ledgerStory.id,
        market: "US",
        title: ledgerStory.title,
        thesis: ledgerStory.signal.thesis,
        horizon: ledgerStory.signal.horizon,
        confidence: ledgerStory.signal.confidence,
        checkpoint: {
          ...ledgerStory.signal.checkpoint,
          status: "confirmed",
          observation: "后续一手结果与原定价逻辑一致。",
        },
      },
    ],
  };
  const markup = renderToStaticMarkup(React.createElement(Document, { data }));
  const dom = new JSDOM(`<!doctype html>${markup}`);
  const { document, Node } = dom.window;
  const eventSection = document.querySelector("[data-weekly-events]");
  const hero = document.querySelector(".hero");
  const hotspotBoard = document.querySelector(".hotspot-board");
  const topGroup = document.querySelector(".hotspot-group-core");

  assert.ok(eventSection);
  assert.ok(hero);
  assert.ok(hotspotBoard);
  assert.ok(topGroup);
  assert.equal(document.querySelectorAll(".thesis-ledger").length, 1);
  assert.match(
    document.querySelector(".thesis-ledger").textContent,
    /观点验证.*已验证/s,
  );
  assert.equal(document.querySelectorAll("[data-signal-review]").length, 1);
  assert.doesNotMatch(
    document.querySelector("main").textContent,
    /2026-07-30T13:00:00\.000Z|信号分/,
  );
  assert.ok(hotspotBoard.contains(eventSection));
  assert.ok(
    hero.compareDocumentPosition(hotspotBoard) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.ok(
    eventSection.compareDocumentPosition(topGroup) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.doesNotMatch(
    document.body.textContent,
    /按公布日跟踪|先扫热点版图|全期热点按优先级|影响拆解/,
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
  assert.equal(document.querySelectorAll("[data-event-impact]").length, 1);
  assert.match(
    document.querySelector("[data-event-impact]").textContent,
    /利好|利空|中性/,
  );
  assert.doesNotMatch(document.body.textContent, /已兑现/);
  assert.equal(document.querySelectorAll("[data-event-result]").length, 1);
  assert.equal(
    document.querySelectorAll("[data-event-result] dl > div").length,
    4,
  );
  assert.match(
    document.querySelector("[data-event-result]").textContent,
    /预期.*维持政策利率不变.*实际.*美联储维持政策利率不变.*判断.*偏鹰.*下一步.*通胀和就业/s,
  );
  assert.equal(document.querySelectorAll(".report-toolbar").length, 0);
  assert.equal(document.querySelectorAll(".hero-date-nav").length, 0);
  assert.equal(document.querySelectorAll(".market-snapshot").length, 1);
  assert.equal(document.querySelectorAll(".snapshot-group").length, 2);
  assert.ok(
    document.querySelector(".snapshot-group-indices")
      .compareDocumentPosition(document.querySelector(".snapshot-group-sectors")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(document.querySelectorAll(".pricing-thesis").length, 0);
  assert.equal(document.querySelectorAll(".hero-summary").length, 0);
  assert.equal(document.querySelectorAll(".copy-button").length, 0);
  assert.equal(document.querySelectorAll(".edition-row").length, 0);
  assert.equal(document.querySelectorAll(".archive-section").length, 0);

  const marketStories = report.stories.filter((story) =>
    story.regions.includes("US") && story.importance >= 3,
  );
  const renderedDetails = [
    ...document.querySelectorAll(".hotspot-story"),
  ];
  assert.equal(renderedDetails.length, Math.min(3, marketStories.length));
  assert.match(document.querySelector(".signal-window").textContent, /影响周期/);
  assert.doesNotMatch(
    document.querySelector(".hotspot-title").textContent,
    /置信度/,
  );
  assert.equal(
    document.querySelectorAll(".hotspot-group-core > ol > li").length,
    Math.min(3, marketStories.length),
  );
  renderedDetails.forEach((details, index) => {
    assert.equal(
      details.querySelector(".hotspot-number").textContent,
      String(index + 1).padStart(2, "0"),
    );
    assert.equal(details.open, index === 0);
  });
  const renderedStories = renderedDetails.map((details) => {
    const analysis = details.querySelector(".hotspot-analysis");
    return marketStories.find((story) => analysis?.id === `story-${story.id}`);
  });
  assert.ok(renderedStories.every(Boolean));
  for (const story of renderedStories) {
    const analysis = document.querySelector(`#story-${story.id}`);
    const storyDetails = analysis?.closest(".hotspot-story");
    assert.ok(analysis);
    assert.ok(storyDetails);
    assert.ok(
      storyDetails.querySelector(
        story.signal ? ".signal-analysis" : ".hotspot-analysis-copy",
      ),
    );
  }
  assert.equal(document.querySelectorAll(".signal-row").length, 0);

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

test("local SSR and read APIs use production read-through without local D1", async () => {
  const [workerSource, reportSource, devConfig] = await Promise.all([
    readFile("src/worker.tsx", "utf8"),
    readFile("src/server/reports.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);
  assert.match(
    workerSource,
    /REMOTE_DATA_ORIGIN/,
  );
  assert.match(
    workerSource,
    /fetchRemotePageData<DailyPageData>/,
  );
  assert.match(workerSource, /app\.use\("\/api\/\*"/);
  const wranglerConfig = JSON.parse(devConfig);
  assert.equal(
    wranglerConfig.vars.REMOTE_DATA_ORIGIN,
    "https://stock-daily-8k4.pages.dev",
  );
  assert.equal(wranglerConfig.d1_databases, undefined);
  assert.equal(wranglerConfig.env.production.d1_databases[0].binding, "DB");
  assert.doesNotMatch(workerSource, /getDailyReport\(undefined\)|bundled fallback/);
  assert.doesNotMatch(
    reportSource,
    /data\/reports\.json|data\/story-insights\.json|fallbackReportsJson/,
  );
});
