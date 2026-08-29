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

const fixtureAnalysis = {
  cnMaterials: "行业机构确认主要生产环节出现供应调整，这一变化先收紧现货供给预期，再改善相关企业的产品价格与盈利预期，并吸引资金重新评估原材料行业。该证据只覆盖已披露的供应变化及其对应行业，不解释公用事业、科技或整个市场的同步表现。",
  cnUtilities: "监管机构披露相关价格调整仍受约束，并要求部分公用事业企业控制终端收费。收费空间受限会压低市场对相关企业收入和利润改善的预期，进而减少资金对公用事业行业的配置。该约束只解释公用事业的相对承压，不能外推为其他行业下跌的共同原因。",
  usMaterials: "专业媒体在已结束的交易时段报道商业活动改善并带动需求预期回升。更强的需求预期会先改善周期品订单和盈利判断，再推动资金提高对材料行业的估值与配置。该证据与材料行业走强方向一致，但科技行业同期下跌，因此不能解释整个美国市场的表现。",
  usTechnology: "专业媒体报道资本开支上升引发市场对科技企业短期利润率的担忧。更高的投入会先压低近期自由现金流和盈利预期，再通过估值折现与仓位调整对科技行业形成压力。该证据只覆盖科技行业的相对落后，不能解释材料行业上涨或整个市场的共同方向。",
  cnInterconnect: "公司公告显示光互连产品的订单确认节奏放缓，并提示短期交付存在波动。订单确认推迟会先压低市场对近期收入兑现和产能利用的预期，再对相关光互连标的估值形成压力。该证据只覆盖光互连环节，不能解释其他智能产业链环节之间的分化。",
};

const fixtureAnalysisEn = {
  cnMaterials: "An industry authority confirmed a supply adjustment in a major production segment. Tighter expected spot supply can improve pricing and earnings expectations before investors revalue materials companies; the evidence is limited to the disclosed supply change and does not explain utilities, technology, or the whole market.",
  cnUtilities: "The regulator disclosed that relevant price adjustments remained constrained and required some utilities to limit end-user charges. Less pricing room can weaken revenue and profit expectations and reduce allocations to utilities; this evidence explains relative pressure in utilities only, not declines across other sectors.",
  usMaterials: "A professional publisher reported improving business activity and stronger demand expectations during the completed session. Better demand can lift cyclical order and earnings expectations before investors raise valuations and allocations to materials; technology fell at the same time, so this evidence does not explain the entire United States market.",
  usTechnology: "A professional publisher reported that rising capital expenditure prompted concern about near-term technology-sector margins. Higher investment can reduce near-term cash flow and earnings expectations before valuation and positioning adjustments weigh on technology; it does not explain the concurrent materials advance or the whole market.",
  cnInterconnect: "A company filing disclosed slower confirmation of optical-interconnect orders and warned of near-term delivery volatility. Delayed confirmations can weaken expectations for near-term revenue realization and utilization before pressuring related valuations; the evidence covers optical interconnects only and does not explain dispersion across other intelligent-industry layers.",
};

const fixtureReaderSummary = {
  cnMaterials: "行业机构确认主要生产环节出现供应调整，现货供给预期随之收紧。供给收缩通常先改善相关产品的议价能力、库存价值和企业盈利预期，再推动资金重新评估原材料公司的估值；当天原材料代表篮子的上涨方向与这条传导链一致。",
  cnUtilities: "监管机构披露相关价格调整仍受约束，并要求部分公用事业企业控制终端收费。收费空间收窄会限制收入弹性和利润改善幅度，市场因此下调近期盈利预期与配置意愿；当天公用事业代表篮子的下跌方向与这一约束继续保持一致。",
  usMaterials: "专业媒体在交易时段报道商业活动改善并带动需求预期回升。更强的需求先改善周期品订单、销量和盈利判断，再推动资金提高对材料公司的估值与配置；当天材料行业代表篮子上涨，和商业活动改善所指向的周期需求变化保持一致。",
  usTechnology: "专业媒体报道资本开支上升引发市场对科技企业短期利润率的担忧。更高投入会先压低近期自由现金流和盈利预期，再通过估值折现与仓位调整对科技股形成压力；当天科技行业代表篮子下跌，与利润率担忧所指向的方向一致。",
  cnInterconnect: "公司公告显示光互连产品的订单确认节奏放缓，并提示短期交付存在波动。订单推迟会降低近期收入兑现、产能利用和现金回收预期，进而压低相关公司的估值；当天光互连代表篮子相对走弱，与订单和交付节奏变化指向的压力一致。",
};

