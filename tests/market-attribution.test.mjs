import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketSessions,
  causalEventEvidenceMatches,
  classifyNewsKind,
  evidenceFitsSession,
  filterNewsToMarketSessions,
  localMarketWrapMatches,
  sectorExtremes,
  zonedDateTimeIso,
} from "../scripts/market-attribution.mjs";
import { selectNews } from "../scripts/news-pipeline.mjs";
import { validateInput, validateReport } from "../scripts/daily-publish.mjs";
import { sectorHeatScore, topSectorHeat } from "../scripts/sector-heat.mjs";

const sectors = {
  CN: [
    ["932077", "能源", "Energy"], ["932078", "原材料", "Materials"],
    ["932079", "工业", "Industrials"], ["932080", "可选消费", "Consumer Discretionary"],
    ["932081", "主要消费", "Consumer Staples"], ["932082", "医药卫生", "Health Care"],
    ["932083", "金融", "Financials"], ["931775", "房地产", "Real Estate"],
    ["932084", "信息技术", "Information Technology"], ["932085", "通信服务", "Communication Services"],
    ["932086", "公用事业", "Utilities"],
  ],
  US: [
    ["XLC", "通信服务", "Communication Services"], ["XLY", "非必需消费品", "Consumer Discretionary"],
    ["XLP", "必需消费品", "Consumer Staples"], ["XLE", "能源", "Energy"],
    ["XLF", "金融", "Financials"], ["XLV", "医疗保健", "Health Care"],
    ["XLI", "工业", "Industrials"], ["XLB", "原材料", "Materials"],
    ["XLRE", "房地产", "Real Estate"], ["XLK", "信息技术", "Information Technology"],
    ["XLU", "公用事业", "Utilities"],
  ],
};

function performanceRows() {
  return Object.entries(sectors).flatMap(([market, rows]) => rows.map(([symbol, name, nameEn], index) => {
    const change = symbol === "XLB"
      ? 1.3
      : index < 6
        ? 2.2 - index * 0.25
        : -0.4 - (index - 6) * 0.3;
    return {
      market, symbol, name, nameEn,
      score: sectorHeatScore(market, change),
      change: `${change > 0 ? "+" : ""}${change.toFixed(2)}%`,
      direction: change > 0 ? "up" : "down",
      asOf: "2026-08-21",
      source: `https://example.com/${market}/${symbol}`,
      constituents: Array.from({ length: 4 }, (_, constituentIndex) => ({
        symbol: `${market}-${symbol}-${constituentIndex}`,
        name: `代表标的${constituentIndex + 1}`,
        nameEn: `Representative ${constituentIndex + 1}`,
        value: `${100 + constituentIndex}.00`,
        change: constituentIndex % 2 === 0 ? "+1.00%" : "-0.50%",
        direction: constituentIndex % 2 === 0 ? "up" : "down",
        asOf: "2026-08-21",
        source: `https://example.com/${market}/${symbol}/${constituentIndex}`,
      })),
    };
  }));
}

function aiChainRows() {
  const layers = [
    ["chips", "芯片与设备", "Chips & equipment"],
    ["memory", "存储", "Memory"],
    ["servers", "服务器与算力设备", "Servers & compute systems"],
    ["interconnect", "CPO / 光互连", "CPO / optical interconnects"],
    ["data_center", "数据中心电力与液冷", "Data-center power & cooling"],
    ["cloud", "云计算 / NeoCloud", "Cloud / NeoCloud"],
    ["applications", "AI 软件与应用", "AI software & applications"],
    ["robotics", "机器人", "Robotics"],
  ];
  return ["CN", "US"].flatMap((market) =>
    layers.map(([layer, name, nameEn], index) => ({
      market,
      layer,
      name,
      nameEn,
      benchmark: "4只代表标的等权篮子",
      benchmarkEn: "Equal-weight basket of 4 representative stocks",
      benchmarkKind: "equal_weight_basket",
      symbol: `AI-${market}-${layer}`,
      change: index % 2 === 0 ? "+1.00%" : "-0.50%",
      direction: index % 2 === 0 ? "up" : "down",
      asOf: "2026-08-21",
      source: `https://example.com/ai/${market}/${layer}`,
      constituents: Array.from({ length: 4 }, (_, constituentIndex) => ({
        symbol: `${market}${index}${constituentIndex}`,
        name: `标的${index}${constituentIndex}`,
        nameEn: `Stock ${index}${constituentIndex}`,
        value: `${100 + constituentIndex}.00`,
        change: constituentIndex % 2 === 0 ? "+1.00%" : "-0.50%",
        direction: constituentIndex % 2 === 0 ? "up" : "down",
        asOf: "2026-08-21",
        source: `https://example.com/ai/${market}/${layer}/${constituentIndex}`,
      })),
    })),
  );
}

