import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeUrl,
  classifyMarketRegions,
  normalizeTextKey,
  parseBeaReleases,
  parseFeed,
  selectNews,
  usefulFacts,
} from "../scripts/daily-collect.mjs";
import { normalizeDailyMarketPack } from "../scripts/market-data.mjs";
import {
  validateInput,
  validateReport,
} from "../scripts/daily-publish.mjs";
import {
  assessDailyFreshness,
  dailyCutoffAt,
} from "../scripts/daily-policy.mjs";
import { yahooSectorPoint } from "../scripts/sector-heat.mjs";

const input = {
  schemaVersion: 7,
  contractVersion: "codex-daily-v7",
  runId: "test-run",
  reportDate: "2026-07-25",
  updateKind: "morning",
  cutoffAt: "2026-07-25T01:00:00.000Z",
  collectedAt: "2026-07-25T01:00:00.000Z",
  markets: [
    {
      region: "US",
      name: "S&P 500",
      symbol: "SPX",
      value: "7,411.98",
      change: "+0.05%",
      direction: "up",
      note: "FRED 日收盘",
      source: "https://fred.stlouisfed.org/series/SP500",
      asOf: "2026-07-24",
    },
    {
      region: "US",
      name: "NASDAQ",
      symbol: "IXIC",
      value: "24,975.82",
      change: "-0.64%",
      direction: "down",
      note: "FRED 日收盘",
      source: "https://fred.stlouisfed.org/series/NASDAQCOM",
      asOf: "2026-07-24",
    },
    {
      region: "US",
      name: "DOW",
      symbol: "DJI",
      value: "51,947.25",
      change: "+0.46%",
      direction: "up",
      note: "FRED 日收盘",
      source: "https://fred.stlouisfed.org/series/DJIA",
      asOf: "2026-07-24",
    },
    {
      region: "US",
      name: "美国 10Y",
      symbol: "DGS10",
      value: "4.71%",
      change: "+4 bp",
      direction: "up",
      note: "美债收益率",
      source: "https://fred.stlouisfed.org/series/DGS10",
      asOf: "2026-07-23",
    },
    {
      region: "CN",
      name: "上证指数",
      symbol: "SSE",
      value: "3,876.78",
      change: "+0.25%",
      direction: "up",
      note: "A股日收盘",
      source: "https://quote.eastmoney.com/zs000001.html",
      asOf: "2026-07-24",
    },
    {
      region: "CN",
      name: "沪深 300",
      symbol: "CSI300",
      value: "4,728.00",
      change: "+0.23%",
      direction: "up",
      note: "A股日收盘",
      source: "https://quote.eastmoney.com/zs000300.html",
      asOf: "2026-07-24",
    },
  ],
  marketDataDiagnostics: {
    schemaVersion: "market-data-query.v1",
    status: "ok",
    source: "market_data_query",
    computedAt: "2026-07-25T01:00:01.000Z",
    cutoffAt: "2026-07-25T01:00:00.000Z",
    persistence: "none",
    marketCount: 6,
    providers: [
      { symbol: "SPX", provider: "fred", asOf: "2026-07-24", attempts: [] },
      { symbol: "IXIC", provider: "fred", asOf: "2026-07-24", attempts: [] },
      { symbol: "DJI", provider: "fred", asOf: "2026-07-24", attempts: [] },
      { symbol: "DGS10", provider: "fred", asOf: "2026-07-23", attempts: [] },
      { symbol: "SSE", provider: "tencent", asOf: "2026-07-24", attempts: [] },
      {
        symbol: "CSI300",
        provider: "tencent",
        asOf: "2026-07-24",
        attempts: [],
      },
    ],
  },
  sectorHeat: [
    {
      market: "CN",
      symbol: "932078",
      name: "原材料",
      nameEn: "Materials",
      score: 77,
      change: "-3.86%",
      direction: "down",
      asOf: "2026-07-24",
      source:
        "https://www.csindex.com.cn/#/indices/family/detail?indexCode=932078",
    },
    {
      market: "CN",
      symbol: "932086",
      name: "公用事业",
      nameEn: "Utilities",
      score: 75,
      change: "-3.77%",
      direction: "down",
      asOf: "2026-07-24",
      source:
        "https://www.csindex.com.cn/#/indices/family/detail?indexCode=932086",
    },
    {
      market: "CN",
      symbol: "932082",
      name: "医药卫生",
      nameEn: "Health Care",
      score: 72,
      change: "-3.60%",
      direction: "down",
      asOf: "2026-07-24",
      source:
        "https://www.csindex.com.cn/#/indices/family/detail?indexCode=932082",
    },
    {
      market: "US",
      symbol: "XLRE",
      name: "房地产",
      nameEn: "Real Estate",
      score: 74,
      change: "+2.22%",
      direction: "up",
      asOf: "2026-07-24",
      source:
        "https://www.nasdaq.com/market-activity/etf/xlre/historical",
    },
    {
      market: "US",
      symbol: "XLB",
      name: "原材料",
      nameEn: "Materials",
      score: 64,
      change: "+1.93%",
      direction: "up",
      asOf: "2026-07-24",
      source:
        "https://www.nasdaq.com/market-activity/etf/xlb/historical",
    },
    {
      market: "US",
      symbol: "XLK",
      name: "信息技术",
      nameEn: "Information Technology",
      score: 48,
      change: "-1.44%",
      direction: "down",
      asOf: "2026-07-24",
      source:
        "https://www.nasdaq.com/market-activity/etf/xlk/historical",
    },
  ],
  news: [
    {
      title: "Apple raises guidance as iPhone revenue grows",
      facts:
        "Apple raised its guidance after iPhone revenue grew, improving the company's revenue and cash-flow outlook.",
      url: "https://example.com/apple-guidance",
      source: "Example Wire",
      publishedAt: "2026-07-24T20:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "30-year Treasury yield could reach 6% if inflation rises",
      facts:
        "The 30-year Treasury yield could reach 6% if inflation rises; this is a conditional scenario rather than an observed yield.",
      url: "https://example.com/treasury-scenario",
      source: "Example Wire",
      publishedAt: "2026-07-24T21:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "China industrial output growth supports manufacturers",
      facts:
        "China industrial output grew and supported demand expectations for domestic manufacturers.",
      url: "https://example.com/china-industrial-output",
      source: "Example Wire CN",
      publishedAt: "2026-07-24T10:00:00.000Z",
      regions: ["CN"],
    },
    {
      title: "China consumer demand improves across services",
      facts:
        "China consumer demand improved across service categories, supporting the domestic service-consumption outlook.",
      url: "https://example.com/china-consumer-demand",
      source: "Example Wire CN",
      publishedAt: "2026-07-24T11:00:00.000Z",
      regions: ["CN"],
    },
    {
      title: "Federal Reserve policy outlook keeps rates restrictive",
      facts:
        "Federal Reserve officials said inflation risks kept the policy outlook restrictive, maintaining pressure on discount rates and financing costs.",
      url: "https://example.com/fed-policy-outlook",
      source: "Federal Reserve",
      publishedAt: "2026-07-24T18:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "A-share turnover rises as semiconductor demand improves",
      facts:
        "A-share market turnover increased while semiconductor demand improved, strengthening revenue expectations for domestic chip suppliers.",
      url: "https://example.com/china-semiconductor-demand",
      source: "Example Wire CN",
      publishedAt: "2026-07-24T12:00:00.000Z",
      regions: ["CN"],
    },
  ],
  newsDiagnostics: {
    mode: "live",
    candidateCount: 20,
    hydratedCount: 12,
    rejectedDuringHydration: 2,
    selectedByMarket: { CN: 3, US: 3 },
    minimumPerMarket: 3,
    targetPerMarket: 5,
    sources: [],
  },
};

