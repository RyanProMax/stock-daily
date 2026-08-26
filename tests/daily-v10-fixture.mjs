import { buildMarketBriefs } from "../scripts/daily-collect.mjs";
import { buildMarketSessions } from "../scripts/market-attribution.mjs";
import { sectorHeatScore, topSectorHeat } from "../scripts/sector-heat.mjs";

const sectorDefinitions = {
  CN: [
    ["932077", "能源", "Energy"],
    ["932078", "原材料", "Materials"],
    ["932079", "工业", "Industrials"],
    ["932080", "可选消费", "Consumer Discretionary"],
    ["932081", "主要消费", "Consumer Staples"],
    ["932082", "医药卫生", "Health Care"],
    ["932083", "金融", "Financials"],
    ["931775", "房地产", "Real Estate"],
    ["932084", "信息技术", "Information Technology"],
    ["932085", "通信服务", "Communication Services"],
    ["932086", "公用事业", "Utilities"],
  ],
  US: [
    ["XLC", "通信服务", "Communication Services"],
    ["XLY", "非必需消费品", "Consumer Discretionary"],
    ["XLP", "必需消费品", "Consumer Staples"],
    ["XLE", "能源", "Energy"],
    ["XLF", "金融", "Financials"],
    ["XLV", "医疗保健", "Health Care"],
    ["XLI", "工业", "Industrials"],
    ["XLB", "原材料", "Materials"],
    ["XLRE", "房地产", "Real Estate"],
    ["XLK", "信息技术", "Information Technology"],
    ["XLU", "公用事业", "Utilities"],
  ],
};

const aiDefinitions = [
  ["chips", "芯片与设备", "Chips & equipment"],
  ["memory", "存储", "Memory"],
  ["servers", "服务器与算力设备", "Servers & compute systems"],
  ["interconnect", "光互连", "Optical interconnects"],
  ["data_center", "数据中心电力与液冷", "Data-center power & cooling"],
  ["cloud", "云计算", "Cloud"],
  ["applications", "智能软件与应用", "Intelligent software & applications"],
  ["robotics", "机器人", "Robotics"],
];

function direction(change) {
  return change > 0 ? "up" : change < 0 ? "down" : "flat";
}

function changeText(change) {
  return `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
}

function constituents(market, group, asOf) {
  return Array.from({ length: 4 }, (_, index) => {
    const change = index % 2 === 0 ? 1 : -0.5;
    return {
      symbol: `${market}-${group}-${index}`,
      name: `代表标的${index + 1}`,
      nameEn: `Representative ${index + 1}`,
      value: `${100 + index}.00`,
      change: changeText(change),
      direction: direction(change),
      asOf,
      source: `https://quotes.example.com/${market}/${group}/${index}`,
    };
  });
}

function sectorRows(asOf) {
  return Object.entries(sectorDefinitions).flatMap(([market, definitions]) =>
    definitions.map(([symbol, name, nameEn], index) => {
      const change =
        market === "US" && symbol === "XLB"
          ? 1.3
          : index < 6
            ? 2.2 - index * 0.25
            : -0.4 - (index - 6) * 0.3;
      return {
        market,
        symbol,
        name,
        nameEn,
        score: sectorHeatScore(market, change),
        change: changeText(change),
        direction: direction(change),
        asOf,
        source: `https://quotes.example.com/${market}/${symbol}`,
        constituents: constituents(market, symbol, asOf),
      };
    }),
  );
}

function aiRows(asOf) {
  return ["CN", "US"].flatMap((market) =>
    aiDefinitions.map(([layer, name, nameEn], index) => {
      const change = index % 2 === 0 ? 1 : -0.5;
      return {
        market,
        layer,
        name,
        nameEn,
        benchmark: "四只代表标的等权篮子",
        benchmarkEn: "Equal-weight basket of representative stocks",
        benchmarkKind: "equal_weight_basket",
        symbol: `AI-${market}-${layer}`,
        change: changeText(change),
        direction: direction(change),
        asOf,
        source: `https://quotes.example.com/ai/${market}/${layer}`,
        constituents: constituents(market, `ai-${layer}`, asOf),
      };
    }),
  );
}