function fixtureInput() {
  const performance = performanceRows();
  const marketDefs = [
    ["SPX", "US"], ["IXIC", "US"], ["DJI", "US"], ["DGS10", "US"],
    ["SSE", "CN"], ["SZSE", "CN"], ["CSI300", "CN"], ["CSI500", "CN"],
    ["CHINEXT", "CN"], ["STAR50", "CN"],
  ];
  const markets = marketDefs.map(([symbol, region]) => ({
    name: symbol,
    symbol,
    region,
    value: "100.00",
    change: "+0.50%",
    direction: "up",
    note: "收盘",
    source: `https://example.com/${symbol}`,
    asOf: "2026-08-21",
    previousAsOf: "2026-08-20",
  }));
  const news = [
    {
      title: "8月21日A股收评：创业板领涨，贵金属、锂矿与通信设备走强",
      facts: "A股收盘时创业板指上涨，贵金属、能源金属与通信设备板块同步走强，报道列明黄金、锂矿和通信设备的当日催化。",
      url: "https://example.com/cn-wrap",
      source: "CN Wire",
      publishedAt: "2026-08-21T07:20:00.000Z",
      regions: ["CN"],
      kind: "market_wrap",
    },
    {
      title: "Wall Street rises as business activity and miners support stocks",
      facts: "The S&P 500 and Dow closed higher as business activity reached a multi-year high and mining shares advanced, while Treasury yields also rose.",
      url: "https://example.com/us-wrap",
      source: "US Wire",
      publishedAt: "2026-08-21T20:23:00.000Z",
      regions: ["US"],
      kind: "market_wrap",
    },
    {
      title: "8月21日CPO概念股走强：半年报兑现叠加光互连技术进展",
      facts: "CPO概念股在8月21日走强，多家公司半年报利润同比增长，技术论文同时梳理共封装光学从二维到三维堆叠的路线及带宽、时延和能耗价值。",
      url: "https://example.com/cn-ai-cpo",
      source: "CN AI Wire",
      publishedAt: "2026-08-21T05:44:00.000Z",
      regions: ["CN"],
      kind: "event",
    },
    {
      title: "锂供应收紧与金价高位支撑原材料",
      facts: "行业机构发布供应报告，确认锂矿减产与黄金需求上升，并说明相关变化发生在本次A股交易窗口内。",
      url: "https://example.com/cn-materials-event",
      source: "CN Industry Wire",
      publishedAt: "2026-08-21T05:10:00.000Z",
      regions: ["CN"],
      kind: "event",
    },
    {
      title: "Business activity and earnings supported U.S. cyclicals",
      facts: "S&P Global reported a multi-year high in business activity and Ross Stores raised earnings guidance during the completed U.S. trading session.",
      url: "https://example.com/us-cyclical-event",
      source: "US Business Wire",
      publishedAt: "2026-08-21T15:10:00.000Z",
      regions: ["US"],
      kind: "event",
    },
  ];
  return {
    schemaVersion: 9,
    contractVersion: "market-attribution-v9",
    runId: "test-v9",
    reportDate: "2026-08-22",
    updateKind: "morning",
    cutoffAt: "2026-08-22T01:00:00.000Z",
    collectedAt: "2026-08-22T01:00:01.000Z",
    markets,
    marketDataDiagnostics: {
      schemaVersion: "market-data-query.v1",
      status: "ok",
      source: "market_data_query",
      computedAt: "2026-08-22T01:00:01.000Z",
      cutoffAt: "2026-08-22T01:00:00.000Z",
      persistence: "none",
      marketCount: 10,
      providers: markets.map((market) => ({
        symbol: market.symbol,
        provider: "fixture",
        asOf: market.asOf,
        previousAsOf: market.previousAsOf,
      })),
    },
    marketSessions: buildMarketSessions(markets),
    sectorPerformance: performance,
    aiChainPerformance: aiChainRows(),
    sectorHeat: [
      ...topSectorHeat(performance.filter((item) => item.market === "CN")),
      ...topSectorHeat(performance.filter((item) => item.market === "US")),
    ],
    news,
    newsDiagnostics: {
      mode: "audited", candidateCount: 5, hydratedCount: 5,
      rejectedDuringHydration: 0, selectedByMarket: { CN: 3, US: 2 },
      minimumPerMarket: 0, targetPerMarket: 8, sources: [],
      activeRetrieval: {
        attempted: false,
        queryCount: 0,
        candidateCount: 0,
        hydratedCount: 0,
        rejectedDuringHydration: 0,
        searches: [],
        coverageByMarket: {
          CN: {
            status: "adequate",
            activeSearchRequired: false,
            activeSearchCompleted: true,
            missingIntentKinds: [],
          },
          US: {
            status: "adequate",
            activeSearchRequired: false,
            activeSearchCompleted: true,
            missingIntentKinds: [],
          },
        },
      },
    },
  };
}