const marketOverview = {
  tone: "mixed",
  interpretation:
    "美股方向分化且美债收益率上行，对高估值资产构成利空并压制风险偏好；A股上涨则为中国大盘股估值提供支撑。",
  positive: ["A股", "中国大盘股"],
  negative: ["高估值成长股", "利率敏感资产"],
};

function reportWith(stories, overrides = {}) {
  return {
    headline: "指数分化，利率仍约束估值",
    summary: "市场内部表现分化，美债收益率上行继续提高成长股的折现压力。",
    overview: marketOverview,
    marketViews: {
      CN: {
        headline: "A股走强支撑本地风险偏好",
        summary: "上证与沪深指数同步上涨，为中国大盘股估值和本地风险偏好提供支撑。",
        overview: {
          tone: "positive",
          interpretation:
            "两项中国股市指数同步上涨，对A股风险偏好构成利好，并通过估值修复支撑中国大盘股与本地权益资产。",
          positive: ["A股", "中国大盘股"],
          negative: [],
        },
      },
      US: {
        headline: "美股分化且利率约束估值",
        summary: "美股指数涨跌分化，美债收益率上行继续增加成长资产的估值压力。",
        overview: {
          tone: "mixed",
          interpretation:
            "标普与道指上涨提供支撑，但纳斯达克回落压制成长股风险偏好；美债收益率上行抬高无风险利率，对高估值资产构成利空。",
          positive: ["标普大盘股", "道琼斯"],
          negative: ["纳斯达克", "高估值成长股"],
        },
      },
    },
    stories,
    translations: {
      en: {
        headline: "Markets Diverge as Rates Constrain Valuations",
        summary:
          "Markets are diverging while higher Treasury yields keep pressure on growth-stock discount rates.",
        overview: {
          interpretation:
            "Diverging equities and higher Treasury yields weigh on high-valuation assets, while stronger Chinese shares support large-cap risk appetite.",
          positive: ["Chinese equities", "Chinese large caps"],
          negative: ["Growth stocks", "Rate-sensitive assets"],
        },
        marketViews: {
          CN: {
            headline: "Chinese Equities Support Local Risk Appetite",
            summary:
              "Gains in both major Chinese equity indexes support valuations and local equity risk appetite.",
            overview: {
              interpretation:
                "Gains in both local equity indexes are positive for risk appetite and support valuation recovery in domestic large-cap shares.",
              positive: ["Local equities", "Domestic large caps"],
              negative: [],
            },
          },
          US: {
            headline: "Diverging US Stocks Face Rate Pressure",
            summary:
              "US equity indexes diverge while rising bond yields keep pressure on growth-asset valuations.",
            overview: {
              interpretation:
                "Large-cap index gains offer support, but weaker technology shares weigh on risk appetite while rising bond yields raise discount-rate pressure.",
              positive: ["Large-cap equities", "Industrial shares"],
              negative: ["Technology shares", "High-valuation growth"],
            },
          },
        },
        stories: stories.map((story, storyIndex) => ({
          title: `Market update: ${story.title}`,
          summary:
            "The source development changes expectations for the affected market.",
          interpretation:
            "The development transmits through costs, cash flow, valuation, or risk appetite.",
          sectors: story.sectors.map(
            (_sector, sectorIndex) =>
              `Sector ${storyIndex + 1}.${sectorIndex + 1}`,
          ),
        })),
      },
    },
    ...overrides,
  };
}

