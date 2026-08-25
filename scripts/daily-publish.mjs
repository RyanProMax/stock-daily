import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  getNewsBudget,
  NEWS_MAX_PER_MARKET,
} from "./news-pipeline.mjs";
import {
  SECTOR_COUNT_PER_MARKET,
  sectorHeatScore,
} from "./sector-heat.mjs";
import {
  DAILY_UPDATE_KINDS,
  dailyCutoffAt,
  marketAsOfFromInput,
} from "./daily-policy.mjs";
import {
  assignSignalMetadata,
  checkpointDueAt,
  enrichNewsItem,
  supportedEntityKeys,
} from "./signal-intelligence.mjs";
import {
  buildMarketSessions,
  causalEventEvidenceMatches,
  driverDirectionMatches,
  evidenceFitsSession,
  localMarketWrapMatches,
  sectorExtremes,
} from "./market-attribution.mjs";
import { AI_CHAIN_LAYERS } from "./ai-chain.mjs";

const execFileAsync = promisify(execFile);
const AGENT_MODEL = "openai/codex-scheduled";
const categories = new Set(["公司", "宏观", "商品", "行业"]);
const tones = new Set(["positive", "negative", "mixed", "neutral"]);
const signalDirections = new Set(["positive", "negative", "mixed"]);
const signalHorizons = new Set(["intraday", "1-5d", "1-4w"]);
const signalConfidences = new Set(["low", "medium", "high"]);

const tickerAliases = {
  AAPL: /\bapple\b/i,
  AMZN: /\bamazon\b/i,
  BABA: /\baliexpress\b|\balibaba\b|全球速卖通/i,
  CCK: /\bcrown holdings\b/i,
  EDU: /\bnew oriental(?: education)?\b|新东方/i,
  GOOG: /\bgoogle\b|\balphabet\b/i,
  GOOGL: /\bgoogle\b|\balphabet\b/i,
  GFS: /\bglobalfoundries\b|格罗方德/i,
  META: /\bmeta\b|\bfacebook\b/i,
  MSFT: /\bmicrosoft\b/i,
  NVDA: /\bnvidia\b/i,
  PG: /\bprocter\s*&\s*gamble\b|\bp&g\b|宝洁/i,
  TSLA: /\btesla\b/i,
  VRSN: /\bverisign\b/i,
};

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

function requireText(value, label, maxLength, minLength = 2) {
  if (typeof value !== "string") throw new Error(`${label} 缺失`);
  const text = value
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < minLength) throw new Error(`${label} 少于 ${minLength} 字`);
  if (text.length > maxLength) throw new Error(`${label} 超过 ${maxLength} 字`);
  return text;
}

function completeSentence(
  value,
  label,
  maxLength,
  minLength,
  terminator = "。",
) {
  const text = requireText(value, label, maxLength, minLength);
  if (/[。！？.!?]$/.test(text)) return text;
  if (text.length >= maxLength) {
    throw new Error(`${label} 未在长度限制内写完`);
  }
  return `${text}${terminator}`;
}