function fixtureReport() {
  return {
    headline: "贵金属与矿业股走强，中美股指收涨",
    summary: "中国创业板与美国主要股指均收涨，但两个市场分别由本地行业表现和同交易时段消息解释。",
    marketViews: {
      CN: {
        headline: "贵金属与通信走强，创业板领涨",
        summary: "贵金属、锂矿与通信设备的同日催化对应相关行业走强，并带动创业板表现领先。",
        driverStatus: "explained",
      },
      US: {
        headline: "矿业股走强，道指领涨美股",
        summary: "矿业股上涨为风险资产提供支撑，但商业活动数据同时推高长端收益率，只能作部分归因。",
        driverStatus: "partial",
      },
    },
    aiChainViews: {
      CN: {
        headline: "CPO / 光互连走强，AI链上行",
        summary: "CPO业绩兑现与技术路线进展对应光互连代表篮子走强，但其他环节表现仍有分化。",
        driverStatus: "explained",
      },
      US: {
        headline: "AI 软件与应用走强，云计算 / NeoCloud走弱",
        summary: "美国AI代表篮子涨跌分化，未发现单一消息主导各产业层的当日表现。",
        driverStatus: "unattributed",
      },
    },
    drivers: [
      {
        market: "CN", role: "primary", direction: "positive",
        title: "贵金属与锂矿走强",
        summary: "收盘归因显示贵金属、能源金属与通信设备同步上涨。",
        mechanism: "黄金和锂矿催化抬升原材料行业表现，通信设备走强进一步支撑成长板块。",
        sectorSymbols: ["932078", "932085"], evidenceIndexes: [0, 3],
      },
      {
        market: "US", role: "primary", direction: "positive",
        title: "矿业股提供结构性支撑",
        summary: "矿业股上涨，是美国主要股指收高的支撑之一。",
        mechanism: "资源股收益改善支撑原材料，但不能单独解释指数涨幅，长端收益率上行也形成反向约束。",
        sectorSymbols: ["XLB"], evidenceIndexes: [1, 4],
      },
    ],
    aiChainUpdates: [
      {
        market: "CN",
        layer: "interconnect",
        title: "CPO业绩兑现与技术路线共振",
        summary: "CPO概念股在8月21日走强，多家公司半年报利润增长，同时出现从二维共封装到三维堆叠的技术路线梳理。",
        implication: "业绩兑现提供当期基本面支撑，技术路线则强化光互连缓解AI算力带宽、时延和能耗瓶颈的中期预期。",
        evidenceIndexes: [2],
      },
    ],
    translations: {
      en: {
        headline: "Materials and miners led as Chinese and U.S. stocks rose",
        summary: "Chinese growth shares and major U.S. indexes rose for different, locally verified reasons.",
        marketViews: {
          CN: {
            headline: "Materials and communication services led as Chinese stocks rose",
            summary: "Precious metals, lithium and communication-equipment catalysts matched the local sector advance.",
          },
          US: {
            headline: "Miners advanced as the Dow led U.S. stocks",
            summary: "Mining shares supported equities while activity also lifted long yields, leaving only a partial attribution.",
          },
        },
        aiChainViews: {
          CN: {
            headline: "CPO / optical interconnects rose as China's AI basket advanced",
            summary: "CPO earnings delivery and a clearer technology roadmap matched strength in the optical-interconnect basket.",
          },
          US: {
            headline: "AI software rose while Cloud / NeoCloud lagged",
            summary: "U.S. AI baskets diverged and no single verified catalyst dominated the day across layers.",
          },
        },
        drivers: [
          {
            title: "Precious metals and lithium advanced",
            summary: "The close wrap showed metals and communication equipment rising together.",
            mechanism: "Gold and lithium catalysts lifted materials while communication equipment supported growth shares.",
          },
          {
            title: "Miners provided structural support",
            summary: "Mining shares advanced and were one support as major U.S. indexes closed higher.",
            mechanism: "Resource earnings supported Materials without fully explaining the indexes, while long yields created a counterweight.",
          },
        ],
        aiChainUpdates: [
          {
            title: "CPO earnings delivery met a clearer technology roadmap",
            summary: "CPO shares rose on August 21 as several companies delivered higher first-half profits and a paper mapped the path from 2D packaging to 3D stacking.",
            implication: "Earnings supported current fundamentals while the roadmap reinforced the case for optical links to ease AI bandwidth, latency and energy constraints.",
          },
        ],
      },
    },
  };
}