const validStories = [
  {
    sourceIndex: 0,
    category: "公司",
    importance: 5,
    title: "苹果上调业绩指引",
    summary: "Apple上调业绩指引，收入增长改善盈利预期。",
    tone: "positive",
    interpretation:
      "收入增长与指引上调→现金流预期改善→消费电子供应链盈利预期改善。",
    sectors: ["消费电子", "智能手机"],
    tickers: ["AAPL", "NVDA"],
  },
  {
    sourceIndex: 1,
    category: "宏观",
    importance: 5,
    title: "长期美债收益率情景抬升",
    summary: "若通胀上升，30年期美债收益率可能达到6%。",
    tone: "negative",
    interpretation:
      "若收益率达到6%→无风险利率与融资成本上升→对高估值成长股构成利空并增大折现压力。",
    sectors: ["高估值成长", "美债"],
    tickers: [],
  },
  {
    sourceIndex: 2,
    category: "宏观",
    importance: 4,
    title: "中国工业产出增长支撑制造业",
    summary: "中国工业产出增长，为制造业需求预期提供支撑。",
    tone: "positive",
    interpretation:
      "工业产出增长→制造业需求预期改善→相关企业收入与现金流预期获得支撑。",
    sectors: ["制造业", "工业"],
    tickers: [],
  },
  {
    sourceIndex: 3,
    category: "宏观",
    importance: 4,
    title: "中国服务消费需求改善",
    summary: "中国消费需求在服务领域改善，支持内需预期。",
    tone: "positive",
    interpretation:
      "服务消费需求改善→企业收入预期增强→消费服务行业现金流与风险偏好获得支撑。",
    sectors: ["服务消费", "内需"],
    tickers: [],
  },
  {
    sourceIndex: 4,
    category: "宏观",
    importance: 5,
    title: "美联储维持限制性政策预期",
    summary: "通胀风险使美联储政策预期保持限制性。",
    tone: "negative",
    interpretation:
      "限制性利率预期延续→无风险利率与融资成本维持高位→对高估值资产构成利空并增加折现压力。",
    sectors: ["高估值成长", "利率敏感资产"],
    tickers: [],
  },
  {
    sourceIndex: 5,
    category: "行业",
    importance: 4,
    title: "成交回升叠加半导体需求改善",
    summary: "A股成交回升且半导体需求改善，支持国内芯片供应商预期。",
    tone: "positive",
    interpretation:
      "成交活跃与半导体需求改善→收入和风险偏好预期增强→国内芯片产业链估值获得支撑。",
    sectors: ["半导体", "A股"],
    tickers: [],
  },
];