export function fixtureInput() {
  const asOf = "2026-08-21";
  const previousAsOf = "2026-08-20";
  const definitions = [
    ["SPX", "US"],
    ["IXIC", "US"],
    ["DJI", "US"],
    ["DGS10", "US"],
    ["SSE", "CN"],
    ["SZSE", "CN"],
    ["CSI300", "CN"],
    ["CSI500", "CN"],
    ["CHINEXT", "CN"],
    ["STAR50", "CN"],
  ];
  const markets = definitions.map(([symbol, region], index) => {
    const change = index % 3 === 1 ? -0.25 : 0.5;
    return {
      name: symbol,
      symbol,
      region,
      value: "100.00",
      change: symbol === "DGS10" ? "+5 bp" : changeText(change),
      direction: direction(change),
      note: "日收盘",
      source: `https://quotes.example.com/index/${symbol}`,
      asOf,
      previousAsOf,
    };
  });
  const sectorPerformance = sectorRows(asOf);
  const aiChainPerformance = aiRows(asOf);
  const marketSessions = buildMarketSessions(markets);
  const input = {
    schemaVersion: 10,
    contractVersion: "codex-market-research-v11",
    runId: "test-v10-run",
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
    marketSessions,
    sectorPerformance,
    aiChainPerformance,
    sectorHeat: [
      ...topSectorHeat(
        sectorPerformance.filter((item) => item.market === "CN"),
      ),
      ...topSectorHeat(
        sectorPerformance.filter((item) => item.market === "US"),
      ),
    ],
  };
  input.marketBriefs = buildMarketBriefs(input);
  return structuredClone(input);
}

function marketEvidence(input, market, source, title, facts) {
  const session = input.marketSessions.find((item) => item.market === market);
  return {
    title,
    facts,
    source,
    sourceLabel: "交易行情",
    publishedAt: session.windowEnd,
    kind: "market_data",
    sourceType: "first_party",
    platform: "web",
    authorHandle: "",
  };
}

function externalEvidence({ market, title, facts, source, sourceLabel, publishedAt, kind = "official", sourceType = "first_party" }) {
  return {
    title,
    facts,
    source,
    sourceLabel,
    publishedAt,
    kind,
    sourceType,
    platform: "web",
    authorHandle: "",
  };
}