test("market sessions use each venue close and allow wraps for two hours", () => {
  assert.equal(zonedDateTimeIso("2026-08-21", 15, "Asia/Shanghai"), "2026-08-21T07:00:00.000Z");
  assert.equal(zonedDateTimeIso("2026-08-21", 16, "America/New_York"), "2026-08-21T20:00:00.000Z");
  const input = fixtureInput();
  assert.equal(classifyNewsKind(input.news[0]), "market_wrap");
  assert.equal(evidenceFitsSession(input.news[1], input.marketSessions[1]), true);
  const late = { ...input.news[1], publishedAt: "2026-08-21T22:00:01.000Z" };
  assert.equal(evidenceFitsSession(late, input.marketSessions[1]), false);
});

test("completed local wraps reject China midday and Canadian market recaps", () => {
  const input = fixtureInput();
  const cnMidday = {
    title: "A股午间收评：创业板半日下跌，消费股走强",
    facts: "午间收盘时上证指数下跌0.15%，创业板指下跌1.43%。",
    url: "https://example.com/cn-midday",
    source: "CN Wire",
    publishedAt: "2026-08-21T03:30:00.000Z",
    regions: ["CN"],
    kind: "market_wrap",
  };
  assert.equal(evidenceFitsSession(cnMidday, input.marketSessions[0]), false);
  assert.equal(
    localMarketWrapMatches(
      cnMidday,
      "CN",
      input.sectorPerformance,
      input.marketSessions[0],
    ),
    false,
  );

  const canada = {
    title: "尽管美加贸易谈判破裂，加拿大股市仍上涨",
    facts: "标普/多伦多证交所综合指数收涨，材料板块上涨，美国宣布提高加拿大钢铁关税。",
    url: "https://example.com/canada-close",
    source: "Canada Wire",
    publishedAt: "2026-08-21T20:20:00.000Z",
    regions: ["US"],
    kind: "market_wrap",
  };
  assert.equal(
    localMarketWrapMatches(
      canada,
      "US",
      input.sectorPerformance,
      input.marketSessions[1],
    ),
    false,
  );

  const fullClose = {
    title: "8月21日收评：沪指探底回升涨0.19%",
    facts:
      "市场全天震荡分化，贵金属板块下挫，个股盘中跌停。截止收盘沪指涨0.19%。",
    url: "https://example.com/cn-close",
    source: "CN Wire",
    publishedAt: "2026-08-21T07:00:47.000Z",
    regions: ["CN"],
    kind: "market_wrap",
  };
  assert.equal(
    localMarketWrapMatches(
      fullClose,
      "CN",
      input.sectorPerformance,
      input.marketSessions[0],
    ),
    true,
  );
});