test("local Codex report contract accepts bounded facts and filters tickers", () => {
  const checkedInput = validateInput(input);
  const checkedReport = validateReport(reportWith(validStories), checkedInput);

  assert.deepEqual(checkedReport.stories[0].tickers, ["AAPL"]);
  assert.equal(checkedReport.stories[1].tone, "negative");
});

test("daily policy refreshes three Beijing checkpoints and deduplicates retries", () => {
  assert.equal(
    dailyCutoffAt("2026-07-25", "morning"),
    "2026-07-25T01:00:00.000Z",
  );
  assert.equal(
    dailyCutoffAt("2026-07-25", "close"),
    "2026-07-25T07:00:00.000Z",
  );
  assert.equal(
    dailyCutoffAt("2026-07-25", "evening"),
    "2026-07-25T13:00:00.000Z",
  );

  const previous = {
    reportDate: "2026-07-25",
    updateKind: "morning",
    marketAsOf: { CN: "2026-07-24", US: "2026-07-24" },
    stories: input.news.map((story) => ({ source: story.url })),
  };
  const unchanged = assessDailyFreshness(input, previous);
  assert.equal(unchanged.publish, false);
  assert.equal(unchanged.reason, "no_material_advance");

  const closeInput = structuredClone(input);
  closeInput.updateKind = "close";
  closeInput.cutoffAt = "2026-07-25T07:00:00.000Z";
  for (const sector of closeInput.sectorHeat) {
    if (sector.market === "CN") sector.asOf = "2026-07-25";
  }
  const advanced = assessDailyFreshness(closeInput, previous);
  assert.equal(advanced.publish, true);
  assert.deepEqual(advanced.advancedMarkets, ["CN"]);

  const weekendClose = structuredClone(input);
  weekendClose.reportDate = "2026-07-26";
  weekendClose.updateKind = "close";
  weekendClose.cutoffAt = "2026-07-26T07:00:00.000Z";
  const weekend = assessDailyFreshness(weekendClose, previous);
  assert.equal(weekend.publish, true);
  assert.equal(weekend.retryable, false);
  assert.equal(weekend.reason, "scheduled_checkpoint");

  const checkpointOnly = structuredClone(input);
  checkpointOnly.updateKind = "evening";
  checkpointOnly.cutoffAt = "2026-07-25T13:00:00.000Z";
  const checkpoint = assessDailyFreshness(checkpointOnly, previous);
  assert.equal(checkpoint.publish, true);
  assert.equal(checkpoint.reason, "scheduled_checkpoint");
  assert.equal(checkpoint.checkpointChanged, true);

  const eveningInput = structuredClone(input);
  eveningInput.updateKind = "evening";
  eveningInput.cutoffAt = "2026-07-25T13:00:00.000Z";
  eveningInput.news[0].url = "https://example.com/evening-update";
  const evening = assessDailyFreshness(eveningInput, previous);
  assert.equal(evening.publish, true);
  assert.equal(evening.reason, "material_advance");
  assert.equal(evening.newStoryCount, 1);
});