function stringArray(value, label, maxItems, maxLength, minItems = 0) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  const items = value
    .filter((item) => typeof item === "string")
    .map((item) =>
      item
        .normalize("NFC")
        .replace(/\p{Cf}/gu, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  if (items.length < minItems || items.length > maxItems) {
    throw new Error(`${label} 数量必须为 ${minItems}–${maxItems}`);
  }
  if (items.some((item) => item.length > maxLength)) {
    throw new Error(`${label} 单项超过 ${maxLength} 字`);
  }
  return [...new Set(items)];
}

function topicKey(title) {
  const normalized = title.toLocaleLowerCase();
  if (
    /\btreasury\b|\byield\b|\binterest rate\b|\bfederal reserve\b|\bfed\b|\becb\b|\binflation\b|\bmortgage\b|国债|收益率|利率|美联储|通胀/.test(
      normalized,
    )
  ) {
    return "rates";
  }
  if (/\bopec\b|\boil\b|\bcrude\b|欧佩克|原油|油价/.test(normalized)) {
    return "energy";
  }
  if (/\bgold\b|\bsilver\b|\bcopper\b|黄金|白银|铜价/.test(normalized)) {
    return "metals";
  }
  if (
    /\btariff\b|\btrade deal\b|\bsanction\b|关税|贸易|出口|进口/.test(normalized)
  ) {
    return "trade";
  }
  if (
    /\bstock market\b|\bnasdaq\b|\bs&p\b|\bdow\b|\bbig tech\b|美股|纳斯达克|标普|道琼斯|科技股|三大指数/.test(
      normalized,
    )
  ) {
    return "equities";
  }
  if (
    /\bearnings\b|\bguidance\b|\brevenue\b|\bprofit\b|财报|业绩|营收|利润/.test(
      normalized,
    )
  ) {
    return "earnings";
  }
  return `other:${normalized.replace(/\W/g, "").slice(0, 32)}`;
}

function topicTags(title) {
  const normalized = title.toLocaleLowerCase();
  const topics = new Set();
  if (
    /\btreasury\b|\byield\b|\binterest rate\b|\bfederal reserve\b|\bfed\b|\becb\b|\binflation\b|\bmortgage\b|国债|收益率|利率|美联储|通胀/.test(
      normalized,
    )
  ) {
    topics.add("rates");
  }
  if (/\bopec\b|\boil\b|\bcrude\b|欧佩克|原油|油价/.test(normalized)) {
    topics.add("energy");
  }
  if (/\bgold\b|\bsilver\b|\bcopper\b|黄金|白银|铜价/.test(normalized)) {
    topics.add("metals");
  }
  if (
    /\btariff\b|\btrade deal\b|\bsanction\b|关税|贸易|出口|进口/.test(normalized)
  ) {
    topics.add("trade");
  }
  if (
    /\bstock market\b|\bnasdaq\b|\bs&p\b|\bdow\b|\bbig tech\b|美股|纳斯达克|标普|道琼斯|科技股|三大指数/.test(
      normalized,
    )
  ) {
    topics.add("equities");
  }
  if (
    /\bearnings\b|\bguidance\b|\brevenue\b|\bprofit\b|财报|业绩|营收|利润/.test(
      normalized,
    )
  ) {
    topics.add("earnings");
  }
  return topics;
}

function tickerIsSupported(ticker, sourceTitle) {
  const alias = tickerAliases[ticker];
  if (alias) return alias.test(sourceTitle);
  return new RegExp(`\\b${ticker.replace(/[.-]/g, "\\$&")}\\b`).test(sourceTitle);
}

function assertNumbersBounded(sourceFacts, generatedText) {
  const source = sourceFacts.toLocaleLowerCase().replaceAll(",", "");
  const generatedNumbers =
    generatedText.toLocaleLowerCase().replaceAll(",", "").match(/\d+(?:\.\d+)?/g) ??
    [];
  for (const number of new Set(generatedNumbers)) {
    if (!new RegExp(`(^|\\D)${number.replace(".", "\\.")}(\\D|$)`).test(source)) {
      throw new Error(`解读引用了已核验事实未提供的数字 ${number}`);
    }
  }
}

function assertStoryFactsBounded(sourceFacts, generatedText) {
  const source = sourceFacts.toLocaleLowerCase();
  assertNumbersBounded(sourceFacts, generatedText);
  if (
    !topicTags(sourceFacts).has("rates") &&
    /美债|国债收益率|基点|无风险利率.{0,8}(升至|降至|回落至)/.test(generatedText)
  ) {
    throw new Error("解读混入了该来源未提供的利率行情");
  }
  if (
    /\bunprepared\b.*6%|\bcould\b|\bif\b/.test(source) &&
    /升至\s*6%|达到\s*6%/.test(generatedText) &&
    !/若|如果|一旦|假设|情景/.test(generatedText)
  ) {
    throw new Error("新闻中的情景数字被写成已发生事实");
  }
  if (
    /\bboj\b|\bbank of japan\b/.test(source) &&
    !/\byen\b/.test(source) &&
    /日元.{0,8}(承压|升值|贬值|走强|走弱)/.test(generatedText)
  ) {
    throw new Error("来源未提供日元方向，不得自行推断");
  }
}

function assertToneIsAnalyzed(tone, interpretation, generatedText, label) {
  if (
    /待确认|方向未明|方向不(?:明|确定)|无法(?:判断|确认|判定)|难以判断|暂(?:时)?不能判断|信息不足|标题未(?:披露|说明|给出)|现有信息不足|取决于后续|若后续/.test(
      generatedText,
    )
  ) {
    throw new Error(`${label} 以信息不足代替事实核验和影响分析`);
  }
  const toneSignals = {
    positive: /利好|支撑|改善|提振|增强|上修|受益/,
    negative: /利空|压制|压低|恶化|下修|承压|削弱|挤压|拖累/,
    mixed: /分化|利好.{0,50}利空|受益.{0,50}承压|支撑.{0,50}压制|一方面.{0,80}(另一方面|但|同时)/,
    neutral: /中性|整体稳定|例行(?:发行|公布|更新)|正负因素.{0,20}(抵消|平衡)|不改变.{0,20}(预期|方向|定价)/,
  };
  if (!toneSignals[tone].test(interpretation)) {
    throw new Error(`${label} 未明确说明 ${tone} 判断及其传导依据`);
  }
}

function assertMarketDirections(text, markets) {
  const clauses = text
    .split(/[。！？；;，,\n]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const checks = [
    {
      market: markets.find((item) => item.symbol === "IXIC"),
      up: /纳斯达克.{0,10}(上涨|走高|反弹|收涨)/,
      down: /纳斯达克.{0,10}(下跌|走低|暴跌|收跌)/,
    },
    {
      market: markets.find((item) => item.symbol === "SPX"),
      up: /(标普|S&P ?500).{0,10}(上涨|走高|反弹|收涨)/i,
      down: /(标普|S&P ?500).{0,10}(下跌|走低|暴跌|收跌)/i,
    },
    {
      market: markets.find((item) => item.symbol === "DJI"),
      up: /(道琼斯|道指|DOW).{0,10}(上涨|走高|反弹|收涨)/i,
      down: /(道琼斯|道指|DOW).{0,10}(下跌|走低|暴跌|收跌)/i,
    },
    {
      market: markets.find((item) => item.symbol === "DGS10"),
      up: /(美债|国债|10年期).{0,12}(收益率|利率).{0,8}(上涨|上升|走高|攀升)/,
      down:
        /(美债|国债|10年期).{0,12}(收益率|利率).{0,8}(下降|下跌|回落|走低)/,
    },
    {
      market: markets.find((item) => item.symbol === "SSE"),
      up: /(上证|A股).{0,10}(上涨|走高|反弹|收涨)/,
      down: /(上证|A股).{0,10}(下跌|走低|回落|收跌)/,
    },
    {
      market: markets.find((item) => item.symbol === "CSI300"),
      up: /(沪深|A股).{0,10}(上涨|走高|反弹|收涨)/,
      down: /(沪深|A股).{0,10}(下跌|走低|回落|收跌)/,
    },
  ];

  for (const { market, up, down } of checks) {
    if (!market) continue;
    if (
      market.direction === "up" &&
      clauses.some((clause) => down.test(clause))
    ) {
      throw new Error(`${market.name} 方向与行情数据矛盾`);
    }
    if (
      market.direction === "down" &&
      clauses.some((clause) => up.test(clause))
    ) {
      throw new Error(`${market.name} 方向与行情数据矛盾`);
    }
  }
}

function requiredTickerGroups(sourceTitle) {
  return [
    { pattern: /\bapple\b/i, accepted: ["AAPL"] },
    { pattern: /\bamazon\b/i, accepted: ["AMZN"] },
    { pattern: /\bgoogle\b|\balphabet\b/i, accepted: ["GOOG", "GOOGL"] },
    { pattern: /\bmeta\b|\bfacebook\b/i, accepted: ["META"] },
    { pattern: /\bmicrosoft\b/i, accepted: ["MSFT"] },
    { pattern: /\bnvidia\b/i, accepted: ["NVDA"] },
    { pattern: /\btesla\b/i, accepted: ["TSLA"] },
    { pattern: /\baliexpress\b|\balibaba\b|全球速卖通/i, accepted: ["BABA"] },
    { pattern: /\bcrown holdings\b/i, accepted: ["CCK"] },
    { pattern: /\bverisign\b/i, accepted: ["VRSN"] },
  ].filter((group) => group.pattern.test(sourceTitle));
}

function validateLegacyInput(value) {
  const input = requireObject(value, "daily-input");
  const supportedContract =
    (input.schemaVersion === 7 &&
      input.contractVersion === "codex-daily-v7") ||
    (input.schemaVersion === 8 &&
      input.contractVersion === "codex-daily-v8");
  if (
    !supportedContract ||
    typeof input.runId !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.reportDate) ||
    !DAILY_UPDATE_KINDS.includes(input.updateKind) ||
    input.cutoffAt !== dailyCutoffAt(input.reportDate, input.updateKind) ||
    !Array.isArray(input.markets) ||
    input.markets.length !== 10 ||
    !Array.isArray(input.sectorHeat) ||
    input.sectorHeat.length !== SECTOR_COUNT_PER_MARKET * 2 ||
    !Array.isArray(input.news) ||
    input.news.length === 0 ||
    input.news.length > NEWS_MAX_PER_MARKET * 2
  ) {
    throw new Error("daily-input 结构或数量不符合 codex-daily-v7/v8");
  }
  const sectorCounts = new Map([
    ["CN", 0],
    ["US", 0],
  ]);
  const sectorKeys = new Set();
  for (const sectorValue of input.sectorHeat) {
    const sector = requireObject(sectorValue, "sectorHeat");
    const changeMatch =
      typeof sector.change === "string"
        ? sector.change.match(/^([+-]?\d+(?:\.\d+)?)%$/)
        : null;
    const changeValue = changeMatch ? Number(changeMatch[1]) : Number.NaN;
    const expectedDirection =
      Math.abs(changeValue) < 0.005
        ? "flat"
        : changeValue > 0
          ? "up"
          : "down";
    const key = `${sector.market}:${sector.symbol}`;
    if (
      !sectorCounts.has(sector.market) ||
      typeof sector.symbol !== "string" ||
      !/^[A-Z0-9]{2,10}$/.test(sector.symbol) ||
      typeof sector.name !== "string" ||
      typeof sector.nameEn !== "string" ||
      !Number.isFinite(changeValue) ||
      sector.direction !== expectedDirection ||
      sector.score !== sectorHeatScore(sector.market, changeValue) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(sector.asOf) ||
      typeof sector.source !== "string" ||
      !sector.source.startsWith("https://") ||
      sectorKeys.has(key)
    ) {
      throw new Error("板块行情字段无效");
    }
    sectorKeys.add(key);
    sectorCounts.set(sector.market, sectorCounts.get(sector.market) + 1);
  }
  if (
    sectorCounts.get("CN") !== SECTOR_COUNT_PER_MARKET ||
    sectorCounts.get("US") !== SECTOR_COUNT_PER_MARKET
  ) {
    throw new Error(
      `板块行情必须分别包含 ${SECTOR_COUNT_PER_MARKET} 个 CN 与 ${SECTOR_COUNT_PER_MARKET} 个 US 行业`,
    );
  }
  const marketCounts = new Map([
    ["CN", 0],
    ["US", 0],
  ]);
  for (const marketValue of input.markets) {
    const market = requireObject(marketValue, "market");
    if (
      !marketCounts.has(market.region) ||
      !["up", "down", "flat"].includes(market.direction) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(market.asOf) ||
      typeof market.source !== "string" ||
      !market.source.startsWith("https://")
    ) {
      throw new Error("行情字段无效");
    }
    marketCounts.set(market.region, marketCounts.get(market.region) + 1);
  }
  if (marketCounts.get("CN") !== 6 || marketCounts.get("US") !== 4) {
    throw new Error("行情必须包含 6 个 CN 与 4 个 US 指标");
  }
  const marketDataDiagnostics = requireObject(
    input.marketDataDiagnostics,
    "marketDataDiagnostics",
  );
  const providerSymbols = Array.isArray(marketDataDiagnostics.providers)
    ? marketDataDiagnostics.providers.map((item) => item?.symbol)
    : [];
  if (
    marketDataDiagnostics.schemaVersion !== "market-data-query.v1" ||
    marketDataDiagnostics.status !== "ok" ||
    marketDataDiagnostics.source !== "market_data_query" ||
    marketDataDiagnostics.persistence !== "none" ||
    Date.parse(marketDataDiagnostics.cutoffAt) !== Date.parse(input.cutoffAt) ||
    marketDataDiagnostics.marketCount !== 10 ||
    !Number.isFinite(Date.parse(marketDataDiagnostics.computedAt)) ||
    providerSymbols.length !== 10 ||
    new Set(providerSymbols).size !== 10 ||
    ![
      "SPX",
      "IXIC",
      "DJI",
      "DGS10",
      "SSE",
      "SZSE",
      "CSI300",
      "CSI500",
      "CHINEXT",
      "STAR50",
    ].every((symbol) => providerSymbols.includes(symbol))
  ) {
    throw new Error("行情必须来自完整、无持久化的 API daily-pack");
  }
  const newsCounts = new Map([
    ["CN", 0],
    ["US", 0],
  ]);
  const cutoffTime = Date.parse(input.cutoffAt);
  for (const newsValue of input.news) {
    const news = requireObject(newsValue, "news");
    const publishedAt = Date.parse(news.publishedAt);
    if (
      typeof news.title !== "string" ||
      news.title.length < 8 ||
      typeof news.facts !== "string" ||
      news.facts.length < 30 ||
      news.facts.length > 900 ||
      typeof news.url !== "string" ||
      !news.url.startsWith("https://") ||
      typeof news.publishedAt !== "string" ||
      !Number.isFinite(publishedAt) ||
      publishedAt > cutoffTime ||
      !Array.isArray(news.regions) ||
      news.regions.length === 0 ||
      news.regions.some((region) => !newsCounts.has(region))
    ) {
      throw new Error("新闻事实字段无效");
    }
    for (const region of new Set(news.regions)) {
      newsCounts.set(region, newsCounts.get(region) + 1);
    }
  }
  const newsBudget = getNewsBudget(input.reportDate);
  if (
    newsCounts.get("CN") < newsBudget.minimumPerMarket ||
    newsCounts.get("US") < newsBudget.minimumPerMarket ||
    newsCounts.get("CN") > newsBudget.maximumPerMarket ||
    newsCounts.get("US") > newsBudget.maximumPerMarket
  ) {
    throw new Error(
      `候选新闻每个市场必须包含 ${newsBudget.minimumPerMarket}–${newsBudget.maximumPerMarket} 条事实`,
    );
  }
  const diagnostics = requireObject(
    input.newsDiagnostics,
    "newsDiagnostics",
  );
  if (
    !["live", "hybrid", "audited"].includes(diagnostics.mode) ||
    !Number.isInteger(diagnostics.candidateCount) ||
    !Number.isInteger(diagnostics.hydratedCount) ||
    !Number.isInteger(diagnostics.rejectedDuringHydration) ||
    diagnostics.minimumPerMarket !== newsBudget.minimumPerMarket ||
    diagnostics.targetPerMarket !== newsBudget.targetPerMarket ||
    diagnostics.selectedByMarket?.CN !== newsCounts.get("CN") ||
    diagnostics.selectedByMarket?.US !== newsCounts.get("US") ||
    !Array.isArray(diagnostics.sources)
  ) {
    throw new Error("newsDiagnostics 与候选新闻或当日预算不一致");
  }
  return input;
}

function validateSectorRows(rows, expectedPerMarket, label) {
  if (!Array.isArray(rows) || rows.length !== expectedPerMarket * 2) {
    throw new Error(`${label} 必须分别包含 ${expectedPerMarket} 个 CN 与 US 行业`);
  }
  const counts = new Map([["CN", 0], ["US", 0]]);
  const keys = new Set();
  for (const value of rows) {
    const sector = requireObject(value, label);
    const match = typeof sector.change === "string"
      ? sector.change.match(/^([+-]?\d+(?:\.\d+)?)%$/)
      : null;
    const change = match ? Number(match[1]) : Number.NaN;
    const direction = Math.abs(change) < 0.005 ? "flat" : change > 0 ? "up" : "down";
    const key = `${sector.market}:${sector.symbol}`;
    if (
      !counts.has(sector.market) ||
      typeof sector.symbol !== "string" ||
      !/^[A-Z0-9]{2,10}$/.test(sector.symbol) ||
      typeof sector.name !== "string" ||
      typeof sector.nameEn !== "string" ||
      !Number.isFinite(change) ||
      sector.direction !== direction ||
      sector.score !== sectorHeatScore(sector.market, change) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(sector.asOf) ||
      typeof sector.source !== "string" ||
      !sector.source.startsWith("https://") ||
      !Array.isArray(sector.constituents) ||
      sector.constituents.length !== 4 ||
      keys.has(key)
    ) {
      throw new Error(`${label} 字段无效`);
    }
    keys.add(key);
    const constituentSymbols = new Set();
    for (const constituent of sector.constituents) {
      const constituentChange = typeof constituent?.change === "string"
        ? constituent.change.match(/^([+-]?\d+(?:\.\d+)?)%$/)
        : null;
      const constituentValue = constituentChange
        ? Number(constituentChange[1])
        : Number.NaN;
      const close = Number(String(constituent?.value ?? "").replaceAll(",", ""));
      const constituentDirection = Math.abs(constituentValue) < 0.005
        ? "flat"
        : constituentValue > 0
          ? "up"
          : "down";
      if (
        typeof constituent?.symbol !== "string" ||
        constituentSymbols.has(constituent.symbol) ||
        typeof constituent.name !== "string" || constituent.name.length < 2 ||
        typeof constituent.nameEn !== "string" || constituent.nameEn.length < 2 ||
        !Number.isFinite(close) || close <= 0 ||
        !Number.isFinite(constituentValue) ||
        constituent.direction !== constituentDirection ||
        constituent.asOf !== sector.asOf ||
        typeof constituent.source !== "string" ||
        !constituent.source.startsWith("https://")
      ) {
        throw new Error(`${label}.${sector.market}.${sector.symbol}.constituents 字段无效`);
      }
      constituentSymbols.add(constituent.symbol);
    }
    counts.set(sector.market, counts.get(sector.market) + 1);
  }
  if (counts.get("CN") !== expectedPerMarket || counts.get("US") !== expectedPerMarket) {
    throw new Error(`${label} 市场数量无效`);
  }
}

function validateAiChainRows(rows) {
  if (!Array.isArray(rows) || rows.length !== AI_CHAIN_LAYERS.length * 2) {
    throw new Error("aiChainPerformance 必须分别包含 8 个 CN 与 US 环节");
  }
  for (const market of ["CN", "US"]) {
    const marketRows = rows.filter((row) => row?.market === market);
    if (
      marketRows.length !== AI_CHAIN_LAYERS.length ||
      new Set(marketRows.map((row) => row.layer)).size !== AI_CHAIN_LAYERS.length
    ) {
      throw new Error(`${market} aiChainPerformance 环节不完整`);
    }
    for (const layer of AI_CHAIN_LAYERS) {
      const metric = requireObject(
        marketRows.find((row) => row.layer === layer),
        `aiChainPerformance.${market}.${layer}`,
      );
      const match = typeof metric.change === "string"
        ? metric.change.match(/^([+-]?\d+(?:\.\d+)?)%$/)
        : null;
      const change = match ? Number(match[1]) : Number.NaN;
      const direction = Math.abs(change) < 0.005
        ? "flat"
        : change > 0
          ? "up"
          : "down";
      if (
        typeof metric.name !== "string" || metric.name.length < 2 ||
        typeof metric.nameEn !== "string" || metric.nameEn.length < 4 ||
        typeof metric.benchmark !== "string" || metric.benchmark.length < 3 ||
        typeof metric.benchmarkEn !== "string" || metric.benchmarkEn.length < 4 ||
        metric.benchmarkKind !== "equal_weight_basket" ||
        typeof metric.symbol !== "string" || !/^AI-(?:CN|US)-[a-z_]+$/.test(metric.symbol) ||
        !Number.isFinite(change) || metric.direction !== direction ||
        !/^\d{4}-\d{2}-\d{2}$/.test(metric.asOf) ||
        typeof metric.source !== "string" || !metric.source.startsWith("https://") ||
        !Array.isArray(metric.constituents) || metric.constituents.length !== 4
      ) {
        throw new Error(`aiChainPerformance.${market}.${layer} 字段无效`);
      }
      const constituentSymbols = new Set();
      for (const constituent of metric.constituents) {
        const constituentChange = typeof constituent?.change === "string"
          ? constituent.change.match(/^([+-]?\d+(?:\.\d+)?)%$/)
          : null;
        const constituentValue = constituentChange
          ? Number(constituentChange[1])
          : Number.NaN;
        const constituentDirection = Math.abs(constituentValue) < 0.005
          ? "flat"
          : constituentValue > 0
            ? "up"
            : "down";
        const close = Number(String(constituent?.value ?? "").replaceAll(",", ""));
        if (
          typeof constituent?.symbol !== "string" ||
          constituentSymbols.has(constituent.symbol) ||
          typeof constituent.name !== "string" || constituent.name.length < 2 ||
          typeof constituent.nameEn !== "string" || constituent.nameEn.length < 2 ||
          !Number.isFinite(close) || close <= 0 ||
          !Number.isFinite(constituentValue) ||
          constituent.direction !== constituentDirection ||
          constituent.asOf !== metric.asOf ||
          typeof constituent.source !== "string" ||
          !constituent.source.startsWith("https://")
        ) {
          throw new Error(`aiChainPerformance.${market}.${layer}.constituents 字段无效`);
        }
        constituentSymbols.add(constituent.symbol);
      }
    }
  }
}

function validateV9Input(value) {
  const input = requireObject(value, "daily-input");
  if (
    input.schemaVersion !== 9 ||
    input.contractVersion !== "market-attribution-v9" ||
    typeof input.runId !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.reportDate) ||
    !DAILY_UPDATE_KINDS.includes(input.updateKind) ||
    input.cutoffAt !== dailyCutoffAt(input.reportDate, input.updateKind) ||
    !Array.isArray(input.markets) ||
    input.markets.length !== 10 ||
    !Array.isArray(input.news) ||
    input.news.length > NEWS_MAX_PER_MARKET * 2
  ) {
    throw new Error("daily-input 结构或数量不符合 market-attribution-v9");
  }
  validateSectorRows(input.sectorPerformance, 11, "sectorPerformance");
  validateSectorRows(input.sectorHeat, SECTOR_COUNT_PER_MARKET, "sectorHeat");
  validateAiChainRows(input.aiChainPerformance);

  const marketCounts = new Map([["CN", 0], ["US", 0]]);
  for (const value of input.markets) {
    const market = requireObject(value, "market");
    if (
      !marketCounts.has(market.region) ||
      !["up", "down", "flat"].includes(market.direction) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(market.asOf) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(market.previousAsOf) ||
      market.previousAsOf >= market.asOf ||
      typeof market.source !== "string" ||
      !market.source.startsWith("https://")
    ) {
      throw new Error("行情字段无效");
    }
    marketCounts.set(market.region, marketCounts.get(market.region) + 1);
  }
  if (marketCounts.get("CN") !== 6 || marketCounts.get("US") !== 4) {
    throw new Error("行情必须包含 6 个 CN 与 4 个 US 指标");
  }

  const marketDataDiagnostics = requireObject(
    input.marketDataDiagnostics,
    "marketDataDiagnostics",
  );
  const providers = Array.isArray(marketDataDiagnostics.providers)
    ? marketDataDiagnostics.providers
    : [];
  const providerSymbols = providers.map((item) => item?.symbol);
  const marketsBySymbol = new Map(input.markets.map((item) => [item.symbol, item]));
  if (
    marketDataDiagnostics.schemaVersion !== "market-data-query.v1" ||
    marketDataDiagnostics.status !== "ok" ||
    marketDataDiagnostics.source !== "market_data_query" ||
    marketDataDiagnostics.persistence !== "none" ||
    Date.parse(marketDataDiagnostics.cutoffAt) !== Date.parse(input.cutoffAt) ||
    marketDataDiagnostics.marketCount !== 10 ||
    !Number.isFinite(Date.parse(marketDataDiagnostics.computedAt)) ||
    providers.length !== 10 ||
    new Set(providerSymbols).size !== 10 ||
    providers.some((provider) => {
      const market = marketsBySymbol.get(provider?.symbol);
      return !market ||
        provider.asOf !== market.asOf ||
        provider.previousAsOf !== market.previousAsOf;
    })
  ) {
    throw new Error("行情必须来自包含前一交易日的完整 API daily-pack");
  }

  const expectedSessions = buildMarketSessions(input.markets);
  if (!Array.isArray(input.marketSessions) || input.marketSessions.length !== 2) {
    throw new Error("marketSessions 必须包含 CN 与 US");
  }
  for (const expected of expectedSessions) {
    const actual = input.marketSessions.find((item) => item.market === expected.market);
    if (!actual || ["asOf", "previousAsOf", "windowStart", "windowEnd", "wrapDeadline"]
      .some((key) => actual[key] !== expected[key])) {
      throw new Error(`${expected.market} marketSessions 与行情交易日不一致`);
    }
    const dates = new Set(input.sectorPerformance
      .filter((item) => item.market === expected.market)
      .map((item) => item.asOf));
    if (dates.size !== 1 || !dates.has(expected.asOf)) {
      throw new Error(`${expected.market} sectorPerformance 与交易日不一致`);
    }
    const aiDates = new Set(input.aiChainPerformance
      .filter((item) => item.market === expected.market)
      .map((item) => item.asOf));
    if (aiDates.size !== 1 || !aiDates.has(expected.asOf)) {
      throw new Error(`${expected.market} aiChainPerformance 与交易日不一致`);
    }
  }

  const cutoffTime = Date.parse(input.cutoffAt);
  const newsCounts = { CN: 0, US: 0 };
  for (const value of input.news) {
    const news = requireObject(value, "news");
    const publishedAt = Date.parse(news.publishedAt);
    if (
      typeof news.title !== "string" || news.title.length < 8 ||
      typeof news.facts !== "string" || news.facts.length < 30 || news.facts.length > 1200 ||
      typeof news.url !== "string" || !news.url.startsWith("https://") ||
      !Number.isFinite(publishedAt) || publishedAt > cutoffTime ||
      !["event", "market_wrap"].includes(news.kind) ||
      !Array.isArray(news.regions) || news.regions.length === 0 ||
      news.regions.some((region) => !Object.hasOwn(newsCounts, region)) ||
      (news.platform !== undefined && !["web", "x"].includes(news.platform)) ||
      (news.authority !== undefined &&
        !["first_party", "specialist", "expert"].includes(news.authority)) ||
      (news.platform === "x" &&
        (!/^https:\/\/x\.com\/[^/]+\/status\/\d+/.test(news.url) ||
          typeof news.authorHandle !== "string" ||
          !news.authorHandle.trim()))
    ) {
      throw new Error("新闻事实字段无效");
    }
    for (const region of new Set(news.regions)) newsCounts[region] += 1;
  }
  if (newsCounts.CN > NEWS_MAX_PER_MARKET || newsCounts.US > NEWS_MAX_PER_MARKET) {
    throw new Error(`候选新闻每个市场最多 ${NEWS_MAX_PER_MARKET} 条`);
  }

  const diagnostics = requireObject(input.newsDiagnostics, "newsDiagnostics");
  if (
    !["live", "hybrid", "audited"].includes(diagnostics.mode) ||
    diagnostics.selectedByMarket?.CN !== newsCounts.CN ||
    diagnostics.selectedByMarket?.US !== newsCounts.US ||
    !Array.isArray(diagnostics.sources)
  ) {
    throw new Error("newsDiagnostics 与候选新闻不一致");
  }
  const activeRetrieval = requireObject(
    diagnostics.activeRetrieval,
    "newsDiagnostics.activeRetrieval",
  );
  const coverageByMarket = requireObject(
    activeRetrieval.coverageByMarket,
    "newsDiagnostics.activeRetrieval.coverageByMarket",
  );
  if (
    typeof activeRetrieval.attempted !== "boolean" ||
    !Number.isInteger(activeRetrieval.queryCount) ||
    activeRetrieval.queryCount < 0 ||
    activeRetrieval.queryCount > 6 ||
    !Number.isInteger(activeRetrieval.candidateCount) ||
    activeRetrieval.candidateCount < 0 ||
    !Number.isInteger(activeRetrieval.hydratedCount) ||
    activeRetrieval.hydratedCount < 0 ||
    !Number.isInteger(activeRetrieval.rejectedDuringHydration) ||
    activeRetrieval.rejectedDuringHydration < 0 ||
    !Array.isArray(activeRetrieval.searches) ||
    activeRetrieval.searches.length > 2 ||
    activeRetrieval.attempted !== (activeRetrieval.queryCount > 0) ||
    ["CN", "US"].some((market) => {
      const coverage = coverageByMarket[market];
      return (
        !coverage ||
        !["adequate", "insufficient"].includes(coverage.status) ||
        typeof coverage.activeSearchRequired !== "boolean" ||
        typeof coverage.activeSearchCompleted !== "boolean" ||
        !Array.isArray(coverage.missingIntentKinds) ||
        coverage.missingIntentKinds.some(
          (kind) =>
            !["market_wrap", "sector_extremes", "ai_extremes"].includes(kind),
        )
      );
    }) ||
    activeRetrieval.searches.some(
      (search) =>
        !["CN", "US"].includes(search?.market) ||
        !["ok", "error"].includes(search?.status) ||
        !Array.isArray(search?.intentIds) ||
        !Array.isArray(search?.intentResults) ||
        search.intentResults.length !== search.intentIds.length ||
        search.intentResults.some(
          (intent) =>
            !search.intentIds.includes(intent?.id) ||
            !["market_wrap", "sector_extremes", "ai_extremes"].includes(
              intent?.kind,
            ) ||
            !Number.isInteger(intent?.resultCount) ||
            intent.resultCount < 0,
        ) ||
        !Number.isInteger(search?.resultCount) ||
        search.resultCount < 0 ||
        !Number.isInteger(search?.durationMs) ||
        search.durationMs < 0 ||
        (search.attempts !== undefined &&
          (!Array.isArray(search.attempts) ||
            search.attempts.length < 1 ||
            search.attempts.length > 2 ||
            search.attempts.some(
              (attempt) =>
                typeof attempt?.provider !== "string" ||
                !attempt.provider.trim() ||
                !["ok", "error"].includes(attempt?.status) ||
                !Number.isInteger(attempt?.resultCount) ||
                attempt.resultCount < 0 ||
                !Number.isInteger(attempt?.durationMs) ||
                attempt.durationMs < 0,
            ) ||
            (search.status === "ok" &&
              !search.attempts.some((attempt) => attempt.status === "ok")) ||
            (search.status === "error" &&
              search.attempts.some((attempt) => attempt.status === "ok")))),
    )
  ) {
    throw new Error("主动检索诊断字段无效");
  }
  return input;
}