test("causal evidence excludes price, breadth and fund-flow observations", () => {
  assert.equal(
    causalEventEvidenceMatches({
      kind: "event",
      title: "主力资金监控：有色金属净流出52亿元",
      facts: "两市成交额缩量，半导体领跌，个股上涨家数仍占多数。",
    }),
    false,
  );
  assert.equal(
    causalEventEvidenceMatches({
      kind: "event",
      title: "公司上调全年业绩指引",
      facts: "公司发布财报并宣布新增订单，全年利润指引上调。",
    }),
    true,
  );
});

test("session filtering happens before ranking so an in-window X source is retained", () => {
  const sessions = fixtureInput().marketSessions;
  const candidates = [
    {
      title: "@NVIDIA：AI infrastructure update after the attribution window",
      facts: "NVIDIA published an AI infrastructure update covering chips, servers and networking after the local market attribution window closed.",
      url: "https://x.com/NVIDIA/status/2000000000000000001",
      source: "NVIDIA",
      publishedAt: "2026-08-22T02:00:00.000Z",
      regions: ["CN"],
      platform: "x",
      authority: "first_party",
      _tier: "official",
    },
    {
      title: "@trendforce：CPO and silicon photonics for AI infrastructure",
      facts: "TrendForce reported that memory suppliers were expanding CPO and silicon-photonics work for next-generation AI infrastructure.",
      url: "https://x.com/trendforce/status/2000000000000000002",
      source: "TrendForce",
      publishedAt: "2026-08-20T07:14:47.000Z",
      regions: ["CN", "US"],
      platform: "x",
      authority: "specialist",
      _tier: "publisher",
    },
  ];
  const eligible = filterNewsToMarketSessions(candidates, sessions);
  const selected = selectNews(eligible, {
    perMarket: 1,
    minimumScore: 0,
    includeInternal: true,
  });
  assert.deepEqual(selected.map((item) => item.url), [candidates[1].url]);
  assert.deepEqual(selected[0].regions, ["CN"]);
});

test("verified specialist X reporting outranks uncorroborated expert commentary", () => {
  const specialist = {
    title: "@trendforce：CPO silicon photonics capacity expands for AI infrastructure",
    facts: "TrendForce reported a concrete CPO and silicon-photonics capacity expansion by named memory suppliers for next-generation AI infrastructure.",
    url: "https://x.com/trendforce/status/2000000000000000003",
    source: "TrendForce",
    publishedAt: "2026-08-20T07:14:47.000Z",
    regions: ["CN"],
    platform: "x",
    authority: "specialist",
    _tier: "publisher",
  };
  const expert = {
    ...specialist,
    title: "@commentator：AI infrastructure will change the market",
    facts: "A commentator predicted that AI infrastructure would eventually change the market and offered a personal view about future returns.",
    url: "https://x.com/commentator/status/2000000000000000004",
    source: "Commentator",
    authority: "expert",
    _tier: "expert",
  };
  const selected = selectNews([expert, specialist], {
    perMarket: 1,
    minimumScore: 0,
    includeInternal: true,
  });
  assert.equal(selected[0].url, specialist.url);
});