test("CN sector close accepts only Yahoo quotes inside settlement grace", () => {
  const cutoffTime = Date.parse("2026-07-27T07:00:00.000Z");
  const payload = {
    chart: {
      result: [
        {
          meta: {
            regularMarketTime:
              Date.parse("2026-07-27T07:00:24.000Z") / 1_000,
            regularMarketPrice: 2_646.5742,
            chartPreviousClose: 2_635.1133,
          },
        },
      ],
    },
  };
  const point = yahooSectorPoint(payload, cutoffTime);
  assert.equal(point.asOf, "2026-07-27");
  assert.ok(point.change > 0.43 && point.change < 0.44);

  payload.chart.result[0].meta.regularMarketTime =
    Date.parse("2026-07-27T07:05:01.000Z") / 1_000;
  assert.equal(yahooSectorPoint(payload, cutoffTime), null);
});

test("daily market pack maps the API Skill contract without changing report fields", () => {
  const apiMarkets = input.markets.map((market) => ({
    symbol: market.symbol,
    name: market.name,
    region: market.region,
    kind: market.symbol === "DGS10" ? "yield" : "index",
    unit: market.symbol === "DGS10" ? "percent" : "points",
    latest_value: Number.parseFloat(market.value.replaceAll(",", "")),
    previous_value: 1,
    change_value: 1,
    change_ratio: 0.01,
    display_value: market.value,
    display_change: market.change,
    direction: market.direction,
    as_of: market.asOf,
    provider: "fixture",
    source: market.source,
    source_label: "Fixture close",
    provider_attempts: [{ provider: "fixture", status: "ok" }],
  }));
  const normalized = normalizeDailyMarketPack({
    schema_version: "market-data-query.v1",
    status: "ok",
    source: "market_data_query",
    computed_at: "2026-07-25T01:00:01.000Z",
    request: {
      operation: "daily_market_pack",
      cutoff_at: "2026-07-25T01:00:00.000Z",
      persistence: "none",
    },
    summary: { requested: 6, succeeded: 6, failed: 0 },
    data: { markets: apiMarkets, failures: [] },
  });

  assert.deepEqual(
    normalized.markets.map((market) => market.symbol),
    ["SPX", "IXIC", "DJI", "DGS10", "SSE", "CSI300"],
  );
  assert.equal(normalized.markets[3].value, "4.71%");
  assert.match(normalized.markets[3].note, /API Skill/);
  assert.equal(normalized.diagnostics.persistence, "none");
  assert.equal(normalized.diagnostics.providers.length, 6);
});

test("daily market pack rejects partial or incomplete API output", () => {
  assert.throws(
    () =>
      normalizeDailyMarketPack({
        schema_version: "market-data-query.v1",
        status: "partial",
        source: "market_data_query",
        request: {
          operation: "daily_market_pack",
          persistence: "none",
        },
        data: { markets: [], failures: [{ symbol: "SPX" }] },
      }),
    /状态、数量或 contract 无效/,
  );
});

test("BEA official releases enter the verified daily-news pipeline", () => {
  const source = {
    id: "bea-releases",
    label: "U.S. Bureau of Economic Analysis",
    url: "https://www.bea.gov/news/current-releases",
    regions: ["US"],
    tier: "official",
  };
  const releases = parseBeaReleases(
    `<table><tbody>
      <tr class="release-row">
        <td><a href="/news/2026/gross-domestic-product-2nd-quarter-2026">
          Gross Domestic Product, 2nd Quarter 2026
        </a></td>
        <td><time datetime="2026-07-30T08:30:00-04:00">July 30, 2026</time></td>
      </tr>
      <tr class="release-row">
        <td><a href="/news/2026/personal-income-and-outlays-june-2026">
          Personal Income and Outlays, June 2026
        </a></td>
        <td><time datetime="2026-07-30T08:30:00-04:00">July 30, 2026</time></td>
      </tr>
      <tr class="release-row">
        <td><a href="/news/2026/old-release">Old release</a></td>
        <td><time datetime="2026-07-20T08:30:00-04:00">July 20, 2026</time></td>
      </tr>
    </tbody></table>`,
    source,
    Date.parse("2026-07-30T13:00:00.000Z"),
  );

  assert.equal(releases.length, 2);
  assert.deepEqual(
    releases.map((release) => release.publishedAt),
    ["2026-07-30T12:30:00.000Z", "2026-07-30T12:30:00.000Z"],
  );
  assert.ok(
    releases.every(
      (release) =>
        release.url.startsWith("https://www.bea.gov/news/2026/") &&
        release.source === "U.S. Bureau of Economic Analysis" &&
        release._tier === "official",
    ),
  );
});