export function validateInput(value) {
  return value?.contractVersion === "market-attribution-v9"
    ? validateV9Input(value)
    : validateLegacyInput(value);
}

function validateOverview(value, label) {
  const overviewValue = requireObject(value, label);
  if (!["positive", "negative", "mixed"].includes(overviewValue.tone)) {
    throw new Error(`${label}.tone 必须明确为 positive、negative 或 mixed`);
  }
  const overview = {
    tone: overviewValue.tone,
    interpretation: completeSentence(
      overviewValue.interpretation,
      `${label}.interpretation`,
      180,
      42,
    ),
    positive: stringArray(
      overviewValue.positive,
      `${label}.positive`,
      4,
      18,
      0,
    ),
    negative: stringArray(
      overviewValue.negative,
      `${label}.negative`,
      4,
      18,
      0,
    ),
  };
  if (overview.positive.length + overview.negative.length < 2) {
    throw new Error(`${label} 至少列出两个受影响市场或板块`);
  }
  if (overview.tone === "positive" && overview.positive.length === 0) {
    throw new Error(`${label} 为利好时必须列出主要受益对象`);
  }
  if (overview.tone === "negative" && overview.negative.length === 0) {
    throw new Error(`${label} 为利空时必须列出主要承压对象`);
  }
  if (
    overview.tone === "mixed" &&
    (overview.positive.length === 0 || overview.negative.length === 0)
  ) {
    throw new Error(`${label} 为分化时必须同时列出利好与利空对象`);
  }
  if (
    !/利好|利空|支撑|压制|估值|风险偏好|无风险利率|融资成本|现金流|需求|成本/.test(
      overview.interpretation,
    )
  ) {
    throw new Error(`${label}.interpretation 缺少利好/利空与传导机制`);
  }
  return overview;
}