const fixtureReaderSummaryEn = {
  cnMaterials: "An industry authority confirmed a supply adjustment in a major production segment, tightening expectations for spot availability. The shift can improve pricing power, inventory values, and earnings expectations before investors revalue materials companies; the materials basket moved in the same direction during the session.",
  cnUtilities: "The regulator said relevant price adjustments remained constrained and required some utilities to limit end-user charges. Reduced pricing room caps revenue and margin upside, which can weaken near-term earnings expectations and allocations; the utilities basket declined in the direction implied by that constraint.",
  usMaterials: "A professional publisher reported improving business activity and stronger demand expectations during the completed session. Better demand can lift cyclical orders, volumes, and earnings expectations before investors raise valuations and allocations; the materials basket advanced in the direction implied by that improvement.",
  usTechnology: "A professional publisher reported that rising capital expenditure prompted concern about near-term technology-sector margins. Higher investment can reduce free cash flow and earnings expectations before discount rates and positioning weigh on valuations; the technology basket declined in the direction implied by that concern.",
  cnInterconnect: "A company filing disclosed slower confirmation of optical-interconnect orders and warned of near-term delivery volatility. Delayed confirmation can weaken revenue realization, utilization, and cash-collection expectations before pressuring valuations; the optical-interconnect basket lagged in the direction implied by those changes.",
};

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
    summary: "两个市场均呈现明显的行业强弱分化；材料方向和部分落后行业都有同交易窗口的直接信息支持。",
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
        summary: "代表篮子之间方向分化，但当前没有达到发布门槛的直接事件证据。",
        mechanism: null,
        driverStatus: "insufficient",
      },
    },
    drivers: [
      {
        market: "CN",
        role: "primary",
        basis: "event",
        direction: "positive",
        attributionScope: "sector",
        attributionTargets: ["932078"],
        title: "供应变化支撑原材料行业",
        summary: fixtureReaderSummary.cnMaterials,
        metrics: [],
        mechanism: fixtureAnalysis.cnMaterials,
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
        basis: "event",
        direction: "negative",
        attributionScope: "sector",
        attributionTargets: ["932086"],
        title: "价格监管消息压制公用事业",
        summary: fixtureReaderSummary.cnUtilities,
        metrics: [],
        mechanism: fixtureAnalysis.cnUtilities,
        sectorSymbols: ["932086"],
        evidence: [
          marketEvidence(
            input,
            "CN",
            cnUtilities.source,
            "公用事业行业收盘表现",
            "公用事业行业代表篮子在本次交易日下跌，明显落后于领先行业。",
          ),
          externalEvidence({
            market: "CN",
            title: "监管机构说明公用事业价格约束",
            facts: "监管机构披露相关价格调整仍受约束，并要求部分公用事业企业控制终端收费。",
            source: "https://www.sse.com.cn/disclosure/utilities-pricing",
            sourceLabel: "上海证券交易所",
            publishedAt: "2026-08-21T05:24:00.000Z",
          }),
        ],
      },
      {
        market: "US",
        role: "primary",
        basis: "macro",
        direction: "positive",
        attributionScope: "sector",
        attributionTargets: ["XLB"],
        title: "商业活动信息支撑材料行业",
        summary: fixtureReaderSummary.usMaterials,
        metrics: [],
        mechanism: fixtureAnalysis.usMaterials,
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
        basis: "event",
        direction: "negative",
        attributionScope: "sector",
        attributionTargets: ["XLK"],
        title: "资本开支担忧压制科技行业",
        summary: fixtureReaderSummary.usTechnology,
        metrics: [],
        mechanism: fixtureAnalysis.usTechnology,
        sectorSymbols: ["XLK"],
        evidence: [
          marketEvidence(
            input,
            "US",
            usTechnology.source,
            "科技行业收盘表现",
            "科技行业代表篮子在本次交易日下跌，与材料行业方向相反。",
          ),
          externalEvidence({
            market: "US",
            title: "Technology spending raised margin concerns",
            facts: "A professional publisher reported that rising capital expenditure prompted concern about near-term technology-sector margins.",
            source: "https://www.reuters.com/markets/us/technology-capex",
            sourceLabel: "Reuters",
            publishedAt: "2026-08-21T16:20:00.000Z",
            kind: "event",
            sourceType: "publisher",
          }),
        ],
      },
    ],
    aiChainUpdates: [
      {
        market: "CN",
        layer: "interconnect",
        title: "光互连订单变化提供局部线索",
        summary: fixtureReaderSummary.cnInterconnect,
        metrics: [],
        implication: fixtureAnalysis.cnInterconnect,
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
        summary: "Both markets showed clear sector dispersion. Direct evidence supported materials and selected lagging sectors.",
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
            summary: "Representative baskets diverged, but no direct event evidence met the publication threshold.",
            mechanism: null,
          },
        },
        drivers: [
          {
            title: "Supply changes supported materials",
            summary: fixtureReaderSummaryEn.cnMaterials,
            metrics: [],
            mechanism: fixtureAnalysisEn.cnMaterials,
          },
          {
            title: "Pricing constraints weighed on utilities",
            summary: fixtureReaderSummaryEn.cnUtilities,
            metrics: [],
            mechanism: fixtureAnalysisEn.cnUtilities,
          },
          {
            title: "Business activity supported materials",
            summary: fixtureReaderSummaryEn.usMaterials,
            metrics: [],
            mechanism: fixtureAnalysisEn.usMaterials,
          },
          {
            title: "Capital-spending concerns weighed on technology",
            summary: fixtureReaderSummaryEn.usTechnology,
            metrics: [],
            mechanism: fixtureAnalysisEn.usTechnology,
          },
        ],
        aiChainUpdates: [
          {
            title: "Order changes offered a partial clue for optical interconnects",
            summary: fixtureReaderSummaryEn.cnInterconnect,
            metrics: [],
            implication: fixtureAnalysisEn.cnInterconnect,
          },
        ],
      },
    },
    researchAudit: {
      CN: {
        queries: [
          "A股 收盘 复盘",
          "A股 原材料 供应 原因",
          "A股 CPO 光互连 订单 公告",
          "A股 AI 机器人 原因 业绩",
        ],
        sourcesReviewed: 5,
        outcome: "sufficient",
        hypotheses: [
          {
            id: "CN-H1",
            claim: fixtureAnalysis.cnMaterials,
            category: "industry",
            targets: ["932078"],
            supportingSources: [
              "https://www.sse.com.cn/disclosure/materials-supply",
            ],
            causalEvidence: [{
              source: "https://www.sse.com.cn/disclosure/materials-supply",
              supports: fixtureAnalysis.cnMaterials,
              scope: "sector",
              targets: ["932078"],
            }],
            counterEvidence: "已核对公用事业和光互连的反向表现，供应调整只能解释原材料行业。",
            verdict: "accepted",
            verdictReason: "交易窗口内的一手披露与行业方向一致，并有对应行业行情交叉验证。",
            publishedAs: "market_driver",
            publishedTitle: "供应变化支撑原材料行业",
            publishedClaim: fixtureAnalysis.cnMaterials,
          },
          {
            id: "CN-H2",
            claim: fixtureAnalysis.cnUtilities,
            category: "policy",
            targets: ["932086"],
            supportingSources: [
              "https://www.sse.com.cn/disclosure/utilities-pricing",
            ],
            causalEvidence: [{
              source: "https://www.sse.com.cn/disclosure/utilities-pricing",
              supports: fixtureAnalysis.cnUtilities,
              scope: "sector",
              targets: ["932086"],
            }],
            counterEvidence: "该约束无法解释原材料行业上涨，因此仅作为局部次要原因。",
            verdict: "accepted",
            verdictReason: "监管披露与公用事业行业下跌方向一致，传导路径明确。",
            publishedAs: "market_driver",
            publishedTitle: "价格监管消息压制公用事业",
            publishedClaim: fixtureAnalysis.cnUtilities,
          },
          {
            id: "CN-H3",
            claim: fixtureAnalysis.cnInterconnect,
            category: "company",
            targets: ["interconnect"],
            supportingSources: [
              "https://www.sse.com.cn/disclosure/interconnect-order",
            ],
            causalEvidence: [{
              source: "https://www.sse.com.cn/disclosure/interconnect-order",
              supports: fixtureAnalysis.cnInterconnect,
              scope: "ai_layer",
              targets: ["interconnect"],
            }],
            counterEvidence: "订单信息只覆盖光互连，不能解释其他智能产业链环节的分化。",
            verdict: "accepted",
            verdictReason: "公司公告与对应环节方向一致，但解释范围仅限光互连。",
            publishedAs: "ai_update",
            publishedTitle: "光互连订单变化提供局部线索",
            publishedClaim: fixtureAnalysis.cnInterconnect,
          },
          {
            id: "CN-H4",
            claim: "全市场流动性改善推动所有行业同步上涨。",
            category: "positioning",
            targets: ["CN"],
            supportingSources: [],
            causalEvidence: [],
            counterEvidence: "公用事业与光互连仍下跌，且未找到交易窗口内的直接资金流证据。",
            verdict: "rejected",
            verdictReason: "行业方向并不同步，现有证据不能支持全市场流动性解释。",
            publishedAs: "none",
            publishedTitle: "",
            publishedClaim: "",
          },
        ],
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
        hypotheses: [
          {
            id: "US-H1",
            claim: fixtureAnalysis.usMaterials,
            category: "macro",
            targets: ["XLB"],
            supportingSources: [
              "https://www.reuters.com/markets/us/business-activity",
            ],
            causalEvidence: [{
              source: "https://www.reuters.com/markets/us/business-activity",
              supports: fixtureAnalysis.usMaterials,
              scope: "sector",
              targets: ["XLB"],
            }],
            counterEvidence: "科技行业同期下跌，说明商业活动信息不是全市场统一驱动。",
            verdict: "accepted",
            verdictReason: "专业媒体的交易窗口报道与材料行业上涨方向一致。",
            publishedAs: "market_driver",
            publishedTitle: "商业活动信息支撑材料行业",
            publishedClaim: fixtureAnalysis.usMaterials,
          },
          {
            id: "US-H2",
            claim: fixtureAnalysis.usTechnology,
            category: "industry",
            targets: ["XLK"],
            supportingSources: [
              "https://www.reuters.com/markets/us/technology-capex",
            ],
            causalEvidence: [{
              source: "https://www.reuters.com/markets/us/technology-capex",
              supports: fixtureAnalysis.usTechnology,
              scope: "sector",
              targets: ["XLK"],
            }],
            counterEvidence: "材料行业上涨表明资本开支担忧仅解释科技板块而非大盘。",
            verdict: "accepted",
            verdictReason: "专业媒体直接报道利润率担忧，且科技行业行情方向一致。",
            publishedAs: "market_driver",
            publishedTitle: "资本开支担忧压制科技行业",
            publishedClaim: fixtureAnalysis.usTechnology,
          },
          {
            id: "US-H3",
            claim: "人工智能云服务订单推动整个智能产业链上涨。",
            category: "company",
            targets: ["cloud", "US"],
            supportingSources: [],
            causalEvidence: [],
            counterEvidence: "未找到交易窗口内的直接订单披露，且智能产业链环节方向分化。",
            verdict: "unresolved",
            verdictReason: "行情提供检索线索，但缺少可以支撑因果的外部事件证据。",
            publishedAs: "none",
            publishedTitle: "",
            publishedClaim: "",
          },
        ],
      },
    },
  };
}