test("daily contract rejects the old two-stories-per-market floor", () => {
  const thinInput = structuredClone(input);
  thinInput.news = thinInput.news.slice(0, 4);
  thinInput.newsDiagnostics.selectedByMarket = { CN: 2, US: 2 };

  assert.throws(
    () => validateInput(thinInput),
    /每个市场必须包含 3–6 条事实/,
  );
});

test("neutral is a reasoned fallback, never a synonym for missing information", () => {
  const shallowStories = structuredClone(validStories);
  shallowStories[2].tone = "neutral";
  shallowStories[2].interpretation =
    "标题未披露更多信息，因此无法判断对制造业利润与现金流的影响。";
  assert.throws(
    () => validateReport(reportWith(shallowStories), input),
    /以信息不足代替事实核验和影响分析/,
  );

  const neutralInput = structuredClone(input);
  neutralInput.news[2].title = "China industrial conditions remain stable";
  neutralInput.news[2].facts =
    "China industrial output, new orders, and capacity utilization were broadly stable, leaving aggregate demand and supply expectations unchanged.";
  const reasonedStories = structuredClone(validStories);
  reasonedStories[2] = {
    ...reasonedStories[2],
    title: "中国工业供需总体稳定",
    summary: "中国工业产出、订单与产能利用率总体稳定。",
    tone: "neutral",
    interpretation:
      "供需与产能利用率整体稳定，未改变企业收入和成本预期，对制造业利润与估值的净影响为中性。",
  };
  assert.equal(
    validateReport(reportWith(reasonedStories), neutralInput).stories[2].tone,
    "neutral",
  );
});

test("news selection removes personal-finance and stock-pick noise", () => {
  const selected = selectNews([
    {
      title: "Apple earnings guidance rises as revenue grows",
      url: "https://example.com/apple-earnings",
      source: "Example Wire",
      publishedAt: "2026-07-24T20:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "The 10 best stocks to buy now for your retirement",
      url: "https://example.com/personal-finance/stocks",
      source: "Example Wire",
      publishedAt: "2026-07-24T21:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "Treasury yields rise as inflation data changes rate outlook",
      url: "https://example.com/treasury-yields",
      source: "Second Wire",
      publishedAt: "2026-07-24T22:00:00.000Z",
      regions: ["US"],
    },
    {
      title:
        "葛卫东：“我是相信没结束的，谁停下，接下来的就会遭到降维打击”",
      url: "https://example.com/investor-commentary",
      source: "Example Wire",
      publishedAt: "2026-07-24T22:10:00.000Z",
      regions: ["CN"],
      facts:
        "知名私募投资人在朋友圈发文，表达对人工智能产业与市场的个人观点。",
    },
    {
      title:
        "摩根大通推演美联储决议 认为按兵不动并释放鸽派信号对股市最为有利",
      url: "https://example.com/bank-scenario",
      source: "Example Wire",
      publishedAt: "2026-07-24T22:20:00.000Z",
      regions: ["US"],
      facts: "市场情报团队给出多种情景及其主观概率。",
    },
    {
      title:
        "Fed meeting live: Federal Reserve expected to hold rates steady",
      url: "https://example.com/fed-preview",
      source: "Example Wire",
      publishedAt: "2026-07-24T22:30:00.000Z",
      regions: ["US"],
      facts: "The policy decision has not yet been released.",
    },
  ]);

  assert.deepEqual(
    selected.map((item) => item.url),
    [
      "https://example.com/apple-earnings",
      "https://example.com/treasury-yields",
    ],
  );
});