function validateMarketView(value, market, markets) {
  const viewValue = requireObject(value, `marketViews.${market}`);
  const headline = requireText(
    viewValue.headline,
    `marketViews.${market}.headline`,
    22,
    8,
  );
  if (headline.includes("盘前简报") || /\d/.test(headline)) {
    throw new Error(`marketViews.${market}.headline 过于泛化或含数字`);
  }
  const summary = completeSentence(
    viewValue.summary,
    `marketViews.${market}.summary`,
    88,
    20,
  );
  const overview = validateOverview(
    viewValue.overview,
    `marketViews.${market}.overview`,
  );
  const headerText = [
    headline,
    summary,
    overview.interpretation,
    ...overview.positive,
    ...overview.negative,
  ].join("\n");
  if (/\d/.test(headerText) || /领涨|领跌/.test(headerText)) {
    throw new Error(`marketViews.${market} 不得重复数字或使用领涨领跌`);
  }
  if (
    market === "CN" &&
    /美股|纳斯达克|纳指|标普|道琼斯|道指|美债|美联储/.test(headerText)
  ) {
    throw new Error("CN 市场总览混入 US 行情");
  }
  if (
    market === "US" &&
    /A股|上证|沪深|中国大盘股|中国股市/.test(headerText)
  ) {
    throw new Error("US 市场总览混入 CN 行情");
  }
  assertMarketDirections(
    headerText,
    markets.filter((item) => item.region === market),
  );
  return { headline, summary, overview };
}

function phraseIsGrounded(phrase, sourceFacts) {
  const source = sourceFacts
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  const value = phrase
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  if (value.length >= 2 && source.includes(value)) return true;
  const chinesePairs = [
    ...value.matchAll(/(?=([\p{Script=Han}]{2}))/gu),
  ].map((match) => match[1]);
  if (chinesePairs.some((pair) => source.includes(pair))) return true;
  const englishWords = phrase
    .toLocaleLowerCase()
    .match(/[a-z]{4,}/g) ?? [];
  return englishWords.some((word) => source.includes(word));
}

function validateAgentSignal(
  value,
  {
    index,
    importance,
    reportDate,
    sourceFacts,
    enrichment,
    sectors,
    tickers,
    required,
  },
) {
  if (importance < 3) return undefined;
  if (!required && value === undefined) return undefined;
  const label = `stories[${index}].signal`;
  const signal = requireObject(value, label);
  const thesis = completeSentence(signal.thesis, `${label}.thesis`, 140, 20);
  const scoreReason = completeSentence(
    signal.scoreReason,
    `${label}.scoreReason`,
    100,
    12,
  );
  if (!signalHorizons.has(signal.horizon)) {
    throw new Error(`${label}.horizon 无效`);
  }
  if (!signalConfidences.has(signal.confidence)) {
    throw new Error(`${label}.confidence 无效`);
  }
  if (
    !Array.isArray(signal.transmission) ||
    signal.transmission.length < 1 ||
    signal.transmission.length > 3
  ) {
    throw new Error(`${label}.transmission 必须包含 1–3 步`);
  }
  const genericNodes =
    /^(?:事件|消息|政策|数据|公司|行业|市场|相关板块|相关资产|资产|风险偏好|估值|现金流)$/u;
  const transmission = signal.transmission.map((stepValue, stepIndex) => {
    const step = requireObject(
      stepValue,
      `${label}.transmission[${stepIndex}]`,
    );
    const order = Number(step.order);
    if (order !== stepIndex + 1 || order > 3) {
      throw new Error(`${label}.transmission[${stepIndex}].order 必须连续`);
    }
    const from = requireText(
      step.from,
      `${label}.transmission[${stepIndex}].from`,
      30,
      2,
    );
    const to = requireText(
      step.to,
      `${label}.transmission[${stepIndex}].to`,
      30,
      2,
    );
    const mechanism = completeSentence(
      step.mechanism,
      `${label}.transmission[${stepIndex}].mechanism`,
      100,
      12,
    );
    if (
      typeof step.conditional !== "boolean" ||
      (genericNodes.test(from) && genericNodes.test(to))
    ) {
      throw new Error(
        `${label}.transmission[${stepIndex}] 缺少具体事件或影响对象`,
      );
    }
    return {
      order,
      from,
      to,
      mechanism,
      conditional: step.conditional,
    };
  });
  if (!transmission.some((step) => phraseIsGrounded(step.from, sourceFacts))) {
    throw new Error(`${label}.transmission 起点无法回溯到已核验事实`);
  }

  if (
    !Array.isArray(signal.exposures) ||
    signal.exposures.length < 1 ||
    signal.exposures.length > 6
  ) {
    throw new Error(`${label}.exposures 必须包含 1–6 项`);
  }
  const supportedKeys = supportedEntityKeys(enrichment.entities);
  const exposures = signal.exposures.map((exposureValue, exposureIndex) => {
    const exposure = requireObject(
      exposureValue,
      `${label}.exposures[${exposureIndex}]`,
    );
    const ticker =
      typeof exposure.ticker === "string" && exposure.ticker.trim()
        ? exposure.ticker.trim().toUpperCase()
        : undefined;
    const exchange =
      typeof exposure.exchange === "string" && exposure.exchange.trim()
        ? exposure.exchange.trim().toUpperCase()
        : undefined;
    if (!signalDirections.has(exposure.direction)) {
      throw new Error(`${label}.exposures[${exposureIndex}].direction 无效`);
    }
    if (
      (ticker && !exchange) ||
      (!ticker && exchange) ||
      (ticker && !supportedKeys.has(`${exchange}:${ticker}`))
    ) {
      throw new Error(
        `${label}.exposures[${exposureIndex}] 含无法由事实归属的 ticker`,
      );
    }
    return {
      name: requireText(
        exposure.name,
        `${label}.exposures[${exposureIndex}].name`,
        36,
        2,
      ),
      ...(ticker ? { ticker, exchange } : {}),
      direction: exposure.direction,
      basis: completeSentence(
        exposure.basis,
        `${label}.exposures[${exposureIndex}].basis`,
        100,
        12,
      ),
    };
  });
  for (const entity of enrichment.entities) {
    if (
      !exposures.some(
        (exposure) =>
          exposure.ticker === entity.ticker &&
          exposure.exchange === entity.exchange,
      )
    ) {
      throw new Error(
        `${label}.exposures 必须包含 ${entity.exchange}:${entity.ticker}`,
      );
    }
    if (!tickers.includes(entity.ticker)) {
      throw new Error(
        `stories[${index}].tickers 必须包含 ${entity.ticker}`,
      );
    }
  }

  const checkpointValue = requireObject(
    signal.checkpoint,
    `${label}.checkpoint`,
  );
  const checkpoint = {
    metric: requireText(
      checkpointValue.metric,
      `${label}.checkpoint.metric`,
      72,
      4,
    ),
    dueAt: checkpointDueAt(
      reportDate,
      signal.horizon,
      checkpointValue.dueInDays,
    ),
    confirmIf: completeSentence(
      checkpointValue.confirmIf,
      `${label}.checkpoint.confirmIf`,
      120,
      12,
    ),
    invalidateIf: completeSentence(
      checkpointValue.invalidateIf,
      `${label}.checkpoint.invalidateIf`,
      120,
      12,
    ),
    status: "pending",
  };

  const generatedText = [
    thesis,
    scoreReason,
    ...transmission.flatMap((step) => [
      step.from,
      step.to,
      step.mechanism,
    ]),
    ...exposures.flatMap((exposure) => [exposure.name, exposure.basis]),
    checkpoint.metric,
    checkpoint.confirmIf,
    checkpoint.invalidateIf,
  ].join(" ");
  assertStoryFactsBounded(sourceFacts, generatedText);
  if (
    /投资者(可以|应当|应该)|值得关注|投资机会|(?:建议|应该|应当|可以).{0,6}(?:买入|卖出)|(?:买入|卖出)(?:建议|评级)|仓位|目标价/.test(
      generatedText,
    )
  ) {
    throw new Error(`${label} 含投资建议`);
  }

  return {
    thesis,
    scoreReason,
    baselineKind: enrichment.baselineKind,
    metrics: enrichment.metrics,
    reactions: enrichment.reactions,
    transmission,
    exposures,
    horizon: signal.horizon,
    confidence: signal.confidence,
    checkpoint,
  };
}