test("V9 keeps all eleven sectors and accepts distinct local drivers", () => {
  const input = validateInput(fixtureInput());
  assert.equal(input.sectorPerformance.filter((item) => item.market === "CN").length, 11);
  assert.equal(input.sectorPerformance[0].constituents.length, 4);
  assert.equal(input.sectorPerformance[0].constituents[0].value, "100.00");
  assert.equal(input.aiChainPerformance.filter((item) => item.market === "CN").length, 8);
  assert.equal(input.aiChainPerformance[0].constituents[0].value, "100.00");
  assert.equal(sectorExtremes(input.sectorPerformance, "US").leaders.length, 3);
  const report = validateReport(fixtureReport(), input);
  assert.equal(report.drivers.length, 2);
  assert.notEqual(report.drivers[0].market, report.drivers[1].market);
  assert.equal(report.marketViews.CN.driverIds.length, 1);
  assert.equal(report.aiChainUpdates.length, 1);
});

test("V9 rejects a driver supported only by descriptive market observations", () => {
  const rawInput = fixtureInput();
  rawInput.news.push({
    title: "主力资金监控：原材料板块净流出",
    facts: "盘中主力资金从原材料板块净流出，两市成交额缩量，个股上涨家数仍占多数。",
    url: "https://example.com/cn-fund-flow",
    source: "CN Flow Monitor",
    publishedAt: "2026-08-21T06:10:00.000Z",
    regions: ["CN"],
    kind: "event",
  });
  rawInput.newsDiagnostics.selectedByMarket.CN = 4;
  const input = validateInput(rawInput);
  const report = fixtureReport();
  report.drivers[0].evidenceIndexes = [0, 5];
  assert.throws(
    () => validateReport(report, input),
    /缺少独立的因果事件证据/,
  );
});

test("V9 rejects representative baskets without a verified close price", () => {
  const input = fixtureInput();
  delete input.sectorPerformance[0].constituents[0].value;
  assert.throws(() => validateInput(input), /constituents 字段无效/);

  const aiInput = fixtureInput();
  delete aiInput.aiChainPerformance[0].constituents[0].value;
  assert.throws(() => validateInput(aiInput), /constituents 字段无效/);
});

test("V9 requires the API pack to preserve each prior trading session", () => {
  const input = fixtureInput();
  input.marketDataDiagnostics.providers[0].previousAsOf = "2026-08-19";
  assert.throws(
    () => validateInput(input),
    /包含前一交易日的完整 API daily-pack/,
  );
});

test("V9 permits zero drivers but rejects generic headlines", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport();
  report.drivers = [];
  report.marketViews.CN = {
    headline: "原材料走强，A股收涨",
    summary: "行业表现分化，未发现单一消息主导本次大盘上涨。",
    driverStatus: "unattributed",
  };
  report.marketViews.US = {
    headline: "原材料走强，美股收涨",
    summary: "行业表现分化，未发现单一消息主导本次大盘上涨。",
    driverStatus: "unattributed",
  };
  report.headline = "原材料走强，中美股指收涨";
  report.translations.en.drivers = [];
  report.aiChainUpdates = [];
  report.translations.en.aiChainUpdates = [];
  report.aiChainViews.CN = {
    headline: "CPO / 光互连走强，AI链上行",
    summary: "AI代表篮子涨跌分化，未发现单一消息主导各产业层的当日表现。",
    driverStatus: "unattributed",
  };
  report.translations.en.aiChainViews.CN = {
    headline: "CPO / optical interconnects rose as China's AI basket advanced",
    summary: "AI baskets diverged and no single verified catalyst dominated the day across layers.",
  };
  report.translations.en.marketViews.CN.headline = "Materials led as Chinese stocks rose";
  report.translations.en.marketViews.US.headline = "Materials led as U.S. stocks rose";
  report.translations.en.headline = "Materials led as Chinese and U.S. stocks rose";
  assert.equal(validateReport(report, input).drivers.length, 0);
  report.marketViews.CN.headline = "市场股指全面普涨";
  assert.throws(() => validateReport(report, input), /必须包含可回溯的原因或行业|无原因标题/);
});