export function fixtureReport(input = fixtureInput()) {
  const cnMaterials = input.sectorPerformance.find(
    (item) => item.market === "CN" && item.symbol === "932078",
  );
  const cnUtilities = input.sectorPerformance.find(
    (item) => item.market === "CN" && item.symbol === "932086",
  );
  const usMaterials = input.sectorPerformance.find(
    (item) => item.market === "US" && item.symbol === "XLB",
  );
  const usTechnology = input.sectorPerformance.find(
    (item) => item.market === "US" && item.symbol === "XLK",
  );
  const cnInterconnect = input.aiChainPerformance.find(
    (item) => item.market === "CN" && item.layer === "interconnect",
  );
  return {
    contractVersion: "codex-market-research-v11",
    headline: "中美市场行业轮动分化，材料方向获得事件支撑",
    summary: "两个市场均呈现明显的行业强弱分化；材料方向有同交易窗口的直接信息支持，其余表现更适合按盘面结构理解。",
    marketViews: {
      CN: {
        headline: "原材料走强，防御行业相对承压",
        summary: "供应变化为原材料表现提供直接支撑，同时公用事业的落后显示资金并非全面推高所有行业。",
        driverStatus: "explained",
      },
      US: {
        headline: "材料行业领涨，科技行业相对落后",
        summary: "商业活动信息与材料行业上涨方向一致，但科技行业走弱说明市场内部仍有显著分化。",
        driverStatus: "explained",
      },
    },
    aiChainViews: {
      CN: {
        headline: "光互连相对走弱，订单信息提供局部解释",
        summary: "光互连代表篮子落后，同时公司披露的订单变化只解释该环节的一部分表现。",
        mechanism: "公司披露的订单确认节奏放缓可能压低短期收入预期，因此能局部解释光互连环节承压。",
        driverStatus: "partial",
      },
      US: {
        headline: "智能产业链内部轮动，强弱环节并存",
        summary: "代表篮子之间方向分化，现有证据更适合描述环节轮动，不足以归结为单一事件。",
        mechanism: "原因未证实：当前只能确认代表成分股与篮子构成造成环节分化，没有直接证据把当天涨跌归因于同一催化。",
        driverStatus: "structural",
      },
    },
    drivers: [
      {
        market: "CN",
        role: "primary",
        basis: "event",
        direction: "positive",
        title: "供应变化支撑原材料行业",
        summary: "官方披露的供应变化与原材料行业走强方向一致，为该行业表现提供直接支撑。",
        mechanism: "供应收紧预期改善相关企业的价格与盈利预期，并吸引资金向原材料行业集中。",
        sectorSymbols: ["932078"],
        evidence: [
          marketEvidence(
            input,
            "CN",
            cnMaterials.source,
            "原材料行业收盘表现",
            "原材料行业代表篮子在本次交易日收涨，方向与该驱动一致。",
          ),
          externalEvidence({
            market: "CN",
            title: "行业机构披露供应调整",
            facts: "行业机构确认主要生产环节出现供应调整，并说明变化已经影响现货供给预期。",
            source: "https://www.sse.com.cn/disclosure/materials-supply",
            sourceLabel: "上海证券交易所",
            publishedAt: "2026-08-21T05:10:00.000Z",
          }),
        ],
      },
      {
        market: "CN",
        role: "secondary",
        basis: "structural",
        direction: "negative",
        title: "防御行业未能同步跟涨",
        summary: "公用事业相对落后，显示当天上涨力量集中在部分行业，而非普遍的风险偏好扩张。",
        mechanism: "原因未证实：公用事业的成分与行业篮子相对落后，只能确认其对市场广度形成拖累，不能证明外部催化。",
        sectorSymbols: ["932086"],
        evidence: [
          marketEvidence(
            input,
            "CN",
            cnUtilities.source,
            "公用事业行业收盘表现",
            "公用事业行业代表篮子在本次交易日下跌，明显落后于领先行业。",
          ),
        ],
      },
      {
        market: "US",
        role: "primary",
        basis: "macro",
        direction: "positive",
        title: "商业活动信息支撑材料行业",
        summary: "专业媒体报道的商业活动改善与材料行业上涨方向一致，为周期方向提供局部支撑。",
        mechanism: "需求预期改善有利于周期品订单和盈利预期，因而对材料行业形成正向传导。",
        sectorSymbols: ["XLB"],
        evidence: [
          marketEvidence(
            input,
            "US",
            usMaterials.source,
            "材料行业收盘表现",
            "材料行业代表篮子在本次交易日收涨，并处于行业表现前列。",
          ),
          externalEvidence({
            market: "US",
            title: "Business activity improved during the session",
            facts: "A professional publisher reported improving business activity and stronger demand expectations during the completed session.",
            source: "https://www.reuters.com/markets/us/business-activity",
            sourceLabel: "Reuters",
            publishedAt: "2026-08-21T15:10:00.000Z",
            kind: "event",
            sourceType: "publisher",
          }),
        ],
      },
      {
        market: "US",
        role: "secondary",
        basis: "structural",
        direction: "negative",
        title: "科技行业落后形成反向约束",
        summary: "科技行业代表篮子下跌，说明指数内部并非同步改善，周期方向的解释边界较清晰。",
        mechanism: "原因未证实：科技与材料行业篮子方向相反，只能确认行业轮动对指数内部结构的贡献，不能证明外部催化。",
        sectorSymbols: ["XLK"],
        evidence: [
          marketEvidence(
            input,
            "US",
            usTechnology.source,
            "科技行业收盘表现",
            "科技行业代表篮子在本次交易日下跌，与材料行业方向相反。",
          ),
        ],
      },
    ],
    aiChainUpdates: [
      {
        market: "CN",
        layer: "interconnect",
        title: "光互连订单变化提供局部线索",
        summary: "光互连代表篮子相对走弱，公司披露的订单节奏变化与该环节承压方向一致。",
        implication: "订单节奏放缓可能压低短期收入预期，但还不足以解释其他智能产业链环节的分化。",
        evidence: [
          marketEvidence(
            input,
            "CN",
            cnInterconnect.source,
            "光互连代表篮子收盘表现",
            "光互连代表篮子在本次交易日下跌，表现弱于多个其他产业链环节。",
          ),
          externalEvidence({
            market: "CN",
            title: "公司披露光互连订单节奏变化",
            facts: "公司公告显示光互连产品的订单确认节奏放缓，并提示短期交付存在波动。",
            source: "https://www.sse.com.cn/disclosure/interconnect-order",
            sourceLabel: "上海证券交易所公告",
            publishedAt: "2026-08-21T05:44:00.000Z",
          }),
        ],
      },
    ],
    translations: {
      en: {
        headline: "Sector rotation split Chinese and United States markets as materials found event support",
        summary: "Both markets showed clear sector dispersion. Direct evidence supported materials, while the remaining moves were better understood through market structure.",
        marketViews: {
          CN: {
            headline: "Materials advanced while defensive sectors lagged",
            summary: "Supply changes supported materials, while utilities lagged and showed that strength was not market-wide.",
          },
          US: {
            headline: "Materials led while technology lagged",
            summary: "Business activity aligned with materials strength, but weak technology performance showed substantial internal dispersion.",
          },
        },
        aiChainViews: {
          CN: {
            headline: "Optical interconnects lagged as order news offered a partial explanation",
            summary: "The representative basket lagged, while disclosed order changes explained only part of the move.",
            mechanism: "Slower disclosed order timing could weigh on near-term revenue expectations and therefore partially explains pressure in optical interconnects.",
          },
          US: {
            headline: "Intelligent-industry layers rotated in different directions",
            summary: "Representative baskets diverged, so the evidence supports a structural reading rather than one dominant event.",
            mechanism: "Cause unverified: constituent moves and basket weights explain the layer dispersion mechanically, but no direct evidence ties the session to one catalyst.",
          },
        },
        drivers: [
          {
            title: "Supply changes supported materials",
            summary: "Officially disclosed supply changes aligned with materials strength and directly supported the sector move.",
            mechanism: "Tighter supply expectations improved pricing and earnings expectations and attracted capital toward materials.",
          },
          {
            title: "Defensive sectors did not rise with the leaders",
            summary: "Utilities lagged, showing that strength was concentrated rather than a broad expansion in risk appetite.",
            mechanism: "Cause unverified: constituent and sector-basket dispersion confirms a drag on breadth but does not establish an external catalyst.",
          },
          {
            title: "Business activity supported materials",
            summary: "Reported improvement in business activity aligned with materials strength and offered support for cyclicals.",
            mechanism: "Better demand expectations can improve orders and earnings expectations for cyclical businesses.",
          },
          {
            title: "Technology weakness limited the broader explanation",
            summary: "Technology declined, showing that the market did not improve uniformly and defining the limits of the cyclical explanation.",
            mechanism: "Cause unverified: opposing technology and materials baskets mechanically explain index dispersion but do not establish an external catalyst.",
          },
        ],
        aiChainUpdates: [
          {
            title: "Order changes offered a partial clue for optical interconnects",
            summary: "The optical-interconnect basket lagged as disclosed order timing moved in the same direction.",
            implication: "Slower order timing may weigh on near-term revenue expectations but does not explain dispersion across other layers.",
          },
        ],
      },
    },
    researchAudit: {
      CN: {
        queries: [
          "A股 收盘 复盘",
          "A股 原材料 供应 原因",
          "A股 AI 光互连 订单 公告",
          "A股 AI 机器人 原因 业绩",
        ],
        sourcesReviewed: 5,
        outcome: "sufficient",
      },
      US: {
        queries: [
          "US stocks close market wrap",
          "US stocks materials business activity reason",
          "US stocks artificial intelligence chips filing reason",
          "US stocks artificial intelligence cloud earnings catalyst",
        ],
        sourcesReviewed: 4,
        outcome: "sufficient",
      },
    },
  };
}