function validateLegacyReport(value, input) {
  const report = requireObject(value, "daily-report");
  const headline = requireText(report.headline, "headline", 22, 8);
  if (headline.includes("盘前简报") || /\d/.test(headline)) {
    throw new Error("headline 过于泛化或含数字");
  }
  const summary = completeSentence(report.summary, "summary", 88, 20);
  const overviewValue = requireObject(report.overview, "overview");
  if (!["positive", "negative", "mixed"].includes(overviewValue.tone)) {
    throw new Error("overview.tone 必须明确为 positive、negative 或 mixed");
  }
  const overview = {
    tone: overviewValue.tone,
    interpretation: completeSentence(
      overviewValue.interpretation,
      "overview.interpretation",
      180,
      42,
    ),
    positive: stringArray(
      overviewValue.positive,
      "overview.positive",
      4,
      18,
      0,
    ),
    negative: stringArray(
      overviewValue.negative,
      "overview.negative",
      4,
      18,
      0,
    ),
  };
  if (overview.positive.length + overview.negative.length < 2) {
    throw new Error("overview 至少列出两个受影响市场或板块");
  }
  if (overview.tone === "positive" && overview.positive.length === 0) {
    throw new Error("利好总览必须列出主要受益对象");
  }
  if (overview.tone === "negative" && overview.negative.length === 0) {
    throw new Error("利空总览必须列出主要承压对象");
  }
  if (
    overview.tone === "mixed" &&
    (overview.positive.length === 0 || overview.negative.length === 0)
  ) {
    throw new Error("分化总览必须同时列出利好与利空对象");
  }
  if (
    !/利好|利空|支撑|压制|估值|风险偏好|无风险利率|融资成本|现金流|需求|成本/.test(
      overview.interpretation,
    )
  ) {
    throw new Error("overview.interpretation 缺少利好/利空与传导机制");
  }
  const marketViewsValue = requireObject(report.marketViews, "marketViews");
  const marketViews = {
    CN: validateMarketView(marketViewsValue.CN, "CN", input.markets),
    US: validateMarketView(marketViewsValue.US, "US", input.markets),
  };
  if (!Array.isArray(report.stories) || report.stories.length !== input.news.length) {
    throw new Error("stories 必须逐条对应全部候选新闻");
  }

  const storyDrafts = report.stories.map((storyValue, index) => {
    const story = requireObject(storyValue, `stories[${index}]`);
    const sourceIndex = Number(story.sourceIndex);
    if (sourceIndex !== index) {
      throw new Error(`stories[${index}].sourceIndex 必须为 ${index}`);
    }
    if (!categories.has(story.category) || !tones.has(story.tone)) {
      throw new Error(`stories[${index}] 分类或方向无效`);
    }
    const importance = Number(story.importance);
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      throw new Error(`stories[${index}].importance 必须为 1–5`);
    }
    const title = requireText(story.title, `stories[${index}].title`, 28, 8);
    if (/[|｜]/.test(title) || !/[\u3400-\u9fff]/.test(title)) {
      throw new Error(`stories[${index}].title 必须是自然中文短标题`);
    }
    const storySummary = completeSentence(
      story.summary,
      `stories[${index}].summary`,
      90,
      15,
    );
    const interpretation = completeSentence(
      story.interpretation,
      `stories[${index}].interpretation`,
      130,
      18,
    );
    const sectors = stringArray(
      story.sectors,
      `stories[${index}].sectors`,
      3,
      18,
      1,
    );
    if (sectors.some((sector) => !/[\u3400-\u9fff]/.test(sector))) {
      throw new Error(`stories[${index}].sectors 必须是中文短标签`);
    }
    const sourceTitle = input.news[index].title;
    const sourceFacts = `${sourceTitle} ${input.news[index].facts}`;
    const enrichment = enrichNewsItem(input.news[index]);
    const sourceTopics = topicTags(sourceFacts);
    const generatedTopic = topicKey(title);
    if (
      sourceTopics.size > 0 &&
      !generatedTopic.startsWith("other:") &&
      !sourceTopics.has(generatedTopic)
    ) {
      throw new Error(`stories[${index}] 主题与来源标题不匹配`);
    }
    const mechanismTopic = generatedTopic.startsWith("other:")
      ? topicKey(sourceFacts)
      : generatedTopic;
    if (
      mechanismTopic === "equities" &&
      !/估值|风险偏好|指数权重|权重/.test(interpretation)
    ) {
      throw new Error(`stories[${index}] 指数新闻缺少估值、权重或风险偏好机制`);
    }
    if (
      mechanismTopic === "rates" &&
      !/折现率|融资成本|估值|债券吸引力|无风险利率/.test(interpretation)
    ) {
      throw new Error(`stories[${index}] 利率新闻缺少折现率或融资成本机制`);
    }
    const generatedText = [title, storySummary, interpretation].join(" ");
    assertStoryFactsBounded(sourceFacts, generatedText);
    assertToneIsAnalyzed(
      story.tone,
      interpretation,
      generatedText,
      `stories[${index}]`,
    );
    if (
      /投资者(可以|应当|应该)|值得关注|投资机会|继续(上涨|下跌)|建议|仍具吸引力|股票.{0,8}吸引力|股价.{0,8}吸引力/.test(
        generatedText,
      )
    ) {
      throw new Error(`stories[${index}] 含投资建议`);
    }
    if (
      /(下跌|大跌|暴跌|下挫|回落|下滑).{0,10}((会|将|可能).{0,4}导致|→).{0,12}(利润|盈利)|(上涨|大涨|反弹).{0,10}((会|将|可能).{0,4}导致|→).{0,12}(利润|盈利)|整个.{0,12}(行业|经济)的发展|投资者.{0,10}损失|利润变化|盈利变化|受影响板块|相关.{0,6}板块$/.test(
        interpretation,
      )
    ) {
      throw new Error(`stories[${index}] 存在空泛或倒置因果`);
    }
    if (
      !/利润|成本|利率|收益率|估值|现金流|风险偏好|需求|供给|产量|关税|贸易|出口|进口|汇率|融资|资本开支|油价|指数权重/.test(
        interpretation,
      )
    ) {
      throw new Error(`stories[${index}] 缺少具体市场传导机制`);
    }
    const enrichedTickers = new Set(
      enrichment.entities.map((entity) => entity.ticker),
    );
    const tickers = [
      ...new Set([
        ...stringArray(
          story.tickers,
          `stories[${index}].tickers`,
          4,
          6,
          0,
        )
          .map((ticker) => ticker.toUpperCase())
          .filter(
            (ticker) =>
              (/^[A-Z][A-Z0-9.-]{0,7}$/.test(ticker) ||
                /^\d{6}$/.test(ticker)) &&
              (tickerIsSupported(ticker, sourceFacts) ||
                enrichedTickers.has(ticker)),
          ),
        ...enrichedTickers,
      ]),
    ];
    if (tickers.length > 4) {
      throw new Error(`stories[${index}].tickers 来源公司超过 4 个`);
    }
    for (const group of requiredTickerGroups(sourceFacts)) {
      if (!group.accepted.some((ticker) => tickers.includes(ticker))) {
        throw new Error(
          `stories[${index}] 来源明确出现公司，必须填写 ${group.accepted.join(" 或 ")}`,
        );
      }
    }
    for (const entity of enrichment.entities) {
      if (!tickers.includes(entity.ticker)) {
        throw new Error(
          `stories[${index}] 来源明确出现上市公司，必须填写 ${entity.ticker}`,
        );
      }
    }
    const signal = validateAgentSignal(story.signal, {
      index,
      importance,
      reportDate: input.reportDate,
      sourceFacts,
      enrichment,
      sectors,
      tickers,
      required: input.contractVersion === "codex-daily-v8",
    });

    return {
      sourceIndex,
      category: story.category,
      importance,
      title,
      summary: storySummary,
      tone: story.tone,
      interpretation,
      sectors,
      tickers,
      ...(signal ? { signal } : {}),
    };
  });
  const signalMetadata = storyDrafts.some((story) => story.signal)
    ? assignSignalMetadata(input.news, storyDrafts)
    : [];
  const stories = storyDrafts.map((story, index) => {
    if (!story.signal) return story;
    return {
      ...story,
      signal: {
        version: 2,
        score: signalMetadata[index].score,
        scoreReason: story.signal.scoreReason,
        rankByMarket: signalMetadata[index].rankByMarket,
        roleByMarket: signalMetadata[index].roleByMarket,
        thesis: story.signal.thesis,
        baselineKind: story.signal.baselineKind,
        metrics: story.signal.metrics,
        reactions: story.signal.reactions,
        transmission: story.signal.transmission,
        exposures: story.signal.exposures,
        horizon: story.signal.horizon,
        confidence: story.signal.confidence,
        checkpoint: story.signal.checkpoint,
      },
    };
  });

  const translationsValue = requireObject(report.translations, "translations");
  const englishValue = requireObject(translationsValue.en, "translations.en");
  const englishOverviewValue = requireObject(
    englishValue.overview,
    "translations.en.overview",
  );
  const englishStoriesValue = englishValue.stories;
  if (
    !Array.isArray(englishStoriesValue) ||
    englishStoriesValue.length !== stories.length
  ) {
    throw new Error("translations.en.stories 必须逐条对应 stories");
  }
  const englishMarketViewsValue = requireObject(
    englishValue.marketViews,
    "translations.en.marketViews",
  );
  const englishMarketViews = Object.fromEntries(
    ["CN", "US"].map((market) => {
      const viewValue = requireObject(
        englishMarketViewsValue[market],
        `translations.en.marketViews.${market}`,
      );
      const viewOverviewValue = requireObject(
        viewValue.overview,
        `translations.en.marketViews.${market}.overview`,
      );
      const view = {
        headline: requireText(
          viewValue.headline,
          `translations.en.marketViews.${market}.headline`,
          100,
          8,
        ),
        summary: completeSentence(
          viewValue.summary,
          `translations.en.marketViews.${market}.summary`,
          240,
          20,
          ".",
        ),
        overview: {
          interpretation: completeSentence(
            viewOverviewValue.interpretation,
            `translations.en.marketViews.${market}.overview.interpretation`,
            420,
            30,
            ".",
          ),
          positive: stringArray(
            viewOverviewValue.positive,
            `translations.en.marketViews.${market}.overview.positive`,
            4,
            48,
            0,
          ),
          negative: stringArray(
            viewOverviewValue.negative,
            `translations.en.marketViews.${market}.overview.negative`,
            4,
            48,
            0,
          ),
        },
      };
      const viewText = [
        view.headline,
        view.summary,
        view.overview.interpretation,
        ...view.overview.positive,
        ...view.overview.negative,
      ].join(" ");
      if (/\d/.test(viewText)) {
        throw new Error(
          `translations.en.marketViews.${market} 不得重复行情数字`,
        );
      }
      if (
        market === "CN" &&
        /\bNasdaq\b|\bS&P\b|\bDow\b|\bTreasur|\bFederal Reserve\b/i.test(
          viewText,
        )
      ) {
        throw new Error("英文 CN 市场总览混入 US 行情");
      }
      if (
        market === "US" &&
        /\bA-shares?\b|\bShanghai\b|\bCSI\b|\bChina equities\b/i.test(
          viewText,
        )
      ) {
        throw new Error("英文 US 市场总览混入 CN 行情");
      }
      return [market, view];
    }),
  );
  const translations = {
    en: {
      headline: requireText(
        englishValue.headline,
        "translations.en.headline",
        100,
        8,
      ),
      summary: completeSentence(
        englishValue.summary,
        "translations.en.summary",
        240,
        20,
        ".",
      ),
      overview: {
        interpretation: completeSentence(
          englishOverviewValue.interpretation,
          "translations.en.overview.interpretation",
          420,
          30,
          ".",
        ),
        positive: stringArray(
          englishOverviewValue.positive,
          "translations.en.overview.positive",
          4,
          48,
          0,
        ),
        negative: stringArray(
          englishOverviewValue.negative,
          "translations.en.overview.negative",
          4,
          48,
          0,
        ),
      },
      marketViews: englishMarketViews,
      stories: englishStoriesValue.map((storyValue, index) => {
        const englishStory = requireObject(
          storyValue,
          `translations.en.stories[${index}]`,
        );
        const translated = {
          title: requireText(
            englishStory.title,
            `translations.en.stories[${index}].title`,
            120,
            6,
          ),
          summary: completeSentence(
            englishStory.summary,
            `translations.en.stories[${index}].summary`,
            260,
            12,
            ".",
          ),
          interpretation: completeSentence(
            englishStory.interpretation,
            `translations.en.stories[${index}].interpretation`,
            360,
            18,
            ".",
          ),
          sectors: stringArray(
            englishStory.sectors,
            `translations.en.stories[${index}].sectors`,
            3,
            40,
            1,
          ),
        };
        if (translated.sectors.length !== stories[index].sectors.length) {
          throw new Error(
            `translations.en.stories[${index}].sectors 必须逐项对应中文标签`,
          );
        }
        const englishSignalValue = englishStory.signal;
        if (stories[index].signal) {
          const englishSignal = requireObject(
            englishSignalValue,
            `translations.en.stories[${index}].signal`,
          );
          if (
            !Array.isArray(englishSignal.transmission) ||
            englishSignal.transmission.length !==
              stories[index].signal.transmission.length ||
            !Array.isArray(englishSignal.exposures) ||
            englishSignal.exposures.length !==
              stories[index].signal.exposures.length
          ) {
            throw new Error(
              `translations.en.stories[${index}].signal 必须对应中文传导和对象`,
            );
          }
          const englishCheckpoint = requireObject(
            englishSignal.checkpoint,
            `translations.en.stories[${index}].signal.checkpoint`,
          );
          translated.signal = {
            thesis: completeSentence(
              englishSignal.thesis,
              `translations.en.stories[${index}].signal.thesis`,
              360,
              20,
              ".",
            ),
            scoreReason: completeSentence(
              englishSignal.scoreReason,
              `translations.en.stories[${index}].signal.scoreReason`,
              240,
              12,
              ".",
            ),
            transmission: englishSignal.transmission.map(
              (stepValue, stepIndex) => {
                const step = requireObject(
                  stepValue,
                  `translations.en.stories[${index}].signal.transmission[${stepIndex}]`,
                );
                return {
                  from: requireText(
                    step.from,
                    `translations.en.stories[${index}].signal.transmission[${stepIndex}].from`,
                    90,
                    2,
                  ),
                  to: requireText(
                    step.to,
                    `translations.en.stories[${index}].signal.transmission[${stepIndex}].to`,
                    90,
                    2,
                  ),
                  mechanism: completeSentence(
                    step.mechanism,
                    `translations.en.stories[${index}].signal.transmission[${stepIndex}].mechanism`,
                    280,
                    10,
                    ".",
                  ),
                };
              },
            ),
            exposures: englishSignal.exposures.map(
              (exposureValue, exposureIndex) => {
                const exposure = requireObject(
                  exposureValue,
                  `translations.en.stories[${index}].signal.exposures[${exposureIndex}]`,
                );
                return {
                  name: requireText(
                    exposure.name,
                    `translations.en.stories[${index}].signal.exposures[${exposureIndex}].name`,
                    90,
                    2,
                  ),
                  basis: completeSentence(
                    exposure.basis,
                    `translations.en.stories[${index}].signal.exposures[${exposureIndex}].basis`,
                    280,
                    10,
                    ".",
                  ),
                };
              },
            ),
            checkpoint: {
              metric: requireText(
                englishCheckpoint.metric,
                `translations.en.stories[${index}].signal.checkpoint.metric`,
                180,
                4,
              ),
              confirmIf: completeSentence(
                englishCheckpoint.confirmIf,
                `translations.en.stories[${index}].signal.checkpoint.confirmIf`,
                320,
                10,
                ".",
              ),
              invalidateIf: completeSentence(
                englishCheckpoint.invalidateIf,
                `translations.en.stories[${index}].signal.checkpoint.invalidateIf`,
                320,
                10,
                ".",
              ),
              ...(typeof englishCheckpoint.observation === "string" &&
              englishCheckpoint.observation.trim()
                ? {
                    observation: completeSentence(
                      englishCheckpoint.observation,
                      `translations.en.stories[${index}].signal.checkpoint.observation`,
                      320,
                      10,
                      ".",
                    ),
                  }
                : {}),
            },
          };
        } else if (englishSignalValue !== undefined) {
          throw new Error(
            `translations.en.stories[${index}].signal 不应为低重要度新闻生成`,
          );
        }
        const translatedSignalText = translated.signal
          ? [
              translated.signal.thesis,
              translated.signal.scoreReason,
              ...translated.signal.transmission.flatMap((step) => [
                step.from,
                step.to,
                step.mechanism,
              ]),
              ...translated.signal.exposures.flatMap((exposure) => [
                exposure.name,
                exposure.basis,
              ]),
              translated.signal.checkpoint.metric,
              translated.signal.checkpoint.confirmIf,
              translated.signal.checkpoint.invalidateIf,
            ]
          : [];
        assertNumbersBounded(
          `${input.news[index].title} ${input.news[index].facts}`,
          [
            translated.title,
            translated.summary,
            translated.interpretation,
            ...translatedSignalText,
          ].join(" "),
        );
        return translated;
      }),
    },
  };

  const headerText = [
    headline,
    summary,
    overview.interpretation,
    ...overview.positive,
    ...overview.negative,
  ].join("\n");
  if (/\d/.test(headerText)) {
    throw new Error("顶部总览不得重复具体数字或日期，行情卡片已展示这些信息");
  }
  if (/领涨|领跌/.test(headerText)) {
    throw new Error("顶部总览不得使用相对领涨或领跌措辞");
  }
  assertMarketDirections(headerText, input.markets);

  return {
    headline,
    summary,
    overview,
    marketViews,
    stories,
    translations,
  };
}