test("structured feed parsing preserves Chinese stories and strips tracking", () => {
  const now = Date.parse("2026-07-25T01:00:00.000Z");
  const feed = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title><![CDATA[A股成交回升，半导体需求改善]]></title>
        <link rel="alternate" href="https://example.com/cn-story?utm_source=rss&amp;id=7" />
        <updated>2026-07-24T10:00:00.000Z</updated>
        <summary><![CDATA[A股成交额较前一交易日回升，半导体订单同步改善，国内芯片供应商收入预期获得支撑。]]></summary>
      </entry>
    </feed>`;

  const [story] = parseFeed(feed, "Fixture", now, ["CN"]);
  assert.equal(story.title, "A股成交回升，半导体需求改善");
  assert.equal(story.url, "https://example.com/cn-story?id=7");
  assert.ok(story.facts.includes("半导体订单"));
  assert.equal(normalizeTextKey("A股 · 上证"), "a股上证");
  assert.equal(
    canonicalizeUrl("https://example.com/a?utm_campaign=x&id=1#top"),
    "https://example.com/a?id=1",
  );
});

test("Chinese feeds use their source timezone and market tabs stay isolated", () => {
  const feed = `<?xml version="1.0"?>
    <rss><channel><item>
      <title>中国工业数据改善制造业预期</title>
      <link>https://example.cn/industry</link>
      <pubDate>2026-07-24 09:30:00</pubDate>
      <description>中国工业产出增长，制造业需求和盈利预期获得数据支持。</description>
    </item></channel></rss>`;
  const [story] = parseFeed(
    feed,
    "国家统计局",
    Date.parse("2026-07-24T02:00:00.000Z"),
    ["CN"],
    { timezoneOffset: "+08:00" },
  );

  assert.equal(story.publishedAt, "2026-07-24T01:30:00.000Z");
  assert.deepEqual(
    classifyMarketRegions("美股存储芯片指数收跌约7.3%", ["CN"]),
    ["US"],
  );
  assert.deepEqual(
    classifyMarketRegions("A股量化交易监管规则完善", ["US"]),
    ["CN"],
  );
});

test("Chinese titles remain distinct and boilerplate facts are rejected", () => {
  const selected = selectNews(
    [
      {
        title: "A股成交回升并带动风险偏好改善",
        facts:
          "A股成交额较前一交易日回升，市场流动性改善并支撑本地权益资产风险偏好。",
        url: "https://example.com/cn-equities",
        source: "财联社",
        publishedAt: "2026-07-24T10:00:00.000Z",
        regions: ["CN"],
      },
      {
        title: "中国央行维持流动性合理充裕",
        facts:
          "中国央行开展公开市场操作，使银行体系流动性继续保持合理充裕。",
        url: "https://example.com/cn-rates",
        source: "官方来源",
        publishedAt: "2026-07-24T11:00:00.000Z",
        regions: ["CN"],
      },
    ],
    { perMarket: 5 },
  );

  assert.equal(selected.length, 2);
  assert.equal(
    usefulFacts(
      "Comprehensive up-to-date news coverage, aggregated from sources all over the world by Google News.",
      "A股风格转换推动红利板块上涨",
    ),
    "",
  );
});

test("header rejects duplicate market numbers and named companies require tickers", () => {
  assert.throws(
    () =>
      validateReport(
        reportWith(validStories, {
          summary: "标普上涨0.05%，纳斯达克回落，市场内部表现继续分化。",
        }),
        input,
      ),
    /顶部总览不得重复具体数字或日期/,
  );

  const missingTicker = structuredClone(input);
  missingTicker.news[0].title =
    "Apple and Nvidia raise guidance as revenue grows";
  const storiesWithoutNvidia = structuredClone(validStories);
  storiesWithoutNvidia[0].title = "苹果与英伟达上调业绩指引";
  storiesWithoutNvidia[0].summary =
    "Apple与Nvidia上调业绩指引，收入增长改善盈利预期。";
  storiesWithoutNvidia[0].sectors = ["消费电子", "半导体"];
  storiesWithoutNvidia[0].tickers = ["AAPL"];
  assert.throws(
    () =>
      validateReport(
        reportWith(storiesWithoutNvidia),
        missingTicker,
      ),
    /必须填写 NVDA/,
  );
});