test("V9 derives an insufficient-evidence reader state from coverage diagnostics", () => {
  const rawInput = fixtureInput();
  rawInput.newsDiagnostics.activeRetrieval.attempted = true;
  rawInput.newsDiagnostics.activeRetrieval.queryCount = 1;
  rawInput.newsDiagnostics.activeRetrieval.searches = [{
    market: "CN",
    status: "error",
    intentIds: ["CN:market-wrap"],
    intentResults: [{
      id: "CN:market-wrap",
      kind: "market_wrap",
      resultCount: 0,
    }],
    resultCount: 0,
    durationMs: 12,
    error: "HTTP 429",
  }];
  rawInput.newsDiagnostics.activeRetrieval.coverageByMarket.CN = {
    status: "insufficient",
    activeSearchRequired: true,
    activeSearchCompleted: false,
    missingIntentKinds: ["market_wrap", "ai_extremes"],
  };
  const input = validateInput(rawInput);
  const report = fixtureReport();
  report.drivers = report.drivers.filter((driver) => driver.market !== "CN");
  report.translations.en.drivers = report.translations.en.drivers.filter(
    (_, index) => fixtureReport().drivers[index].market !== "CN",
  );
  report.marketViews.CN = {
    headline: "原材料走强，A股收涨",
    summary: "行业表现分化，未发现单一消息主导本次大盘上涨。",
    driverStatus: "unattributed",
  };
  report.translations.en.marketViews.CN = {
    headline: "Materials led as Chinese stocks rose",
    summary: "Sector performance diverged and no single verified catalyst dominated the session.",
  };
  report.aiChainUpdates = [];
  report.translations.en.aiChainUpdates = [];
  report.aiChainViews.CN = {
    headline: "CPO / 光互连走强，AI链上行",
    summary: "AI代表篮子涨跌分化，未发现单一消息主导各产业层的当日表现。",
    driverStatus: "unattributed",
  };
  report.translations.en.aiChainViews.CN = {
    headline: "CPO / optical interconnects rose as China's AI basket advanced",
    summary: "AI baskets diverged and no single verified catalyst dominated the day across layers.",
  };
  const validated = validateReport(report, input);
  assert.equal(validated.marketViews.CN.driverStatus, "insufficient");
  assert.match(validated.marketViews.CN.summary, /证据覆盖不足/);
  assert.equal(validated.aiChainViews.CN.driverStatus, "insufficient");
  assert.match(validated.translations.en.marketViews.CN.summary, /evidence is incomplete/i);
});

test("V9 rejects a pure US item as a CN driver and rejects opposite sector direction", () => {
  const input = validateInput(fixtureInput());
  const crossMarket = fixtureReport();
  crossMarket.drivers[0].evidenceIndexes = [1, 4];
  assert.throws(() => validateReport(crossMarket, input), /归因窗口之外|缺少本地收盘归因证据/);

  const opposite = fixtureReport();
  opposite.drivers[0].direction = "negative";
  opposite.drivers[0].sectorSymbols = ["932078"];
  assert.throws(() => validateReport(opposite, input), /行业涨跌方向不一致/);
});

test("AI attribution requires a non-X source whenever an X post is cited", () => {
  const rawInput = fixtureInput();
  rawInput.news.push({
    title: "@NVIDIANetworkng：CPO optical interconnect roadmap update",
    facts: "NVIDIA Networking published a detailed CPO optical interconnect roadmap update covering bandwidth, latency, thermal management and manufacturing constraints for AI systems.",
    url: "https://x.com/NVIDIANetworkng/status/1234567890",
    source: "NVIDIA Networking",
    publishedAt: "2026-08-21T05:30:00.000Z",
    regions: ["CN"],
    kind: "event",
    platform: "x",
    authority: "first_party",
    authorHandle: "NVIDIANetworkng",
  });
  rawInput.newsDiagnostics.selectedByMarket.CN = 4;
  const input = validateInput(rawInput);
  const xOnly = fixtureReport();
  xOnly.aiChainUpdates[0].evidenceIndexes = [5];
  assert.throws(
    () => validateReport(xOnly, input),
    /必须包含非 X 交叉验证来源/,
  );

  const corroborated = fixtureReport();
  corroborated.aiChainUpdates[0].evidenceIndexes = [2, 5];
  assert.equal(validateReport(corroborated, input).aiChainUpdates.length, 1);
});