function marketTone(input, market) {
  const symbol = market === "CN" ? "SSE" : "SPX";
  return input.markets.find((item) => item.symbol === symbol)?.direction === "down"
    ? "negative"
    : "positive";
}

function causalHeadline(value, label, { sectorNames, driverTitles, unattributed, english = false }) {
  const headline = requireText(value, label, english ? 110 : 32, english ? 8 : 8);
  const movement = english
    ? /\b(?:rose|fell|gained|slid|higher|lower|led|lagged|rallied|retreated)\b/i
    : /上涨|下跌|普涨|普跌|收涨|收跌|走强|走弱|领涨|领跌|反弹|回落|承压/;
  if (!movement.test(headline)) {
    throw new Error(`${label} 必须说明市场表现`);
  }
  const normalized = headline.toLocaleLowerCase();
  const sectorGrounded = sectorNames.some((phrase) => {
    const candidate = String(phrase).trim().toLocaleLowerCase();
    return candidate.length >= 2 && normalized.includes(candidate);
  });
  const driverGrounded = driverTitles.some((title) => phraseIsGrounded(headline, title));
  if ((!sectorGrounded && !driverGrounded) || (unattributed && !sectorGrounded)) {
    throw new Error(`${label} 必须包含可回溯的原因或行业`);
  }
  if (/^(?:股指|指数|大盘|市场)(?:普涨|普跌|分化|走强|走弱)$/.test(headline)) {
    throw new Error(`${label} 是无原因标题`);
  }
  return headline;
}

function insufficientCoverage(input, market, kind) {
  const coverage = input.newsDiagnostics?.activeRetrieval?.coverageByMarket?.[market];
  if (coverage?.status !== "insufficient") return false;
  if (!kind) return true;
  return coverage.missingIntentKinds?.includes(kind) ||
    coverage.activeSearchCompleted === false;
}

function validateV9Report(value, input) {
  const report = requireObject(value, "daily-report");
  const driversValue = Array.isArray(report.drivers) ? report.drivers : null;
  if (!driversValue) throw new Error("drivers 必须是数组");
  const marketSessions = Object.fromEntries(input.marketSessions.map((item) => [item.market, item]));
  const driverCounts = { CN: 0, US: 0 };
  const primaryCounts = { CN: 0, US: 0 };

  const drivers = driversValue.map((value, index) => {
    const label = `drivers[${index}]`;
    const driver = requireObject(value, label);
    if (!["CN", "US"].includes(driver.market)) throw new Error(`${label}.market 无效`);
    if (!["primary", "secondary"].includes(driver.role)) throw new Error(`${label}.role 无效`);
    if (!signalDirections.has(driver.direction)) throw new Error(`${label}.direction 无效`);
    const title = requireText(driver.title, `${label}.title`, 34, 6);
    const summary = completeSentence(driver.summary, `${label}.summary`, 120, 18);
    const mechanism = completeSentence(driver.mechanism, `${label}.mechanism`, 160, 22);
    const sectorSymbols = stringArray(driver.sectorSymbols, `${label}.sectorSymbols`, 5, 10, 1);
    const performance = input.sectorPerformance.filter((item) => item.market === driver.market);
    if (sectorSymbols.some((symbol) => !performance.some((item) => item.symbol === symbol))) {
      throw new Error(`${label}.sectorSymbols 包含其他市场或未知行业`);
    }
    if (!driverDirectionMatches(driver.direction, sectorSymbols, performance)) {
      throw new Error(`${label} 与行业涨跌方向不一致`);
    }
    if (!Array.isArray(driver.evidenceIndexes) || driver.evidenceIndexes.length < 2 || driver.evidenceIndexes.length > 3) {
      throw new Error(`${label}.evidenceIndexes 必须包含 2–3 项`);
    }
    const evidenceIndexes = [...new Set(driver.evidenceIndexes.map(Number))];
    if (
      evidenceIndexes.length !== driver.evidenceIndexes.length ||
      evidenceIndexes.some((sourceIndex) => !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= input.news.length)
    ) {
      throw new Error(`${label}.evidenceIndexes 无效`);
    }
    const evidence = evidenceIndexes.map((sourceIndex) => input.news[sourceIndex]);
    if (evidence.some((item) => !evidenceFitsSession(item, marketSessions[driver.market]))) {
      throw new Error(`${label} 引用了归因窗口之外的消息`);
    }
    if (
      evidence.some((item) => item.platform === "x") &&
      !evidence.some((item) => item.platform !== "x")
    ) {
      throw new Error(`${label} 引用 X 时必须包含非 X 交叉验证来源`);
    }
    const localWraps = evidence.filter((item) =>
      localMarketWrapMatches(
        item,
        driver.market,
        performance,
        marketSessions[driver.market],
      ),
    );
    if (localWraps.length === 0) {
      throw new Error(`${label} 缺少本地收盘归因证据`);
    }
    if (
      !evidence.some(
        (item) =>
          causalEventEvidenceMatches(item) &&
          localWraps.every((wrap) => wrap.url !== item.url),
      )
    ) {
      throw new Error(`${label} 缺少独立的因果事件证据`);
    }
    const sourceFacts = evidence.map((item) => `${item.title} ${item.facts}`).join(" ");
    if (/\p{Script=Han}/u.test(sourceFacts) && !phraseIsGrounded(title, sourceFacts)) {
      throw new Error(`${label}.title 无法回溯到已核验事实`);
    }
    assertNumbersBounded(sourceFacts, `${title} ${summary} ${mechanism}`);
    driverCounts[driver.market] += 1;
    if (driver.role === "primary") primaryCounts[driver.market] += 1;
    return {
      id: stableId(`${driver.market}:${title}:${evidenceIndexes.join(",")}`),
      market: driver.market,
      role: driver.role,
      direction: driver.direction,
      title,
      summary,
      mechanism,
      sectorSymbols,
      evidenceIndexes,
    };
  });
  for (const market of ["CN", "US"]) {
    if (driverCounts[market] > 3 || primaryCounts[market] > 1) {
      throw new Error(`${market} 只能包含一条主驱动和最多两条次驱动`);
    }
    if (driverCounts[market] > 0 && primaryCounts[market] !== 1) {
      throw new Error(`${market} 有驱动时必须且只能有一条主驱动`);
    }
  }

  const aiUpdatesValue = Array.isArray(report.aiChainUpdates)
    ? report.aiChainUpdates
    : null;
  if (!aiUpdatesValue) throw new Error("aiChainUpdates 必须是数组");
  const aiUpdateCounts = { CN: 0, US: 0 };
  const aiUpdateLayers = { CN: new Set(), US: new Set() };
  const aiChainUpdates = aiUpdatesValue.map((value, index) => {
    const label = `aiChainUpdates[${index}]`;
    const update = requireObject(value, label);
    if (!["CN", "US"].includes(update.market)) {
      throw new Error(`${label}.market 无效`);
    }
    if (!AI_CHAIN_LAYERS.includes(update.layer)) {
      throw new Error(`${label}.layer 无效`);
    }
    if (aiUpdateLayers[update.market].has(update.layer)) {
      throw new Error(`${label} 与同市场已有 AI 产业链环节重复`);
    }
    const title = requireText(update.title, `${label}.title`, 38, 8);
    const summary = completeSentence(update.summary, `${label}.summary`, 180, 30);
    const implication = completeSentence(
      update.implication,
      `${label}.implication`,
      180,
      24,
    );
    if (
      !Array.isArray(update.evidenceIndexes) ||
      update.evidenceIndexes.length < 1 ||
      update.evidenceIndexes.length > 3
    ) {
      throw new Error(`${label}.evidenceIndexes 必须包含 1–3 项`);
    }
    const evidenceIndexes = [...new Set(update.evidenceIndexes.map(Number))];
    if (
      evidenceIndexes.length !== update.evidenceIndexes.length ||
      evidenceIndexes.some(
        (sourceIndex) =>
          !Number.isInteger(sourceIndex) ||
          sourceIndex < 0 ||
          sourceIndex >= input.news.length,
      )
    ) {
      throw new Error(`${label}.evidenceIndexes 无效`);
    }
    const evidence = evidenceIndexes.map((sourceIndex) => input.news[sourceIndex]);
    if (
      evidence.some(
        (item) =>
          !item.regions.includes(update.market) ||
          !evidenceFitsSession(item, marketSessions[update.market]),
      )
    ) {
      throw new Error(`${label} 引用了其他市场或归因窗口之外的消息`);
    }
    if (
      evidence.some((item) => item.platform === "x") &&
      !evidence.some((item) => item.platform !== "x")
    ) {
      throw new Error(`${label} 引用 X 时必须包含非 X 交叉验证来源`);
    }
    const sourceFacts = evidence
      .map((item) => `${item.title} ${item.facts}`)
      .join(" ");
    if (/\p{Script=Han}/u.test(sourceFacts) && !phraseIsGrounded(title, sourceFacts)) {
      throw new Error(`${label}.title 无法回溯到已核验事实`);
    }
    assertNumbersBounded(sourceFacts, `${title} ${summary} ${implication}`);
    aiUpdateCounts[update.market] += 1;
    aiUpdateLayers[update.market].add(update.layer);
    return {
      id: stableId(
        `ai:${update.market}:${update.layer}:${title}:${evidenceIndexes.join(",")}`,
      ),
      market: update.market,
      layer: update.layer,
      title,
      summary,
      implication,
      evidenceIndexes,
    };
  });
  if (aiUpdateCounts.CN > 4 || aiUpdateCounts.US > 4) {
    throw new Error("每个市场最多包含 4 条 AI 产业链动态");
  }

  const aiChainViewsValue = requireObject(report.aiChainViews, "aiChainViews");
  const aiChainViews = {};
  for (const market of ["CN", "US"]) {
    const label = `aiChainViews.${market}`;
    const value = requireObject(aiChainViewsValue[market], label);
    const agentStatus = value.driverStatus;
    if (!["explained", "partial", "unattributed"].includes(agentStatus)) {
      throw new Error(`${label}.driverStatus 无效`);
    }
    if ((aiUpdateCounts[market] === 0) !== (agentStatus === "unattributed")) {
      throw new Error(`${label}.driverStatus 与 AI 驱动数量不一致`);
    }
    const marketMetrics = input.aiChainPerformance
      .filter((item) => item.market === market)
      .map((item) => ({
        ...item,
        changeValue: Number(item.change.replace("%", "")),
      }))
      .sort((left, right) => right.changeValue - left.changeValue);
    const marketUpdates = aiChainUpdates.filter((item) => item.market === market);
    const agentSummary = completeSentence(value.summary, `${label}.summary`, 150, 24);
    if (agentStatus === "unattributed" && !/未发现单一消息主导/.test(agentSummary)) {
      throw new Error(`${label}.summary 必须明确未发现单一消息主导`);
    }
    const isInsufficient =
      aiUpdateCounts[market] === 0 &&
      insufficientCoverage(input, market, "ai_extremes");
    const status = isInsufficient ? "insufficient" : agentStatus;
    const summary = isInsufficient
      ? "当日可核验的 AI 产业链异动证据覆盖不足，暂不作单一归因。"
      : agentSummary;
    aiChainViews[market] = {
      headline: causalHeadline(value.headline, `${label}.headline`, {
        sectorNames: marketMetrics.map((item) => item.name),
        driverTitles: marketUpdates.map((item) => item.title),
        unattributed: aiUpdateCounts[market] === 0,
      }),
      summary,
      driverStatus: status,
      leaderLayers: marketMetrics.slice(0, 2).map((item) => item.layer),
      laggardLayers: marketMetrics.slice(-2).reverse().map((item) => item.layer),
      driverIds: marketUpdates.map((item) => item.id),
    };
  }

  const marketViewsValue = requireObject(report.marketViews, "marketViews");
  const marketViews = {};
  for (const market of ["CN", "US"]) {
    const value = requireObject(marketViewsValue[market], `marketViews.${market}`);
    const agentStatus = value.driverStatus;
    if (!["explained", "partial", "unattributed"].includes(agentStatus)) {
      throw new Error(`marketViews.${market}.driverStatus 无效`);
    }
    if ((driverCounts[market] === 0) !== (agentStatus === "unattributed")) {
      throw new Error(`marketViews.${market}.driverStatus 与驱动数量不一致`);
    }
    const agentSummary = completeSentence(value.summary, `marketViews.${market}.summary`, 120, 20);
    if (agentStatus === "unattributed" && !/未发现单一消息主导/.test(agentSummary)) {
      throw new Error(`marketViews.${market}.summary 必须明确未发现单一消息主导`);
    }
    const isInsufficient =
      driverCounts[market] === 0 && insufficientCoverage(input, market);
    const status = isInsufficient ? "insufficient" : agentStatus;
    const summary = isInsufficient
      ? "当日可核验的本地收盘与异动证据覆盖不足，暂不作单一归因。"
      : agentSummary;
    const extremes = sectorExtremes(input.sectorPerformance, market);
    const marketDrivers = drivers.filter((item) => item.market === market);
    const headline = causalHeadline(value.headline, `marketViews.${market}.headline`, {
      sectorNames: input.sectorPerformance.filter((item) => item.market === market).map((item) => item.name),
      driverTitles: marketDrivers.map((item) => item.title),
      unattributed: driverCounts[market] === 0,
    });
    const tone = marketTone(input, market);
    marketViews[market] = {
      headline,
      summary,
      driverStatus: status,
      leaderSectorSymbols: extremes.leaders.map((item) => item.symbol),
      laggardSectorSymbols: extremes.laggards.map((item) => item.symbol),
      driverIds: marketDrivers.map((item) => item.id),
      overview: {
        tone,
        interpretation: summary,
        positive: extremes.leaders.map((item) => item.name),
        negative: extremes.laggards.map((item) => item.name),
      },
    };
  }

  const headline = causalHeadline(report.headline, "headline", {
    sectorNames: input.sectorPerformance.map((item) => item.name),
    driverTitles: drivers.map((item) => item.title),
    unattributed: drivers.length === 0,
  });
  const summary = completeSentence(report.summary, "summary", 150, 24);

  const english = requireObject(requireObject(report.translations, "translations").en, "translations.en");
  const englishDriversValue = english.drivers;
  if (!Array.isArray(englishDriversValue) || englishDriversValue.length !== drivers.length) {
    throw new Error("translations.en.drivers 必须逐项对应 drivers");
  }
  const translatedDrivers = englishDriversValue.map((value, index) => {
    const translated = requireObject(value, `translations.en.drivers[${index}]`);
    return {
      title: requireText(translated.title, `translations.en.drivers[${index}].title`, 120, 5),
      summary: completeSentence(translated.summary, `translations.en.drivers[${index}].summary`, 320, 12, "."),
      mechanism: completeSentence(translated.mechanism, `translations.en.drivers[${index}].mechanism`, 380, 14, "."),
    };
  });
  const englishAiUpdatesValue = english.aiChainUpdates;
  if (
    !Array.isArray(englishAiUpdatesValue) ||
    englishAiUpdatesValue.length !== aiChainUpdates.length
  ) {
    throw new Error("translations.en.aiChainUpdates 必须逐项对应 aiChainUpdates");
  }
  const translatedAiUpdates = englishAiUpdatesValue.map((value, index) => {
    const translated = requireObject(
      value,
      `translations.en.aiChainUpdates[${index}]`,
    );
    return {
      title: requireText(
        translated.title,
        `translations.en.aiChainUpdates[${index}].title`,
        140,
        8,
      ),
      summary: completeSentence(
        translated.summary,
        `translations.en.aiChainUpdates[${index}].summary`,
        420,
        18,
        ".",
      ),
      implication: completeSentence(
        translated.implication,
        `translations.en.aiChainUpdates[${index}].implication`,
        420,
        18,
        ".",
      ),
    };
  });
  const englishMarketViewsValue = requireObject(english.marketViews, "translations.en.marketViews");
  const englishMarketViews = {};
  for (const market of ["CN", "US"]) {
    const value = requireObject(englishMarketViewsValue[market], `translations.en.marketViews.${market}`);
    const translatedMarketDrivers = translatedDrivers.filter((_, index) => drivers[index].market === market);
    const isInsufficient = marketViews[market].driverStatus === "insufficient";
    const translatedSummary = completeSentence(
      value.summary,
      `translations.en.marketViews.${market}.summary`,
      320,
      18,
      ".",
    );
    const summary = isInsufficient
      ? "Verified session evidence is incomplete, so no single-cause attribution is made."
      : translatedSummary;
    englishMarketViews[market] = {
      headline: causalHeadline(value.headline, `translations.en.marketViews.${market}.headline`, {
        sectorNames: input.sectorPerformance.filter((item) => item.market === market).map((item) => item.nameEn),
        driverTitles: translatedMarketDrivers.map((item) => item.title),
        unattributed: driverCounts[market] === 0,
        english: true,
      }),
      summary,
      driverStatus: marketViews[market].driverStatus,
      overview: {
        tone: marketViews[market].overview.tone,
        interpretation: summary,
        positive: sectorExtremes(input.sectorPerformance, market).leaders.map((item) => item.nameEn),
        negative: sectorExtremes(input.sectorPerformance, market).laggards.map((item) => item.nameEn),
      },
    };
  }
  const englishAiChainViewsValue = requireObject(
    english.aiChainViews,
    "translations.en.aiChainViews",
  );
  const englishAiChainViews = {};
  for (const market of ["CN", "US"]) {
    const label = `translations.en.aiChainViews.${market}`;
    const value = requireObject(englishAiChainViewsValue[market], label);
    const translatedMarketUpdates = translatedAiUpdates.filter(
      (_, index) => aiChainUpdates[index].market === market,
    );
    const isInsufficient = aiChainViews[market].driverStatus === "insufficient";
    englishAiChainViews[market] = {
      headline: causalHeadline(value.headline, `${label}.headline`, {
        sectorNames: input.aiChainPerformance
          .filter((item) => item.market === market)
          .map((item) => item.nameEn),
        driverTitles: translatedMarketUpdates.map((item) => item.title),
        unattributed: aiUpdateCounts[market] === 0,
        english: true,
      }),
      summary: isInsufficient
        ? "Verified AI-chain evidence is incomplete, so no single-cause attribution is made."
        : completeSentence(value.summary, `${label}.summary`, 380, 20, "."),
    };
  }
  const allExtremes = ["CN", "US"].flatMap((market) => {
    const extremes = sectorExtremes(input.sectorPerformance, market);
    return [...extremes.leaders, ...extremes.laggards];
  });
  const positive = allExtremes.filter((item) => item.direction === "up").map((item) => item.name);
  const negative = allExtremes.filter((item) => item.direction === "down").map((item) => item.name);
  const translations = {
    en: {
      headline: causalHeadline(english.headline, "translations.en.headline", {
        sectorNames: input.sectorPerformance.map((item) => item.nameEn),
        driverTitles: translatedDrivers.map((item) => item.title),
        unattributed: drivers.length === 0,
        english: true,
      }),
      summary: completeSentence(english.summary, "translations.en.summary", 380, 20, "."),
      overview: {
        interpretation: completeSentence(english.summary, "translations.en.summary", 380, 20, "."),
        positive: positive.map((item) => input.sectorPerformance.find((sector) => sector.name === item)?.nameEn ?? item),
        negative: negative.map((item) => input.sectorPerformance.find((sector) => sector.name === item)?.nameEn ?? item),
      },
      marketViews: englishMarketViews,
      aiChainViews: englishAiChainViews,
      drivers: translatedDrivers,
      aiChainUpdates: translatedAiUpdates,
      stories: [],
    },
  };
  return {
    headline,
    summary,
    overview: {
      tone: marketViews.CN.overview.tone === marketViews.US.overview.tone
        ? marketViews.CN.overview.tone
        : "mixed",
      interpretation: summary,
      positive,
      negative,
    },
    marketViews,
    aiChainViews,
    drivers,
    aiChainUpdates,
    stories: [],
    translations,
  };
}

export function validateReport(value, input) {
  return input.contractVersion === "market-attribution-v9"
    ? validateV9Report(value, input)
    : validateLegacyReport(value, input);
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function stableId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function buildReportContent(input, report) {
  const marketAsOf = marketAsOfFromInput(input);
  if (input.contractVersion === "market-attribution-v9") {
    return JSON.stringify({
      contractVersion: input.contractVersion,
      overview: report.overview,
      marketViews: report.marketViews,
      aiChainViews: report.aiChainViews,
      updateKind: input.updateKind,
      marketAsOf,
      marketSessions: input.marketSessions,
      markets: input.markets.map(({ asOf: _asOf, previousAsOf: _previousAsOf, ...market }) => market),
      sectorPerformance: input.sectorPerformance,
      aiChainPerformance: input.aiChainPerformance,
      sectorHeat: input.sectorHeat,
      drivers: report.drivers.map((driver) => ({
        id: driver.id,
        market: driver.market,
        role: driver.role,
        direction: driver.direction,
        title: driver.title,
        summary: driver.summary,
        mechanism: driver.mechanism,
        sectorSymbols: driver.sectorSymbols,
        evidence: driver.evidenceIndexes.map((sourceIndex) => {
          const source = input.news[sourceIndex];
          return {
            title: source.title,
            facts: source.facts,
            source: source.url,
            sourceLabel: source.source,
            publishedAt: source.publishedAt,
            kind: source.kind,
            ...(source.platform ? { platform: source.platform } : {}),
            ...(source.authority ? { authority: source.authority } : {}),
            ...(source.authorHandle ? { authorHandle: source.authorHandle } : {}),
          };
        }),
      })),
      aiChainUpdates: report.aiChainUpdates.map((update) => ({
        id: update.id,
        market: update.market,
        layer: update.layer,
        title: update.title,
        summary: update.summary,
        implication: update.implication,
        evidence: update.evidenceIndexes.map((sourceIndex) => {
          const source = input.news[sourceIndex];
          return {
            title: source.title,
            facts: source.facts,
            source: source.url,
            sourceLabel: source.source,
            publishedAt: source.publishedAt,
            kind: source.kind,
            ...(source.platform ? { platform: source.platform } : {}),
            ...(source.authority ? { authority: source.authority } : {}),
            ...(source.authorHandle ? { authorHandle: source.authorHandle } : {}),
          };
        }),
      })),
      stories: [],
      translations: report.translations,
      isSample: false,
    });
  }
  return JSON.stringify({
    overview: report.overview,
    marketViews: report.marketViews,
    updateKind: input.updateKind,
    marketAsOf,
    markets: input.markets.map(({ asOf: _asOf, ...market }) => market),
    sectorHeat: input.sectorHeat,
    stories: report.stories.map((story) => {
      const source = input.news[story.sourceIndex];
      const enrichment = enrichNewsItem(source);
      return {
        id: stableId(source.url),
        regions: source.regions,
        category: story.category,
        importance: story.importance,
        title: story.title,
        summary: story.summary,
        evidence: `原始标题：${source.title}；核验事实：${source.facts}`,
        source: source.url,
        sourceLabel: source.source,
        publishedAt: source.publishedAt,
        evidenceSource: enrichment.evidenceSource,
        ai: {
          tone: story.tone,
          interpretation: story.interpretation,
          sectors: story.sectors,
          tickers: story.tickers,
        },
        ...(story.signal ? { signal: story.signal } : {}),
      };
    }),
    translations: report.translations,
    isSample: false,
  });
}

function completedSql(input, report) {
  const finishedAt = new Date().toISOString();
  const marketAsOf = marketAsOfFromInput(input);
  const dataCut = `CN ${marketAsOf.CN} · US ${marketAsOf.US}`;
  const content = buildReportContent(input, report);

  return `
UPDATE daily_reports
SET edition = edition + 10000
WHERE report_date > ${sqlText(input.reportDate)}
  AND NOT EXISTS (
    SELECT 1 FROM daily_reports WHERE report_date = ${sqlText(input.reportDate)}
  );

UPDATE daily_reports
SET edition = edition - 9999
WHERE edition >= 10000;

INSERT INTO daily_reports (
  report_date, edition, headline, summary, generated_at,
  data_cut, agent_model, content
) VALUES (
  ${sqlText(input.reportDate)},
  COALESCE(
    (SELECT edition FROM daily_reports WHERE report_date = ${sqlText(input.reportDate)}),
    (
      SELECT COUNT(*) + 1
      FROM daily_reports
      WHERE report_date < ${sqlText(input.reportDate)}
    )
  ),
  ${sqlText(report.headline)},
  ${sqlText(report.summary)},
  ${sqlText(finishedAt)},
  ${sqlText(dataCut)},
  ${sqlText(AGENT_MODEL)},
  ${sqlText(content)}
)
ON CONFLICT(report_date) DO UPDATE SET
  headline = excluded.headline,
  summary = excluded.summary,
  generated_at = excluded.generated_at,
  data_cut = excluded.data_cut,
  agent_model = excluded.agent_model,
  content = excluded.content,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO ingestion_runs (
  run_id, report_date, started_at, finished_at, status,
  market_count, news_count, error
) VALUES (
  ${sqlText(input.runId)},
  ${sqlText(input.reportDate)},
  ${sqlText(input.collectedAt)},
  ${sqlText(finishedAt)},
  'completed',
  ${input.markets.length},
  ${input.news.length},
  NULL
)
ON CONFLICT(run_id) DO UPDATE SET
  finished_at = excluded.finished_at,
  status = 'completed',
  market_count = excluded.market_count,
  news_count = excluded.news_count,
  error = NULL;

DELETE FROM ingestion_runs
WHERE julianday(started_at) < julianday('now', '-90 days');
`;
}

function failedSql(input, error) {
  const finishedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
  return `
INSERT INTO ingestion_runs (
  run_id, report_date, started_at, finished_at, status,
  market_count, news_count, error
) VALUES (
  ${sqlText(input.runId)},
  ${sqlText(input.reportDate)},
  ${sqlText(input.collectedAt)},
  ${sqlText(finishedAt)},
  'failed',
  ${input.markets.length},
  ${input.news.length},
  ${sqlText(message)}
)
ON CONFLICT(run_id) DO UPDATE SET
  finished_at = excluded.finished_at,
  status = 'failed',
  market_count = excluded.market_count,
  news_count = excluded.news_count,
  error = excluded.error;
`;
}

async function executeSql(sql, { local = false } = {}) {
  const wranglerPath = resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = await execFileAsync(
    wranglerPath,
    [
      "d1",
      "execute",
      "stock-daily-db",
      local ? "--local" : "--remote",
      "--yes",
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const local = process.argv.includes("--local");
  const paths = process.argv
    .slice(2)
    .filter((argument) => !["--check", "--local"].includes(argument));
  const inputPath = resolve(paths[0] ?? "work/daily-input.json");
  const reportPath = resolve(paths[1] ?? "work/daily-report.json");
  const input = validateInput(JSON.parse(await readFile(inputPath, "utf8")));

  try {
    const report = validateReport(
      JSON.parse(await readFile(reportPath, "utf8")),
      input,
    );
    if (checkOnly) {
      console.log(
        JSON.stringify(
          {
            status: "valid",
            reportDate: input.reportDate,
            marketCount: input.markets.length,
            storyCount: report.stories.length,
            driverCount: report.drivers?.length ?? 0,
          },
          null,
          2,
        ),
      );
      return;
    }

    const output = await executeSql(completedSql(input, report), { local });
    console.log(
      JSON.stringify(
        {
          status: "published",
          reportDate: input.reportDate,
          marketCount: input.markets.length,
          storyCount: report.stories.length,
          driverCount: report.drivers?.length ?? 0,
          database: local ? "stock-daily-db (local)" : "stock-daily-db",
          wrangler: output,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (!checkOnly) {
      try {
        await executeSql(failedSql(input, error), { local });
      } catch {
        // The primary error is more useful than a secondary audit failure.
      }
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
