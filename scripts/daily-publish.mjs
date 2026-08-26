import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AI_CHAIN_LAYERS } from "./ai-chain.mjs";
import { auditCodexRun } from "./daily-agent-audit.mjs";
import { buildMarketBriefs } from "./daily-collect.mjs";
import {
  DAILY_UPDATE_KINDS,
  dailyCutoffAt,
  marketAsOfFromInput,
} from "./daily-policy.mjs";
import { auditReportSources } from "./daily-source-audit.mjs";
import {
  buildMarketSessions,
  driverDirectionMatches,
} from "./market-attribution.mjs";
import {
  SECTOR_COUNT_PER_MARKET,
  sectorHeatScore,
  topSectorHeat,
} from "./sector-heat.mjs";

const execFileAsync = promisify(execFile);
const AGENT_MODEL = "openai/codex-scheduled";
const CONTRACT_VERSION = "codex-market-research-v10";
const MARKETS = ["CN", "US"];
const DRIVER_STATUSES = new Set(["explained", "partial", "structural"]);
const DRIVER_BASES = new Set(["structural", "event", "macro"]);
const DRIVER_DIRECTIONS = new Set(["positive", "negative", "mixed"]);
const EVIDENCE_KINDS = new Set([
  "market_data",
  "market_wrap",
  "event",
  "official",
]);
const SOURCE_TYPES = new Set(["first_party", "publisher", "expert"]);
const FIRST_PARTY_SOURCE_DOMAINS = [
  "bea.gov",
  "bls.gov",
  "cmegroup.com",
  "csindex.com.cn",
  "eia.gov",
  "federalreserve.gov",
  "gov.cn",
  "hkex.com.hk",
  "hkexnews.hk",
  "nasdaq.com",
  "nyse.com",
  "pbc.gov.cn",
  "sec.gov",
  "sse.com.cn",
  "stats.gov.cn",
  "szse.cn",
  "treasury.gov",
];
const ESTABLISHED_PUBLISHER_HOSTS = new Set([
  "21jingji.com",
  "apnews.com",
  "barrons.com",
  "bloomberg.com",
  "caixin.com",
  "cls.cn",
  "cnbc.com",
  "cnstock.com",
  "finance.eastmoney.com",
  "finance.yahoo.com",
  "ft.com",
  "marketwatch.com",
  "m.nbd.com.cn",
  "nbd.com.cn",
  "people.com.cn",
  "reuters.com",
  "finance.sina.com.cn",
  "stcn.com",
  "thepaper.cn",
  "wap.eastmoney.com",
  "wsj.com",
  "wtop.com",
  "xinhuanet.com",
  "yicai.com",
]);
const SEARCH_RESULT_URL =
  /(?:google\.[^/]+\/search|bing\.com\/search|search\.brave\.com\/search|duckduckgo\.com\/?\?q=)/iu;
const INTERNAL_COPY =
  /\b(?:Codex|OpenAI|API(?:\s+Skill)?|Agent|provider|schema|pipeline|market_data_query|newsDiagnostics|schemaVersion|contractVersion)\b|内部评分|调试标记/iu;
const RAW_DATE_OR_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?\b/u;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function verifiedExternalSourceType(source, platform = "web") {
  if (platform === "x") return "expert";
  let hostname;
  try {
    hostname = new URL(source).hostname.toLocaleLowerCase();
  } catch {
    return "expert";
  }
  if (
    FIRST_PARTY_SOURCE_DOMAINS.some((domain) =>
      hostnameMatches(hostname, domain),
    )
  ) {
    return "first_party";
  }
  const publisherHostname = hostname.replace(/^www\./u, "");
  if (ESTABLISHED_PUBLISHER_HOSTS.has(publisherHostname)) {
    return "publisher";
  }
  return "expert";
}

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
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length < minLength) throw new Error(`${label} 少于 ${minLength} 字`);
  if (text.length > maxLength) throw new Error(`${label} 超过 ${maxLength} 字`);
  return text;
}

function readerText(value, label, maxLength, minLength = 2) {
  const text = requireText(value, label, maxLength, minLength);
  if (INTERNAL_COPY.test(text)) throw new Error(`${label} 暴露了内部实现术语`);
  if (RAW_DATE_OR_TIMESTAMP.test(text)) {
    throw new Error(`${label} 包含未本地化的时间戳或日期`);
  }
  return text;
}

function stringArray(value, label, minItems, maxItems, maxLength = 80) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  const items = value.map((item, index) =>
    requireText(item, `${label}[${index}]`, maxLength, 1),
  );
  if (items.length < minItems || items.length > maxItems) {
    throw new Error(`${label} 数量必须为 ${minItems}–${maxItems}`);
  }
  if (new Set(items).size !== items.length) throw new Error(`${label} 不得重复`);
  return items;
}

function numericChange(item) {
  const match = String(item?.change ?? "").match(/^([+-]?\d+(?:\.\d+)?)%$/u);
  return match ? Number(match[1]) : Number.NaN;
}

function expectedDirection(change) {
  return Math.abs(change) < 0.005 ? "flat" : change > 0 ? "up" : "down";
}

function validateConstituents(items, market, asOf, label) {
  if (!Array.isArray(items) || items.length !== 4) {
    throw new Error(`${label}.constituents 必须包含四只代表标的`);
  }
  const symbols = new Set();
  for (const [index, value] of items.entries()) {
    const item = requireObject(value, `${label}.constituents[${index}]`);
    const change = numericChange(item);
    const close = Number(String(item.value ?? "").replaceAll(",", ""));
    if (
      typeof item.symbol !== "string" ||
      !item.symbol.trim() ||
      symbols.has(item.symbol) ||
      typeof item.name !== "string" ||
      typeof item.nameEn !== "string" ||
      !Number.isFinite(close) ||
      close <= 0 ||
      !Number.isFinite(change) ||
      item.direction !== expectedDirection(change) ||
      item.asOf !== asOf ||
      typeof item.source !== "string" ||
      !item.source.startsWith("https://")
    ) {
      throw new Error(`${label}.constituents 字段无效`);
    }
    symbols.add(item.symbol);
  }
}

function validateSectorRows(rows, expectedPerMarket, label) {
  if (!Array.isArray(rows) || rows.length !== expectedPerMarket * 2) {
    throw new Error(`${label} 必须分别包含 ${expectedPerMarket} 个 CN 与 US 行业`);
  }
  const counts = { CN: 0, US: 0 };
  const keys = new Set();
  for (const [index, value] of rows.entries()) {
    const row = requireObject(value, `${label}[${index}]`);
    const change = numericChange(row);
    const key = `${row.market}:${row.symbol}`;
    if (
      !MARKETS.includes(row.market) ||
      typeof row.symbol !== "string" ||
      !/^[A-Z0-9]{2,10}$/u.test(row.symbol) ||
      typeof row.name !== "string" ||
      typeof row.nameEn !== "string" ||
      !Number.isFinite(change) ||
      row.direction !== expectedDirection(change) ||
      row.score !== sectorHeatScore(row.market, change) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(row.asOf) ||
      typeof row.source !== "string" ||
      !row.source.startsWith("https://") ||
      keys.has(key)
    ) {
      throw new Error(`${label} 字段无效`);
    }
    validateConstituents(row.constituents, row.market, row.asOf, `${label}.${key}`);
    keys.add(key);
    counts[row.market] += 1;
  }
  if (counts.CN !== expectedPerMarket || counts.US !== expectedPerMarket) {
    throw new Error(`${label} 市场数量无效`);
  }
}

function validateAiChainRows(rows) {
  if (!Array.isArray(rows) || rows.length !== AI_CHAIN_LAYERS.length * 2) {
    throw new Error("aiChainPerformance 必须分别包含八个 CN 与 US 环节");
  }
  for (const market of MARKETS) {
    const marketRows = rows.filter((row) => row?.market === market);
    if (
      marketRows.length !== AI_CHAIN_LAYERS.length ||
      new Set(marketRows.map((row) => row.layer)).size !== AI_CHAIN_LAYERS.length
    ) {
      throw new Error(`${market} AI 产业链环节不完整`);
    }
    for (const layer of AI_CHAIN_LAYERS) {
      const row = requireObject(
        marketRows.find((item) => item.layer === layer),
        `aiChainPerformance.${market}.${layer}`,
      );
      const change = numericChange(row);
      if (
        row.benchmarkKind !== "equal_weight_basket" ||
        typeof row.name !== "string" ||
        typeof row.nameEn !== "string" ||
        typeof row.benchmark !== "string" ||
        typeof row.benchmarkEn !== "string" ||
        row.symbol !== `AI-${market}-${layer}` ||
        !Number.isFinite(change) ||
        row.direction !== expectedDirection(change) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(row.asOf) ||
        typeof row.source !== "string" ||
        !row.source.startsWith("https://")
      ) {
        throw new Error(`aiChainPerformance.${market}.${layer} 字段无效`);
      }
      validateConstituents(
        row.constituents,
        market,
        row.asOf,
        `aiChainPerformance.${market}.${layer}`,
      );
    }
  }
}

function validateMarkets(input) {
  if (!Array.isArray(input.markets) || input.markets.length !== 10) {
    throw new Error("markets 必须包含十项行情");
  }
  const expectedSymbols = new Set([
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
  ]);
  const counts = { CN: 0, US: 0 };
  for (const market of input.markets) {
    const changeMatch = String(market?.change ?? "").match(
      market?.symbol === "DGS10"
        ? /^([+-]?\d+(?:\.\d+)?)\s*bp$/u
        : /^([+-]?\d+(?:\.\d+)?)%$/u,
    );
    const change = changeMatch ? Number(changeMatch[1]) : Number.NaN;
    if (
      !MARKETS.includes(market?.region) ||
      !expectedSymbols.delete(market.symbol) ||
      typeof market.name !== "string" ||
      !market.name.trim() ||
      typeof market.value !== "string" ||
      !market.value.trim() ||
      !Number.isFinite(change) ||
      market.direction !== expectedDirection(change) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(market.asOf ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(market.previousAsOf ?? "") ||
      market.previousAsOf >= market.asOf ||
      typeof market.source !== "string" ||
      !market.source.startsWith("https://")
    ) {
      throw new Error("行情字段无效");
    }
    counts[market.region] += 1;
  }
  if (expectedSymbols.size || counts.CN !== 6 || counts.US !== 4) {
    throw new Error("行情必须包含六个 CN 与四个 US 指标");
  }
}

function validateMarketDataDiagnostics(input) {
  const diagnostics = requireObject(
    input.marketDataDiagnostics,
    "marketDataDiagnostics",
  );
  const providers = Array.isArray(diagnostics.providers) ? diagnostics.providers : [];
  const bySymbol = new Map(input.markets.map((market) => [market.symbol, market]));
  if (
    diagnostics.schemaVersion !== "market-data-query.v1" ||
    diagnostics.status !== "ok" ||
    diagnostics.source !== "market_data_query" ||
    diagnostics.persistence !== "none" ||
    Date.parse(diagnostics.cutoffAt) !== Date.parse(input.cutoffAt) ||
    diagnostics.marketCount !== 10 ||
    !Number.isFinite(Date.parse(diagnostics.computedAt)) ||
    providers.length !== 10 ||
    new Set(providers.map((item) => item?.symbol)).size !== 10 ||
    providers.some((provider) => {
      const market = bySymbol.get(provider?.symbol);
      return (
        !market ||
        provider.asOf !== market.asOf ||
        provider.previousAsOf !== market.previousAsOf
      );
    })
  ) {
    throw new Error("行情必须来自包含前一交易日的完整 daily-pack");
  }
}

function validateSessionsAndDates(input) {
  const expected = buildMarketSessions(input.markets);
  if (JSON.stringify(input.marketSessions) !== JSON.stringify(expected)) {
    throw new Error("marketSessions 与行情交易日不一致");
  }
  for (const session of expected) {
    const sectorDates = new Set(
      input.sectorPerformance
        .filter((item) => item.market === session.market)
        .map((item) => item.asOf),
    );
    const aiDates = new Set(
      input.aiChainPerformance
        .filter((item) => item.market === session.market)
        .map((item) => item.asOf),
    );
    if (
      sectorDates.size !== 1 ||
      !sectorDates.has(session.asOf) ||
      aiDates.size !== 1 ||
      !aiDates.has(session.asOf)
    ) {
      throw new Error(`${session.market} 行情、行业与 AI 交易日不一致`);
    }
  }
}

function validateMarketBriefs(input) {
  const expected = buildMarketBriefs({
    markets: input.markets,
    marketSessions: input.marketSessions,
    sectorPerformance: input.sectorPerformance,
    aiChainPerformance: input.aiChainPerformance,
  });
  if (JSON.stringify(input.marketBriefs) !== JSON.stringify(expected)) {
    throw new Error("marketBriefs 必须由本次确定性行情生成");
  }
}

function validateSectorHeatSelection(input) {
  const expected = MARKETS.flatMap((market) =>
    topSectorHeat(
      input.sectorPerformance.filter((item) => item.market === market),
    ),
  );
  if (JSON.stringify(input.sectorHeat) !== JSON.stringify(expected)) {
    throw new Error("sectorHeat 必须由完整一级行业确定性选出");
  }
}

export function validateInput(value) {
  const input = requireObject(value, "daily-input");
  if (
    input.schemaVersion !== 10 ||
    input.contractVersion !== CONTRACT_VERSION ||
    typeof input.runId !== "string" ||
    input.runId.length < 8 ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.reportDate ?? "") ||
    !DAILY_UPDATE_KINDS.includes(input.updateKind) ||
    input.cutoffAt !== dailyCutoffAt(input.reportDate, input.updateKind) ||
    !Number.isFinite(Date.parse(input.collectedAt)) ||
    Object.hasOwn(input, "news") ||
    Object.hasOwn(input, "newsDiagnostics")
  ) {
    throw new Error(`daily-input 不符合 ${CONTRACT_VERSION}`);
  }
  validateMarkets(input);
  validateMarketDataDiagnostics(input);
  validateSectorRows(input.sectorPerformance, 11, "sectorPerformance");
  validateSectorRows(input.sectorHeat, SECTOR_COUNT_PER_MARKET, "sectorHeat");
  validateSectorHeatSelection(input);
  validateAiChainRows(input.aiChainPerformance);
  validateSessionsAndDates(input);
  validateMarketBriefs(input);
  return input;
}

function marketDataRecords(input, market) {
  const records = [];
  for (const metric of input.markets.filter((item) => item.region === market)) {
    if (metric.source) {
      records.push({
        source: metric.source,
        scope: "index",
        symbol: metric.symbol,
        data: metric,
      });
    }
  }
  for (const row of input.sectorPerformance.filter(
    (item) => item.market === market,
  )) {
    if (row.source) {
      records.push({
        source: row.source,
        scope: "sector",
        sectorSymbol: row.symbol,
        data: row,
      });
    }
    for (const constituent of row.constituents ?? []) {
      if (constituent.source) {
        records.push({
          source: constituent.source,
          scope: "sector_constituent",
          sectorSymbol: row.symbol,
          data: { sector: row.symbol, constituent },
        });
      }
    }
  }
  for (const row of input.aiChainPerformance.filter(
    (item) => item.market === market,
  )) {
    if (row.source) {
      records.push({
        source: row.source,
        scope: "ai",
        layer: row.layer,
        data: row,
      });
    }
    for (const constituent of row.constituents ?? []) {
      if (constituent.source) {
        records.push({
          source: constituent.source,
          scope: "ai_constituent",
          layer: row.layer,
          data: { layer: row.layer, constituent },
        });
      }
    }
  }
  return records;
}

function marketDataSourceSet(input, market) {
  return new Set(marketDataRecords(input, market).map((item) => item.source));
}

function marketDataBindings(input, market, source) {
  return marketDataRecords(input, market).filter(
    (record) => record.source === source,
  );
}

function canonicalSectorEvidence(input, market, source) {
  if (marketDataSourceSet(input, market).has(source)) return null;
  let quoteSymbol = "";
  try {
    const url = new URL(source);
    const match =
      url.hostname === "finance.yahoo.com"
        ? /^\/quote\/([^/]+)\/history\/?$/iu.exec(url.pathname)
        : null;
    quoteSymbol = match ? decodeURIComponent(match[1]).toUpperCase() : "";
  } catch {
    return null;
  }
  const matches = marketDataRecords(input, market).filter((record) => {
    if (record.scope !== "sector") return false;
    const symbol = String(record.sectorSymbol).toUpperCase();
    return quoteSymbol === symbol || quoteSymbol === `${symbol}.SS`;
  });
  if (matches.length !== 1) return null;
  const canonicalSource = matches[0].source;
  const hostname = new URL(canonicalSource).hostname.toLowerCase();
  return {
    source: canonicalSource,
    sourceLabel: hostname.endsWith("csindex.com.cn")
      ? "中证指数有限公司"
      : hostname.endsWith("nasdaq.com")
        ? "Nasdaq"
        : "市场行情",
    sourceType: verifiedExternalSourceType(canonicalSource, "web"),
  };
}

function validateEvidence(value, input, market, label) {
  const evidence = requireObject(value, label);
  const title = readerText(evidence.title, `${label}.title`, 220, 4);
  const facts = readerText(evidence.facts, `${label}.facts`, 1600, 20);
  let source = requireText(evidence.source, `${label}.source`, 1200, 12);
  let sourceLabel = readerText(
    evidence.sourceLabel,
    `${label}.sourceLabel`,
    80,
    2,
  );
  let sourceType = evidence.sourceType;
  if (evidence.kind === "market_data") {
    const canonical = canonicalSectorEvidence(input, market, source);
    if (canonical) {
      source = canonical.source;
      sourceLabel = canonical.sourceLabel;
      sourceType = canonical.sourceType;
    }
  }
  const publishedAt = requireText(
    evidence.publishedAt,
    `${label}.publishedAt`,
    40,
    10,
  );
  const publishedTime = Date.parse(publishedAt);
  if (
    !source.startsWith("https://") ||
    SEARCH_RESULT_URL.test(source) ||
    !EVIDENCE_KINDS.has(evidence.kind) ||
    !SOURCE_TYPES.has(sourceType) ||
    !["web", "x"].includes(evidence.platform) ||
    typeof evidence.authorHandle !== "string" ||
    !Number.isFinite(publishedTime) ||
    !ISO_TIMESTAMP.test(publishedAt)
  ) {
    throw new Error(`${label} 证据字段无效`);
  }
  const authorHandle = evidence.authorHandle.trim();
  const xSourceMatch = source.match(
    /^https:\/\/x\.com\/([a-z0-9_]+)\/status\/\d+(?:[/?#]|$)/iu,
  );
  if (
    (evidence.platform === "x" &&
      (!xSourceMatch ||
        !authorHandle ||
        xSourceMatch[1].toLocaleLowerCase() !==
          authorHandle.toLocaleLowerCase())) ||
    (evidence.platform === "web" && authorHandle)
  ) {
    throw new Error(`${label} 平台与作者字段不一致`);
  }

  const verifiedSourceType =
    evidence.kind === "market_data"
      ? sourceType
      : verifiedExternalSourceType(source, evidence.platform);
  if (
    evidence.kind !== "market_data" &&
    sourceType !== verifiedSourceType
  ) {
    throw new Error(`${label} 来源层级与 URL 不一致`);
  }

  const session = input.marketSessions.find((item) => item.market === market);
  const dataSources = marketDataSourceSet(input, market);
  if (evidence.kind === "market_data") {
    const bindings = marketDataBindings(input, market, source);
    if (
      !dataSources.has(source) ||
      sourceType === "expert" ||
      evidence.platform !== "web" ||
      publishedAt !== session.windowEnd
    ) {
      throw new Error(`${label} 行情证据必须逐字引用本次输入`);
    }
    assertNumbersBounded(
      approvedGroundingText(bindings.map((binding) => binding.data)),
      `${title} ${facts}`,
      `${label}.facts`,
    );
  } else {
    const start = Date.parse(session.windowStart);
    const close = Date.parse(session.windowEnd);
    const deadline = Date.parse(session.wrapDeadline);
    if (
      publishedTime <= start ||
      publishedTime > deadline ||
      dataSources.has(source) ||
      (evidence.kind === "market_wrap" && publishedTime < close) ||
      (evidence.kind !== "market_wrap" && publishedTime > close)
    ) {
      throw new Error(`${label} 外部证据不在本次市场窗口内`);
    }
  }
  return {
    title,
    facts,
    source,
    sourceLabel,
    publishedAt: new Date(publishedTime).toISOString(),
    kind: evidence.kind,
    sourceType: verifiedSourceType,
    platform: evidence.platform,
    authorHandle: xSourceMatch?.[1] ?? "",
  };
}

const COUNT_GROUNDING_FIELDS = {
  advancing: "advancing count sectors up",
  declining: "declining count sectors down",
  flat: "flat count sectors flat",
  marketCount: "market indicator total count",
  equityIndexCount: "equity index total count",
  sectorCount: "sector total count",
  aiLayerCount: "AI layer total count",
};

export function approvedGroundingText(value) {
  const facts = [];
  function visit(item) {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    if (typeof item.value === "string" && item.value.trim()) {
      facts.push(`level ${item.value}`);
    }
    if (typeof item.change === "string" && item.change.trim()) {
      facts.push(`change ${item.change} direction ${item.direction ?? ""}`);
    }
    if (Number.isInteger(item.tenor) && item.tenor > 0) {
      facts.push(`tenor ${item.tenor}Y`);
    }
    for (const [field, prefix] of Object.entries(COUNT_GROUNDING_FIELDS)) {
      if (Number.isInteger(item[field]) && item[field] >= 0) {
        const unit = field === "aiLayerCount"
          ? "layers"
          : field === "marketCount"
            ? "indicators"
            : field === "equityIndexCount"
              ? "indices"
            : "sectors";
        facts.push(`${prefix} ${item[field]} ${unit}`);
      }
    }
    for (const child of Object.values(item)) {
      if (child && typeof child === "object") visit(child);
    }
  }
  visit(value);
  return facts.join("\n");
}

function groundingEnvelope(input, market) {
  const markets = input.markets.filter(
    (item) => !market || item.region === market,
  );
  const sectors = input.sectorPerformance.filter(
    (item) => !market || item.market === market,
  );
  const aiLayers = input.aiChainPerformance.filter(
    (item) => !market || item.market === market,
  );
  const coveredMarkets = market ? [market] : MARKETS;
  return {
    marketCount: markets.length,
    equityIndexCount: markets.filter((item) => item.symbol !== "DGS10").length,
    sectorCount: sectors.length,
    aiLayerCount: aiLayers.length,
    markets,
    sectorPerformance: sectors,
    aiChainPerformance: aiLayers,
    marketBriefs: market ? input.marketBriefs[market] : input.marketBriefs,
    marketCoverage: coveredMarkets.map((coveredMarket) => ({
      marketCount: input.markets.filter(
        (item) => item.region === coveredMarket,
      ).length,
      equityIndexCount: input.markets.filter(
        (item) => item.region === coveredMarket && item.symbol !== "DGS10",
      ).length,
      sectorCount: input.sectorPerformance.filter(
        (item) => item.market === coveredMarket,
      ).length,
      aiLayerCount: input.aiChainPerformance.filter(
        (item) => item.market === coveredMarket,
      ).length,
    })),
    treasuryTenor: markets.some((item) => item.symbol === "DGS10")
      ? { tenor: 10 }
      : undefined,
  };
}

function chineseInteger(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九]$/u.test(value)) return digits[value];
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (Object.hasOwn(digits, character)) {
      current = digits[character];
    } else if (character === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else {
      return value;
    }
  }
  return total + current;
}

function sanitizeNumericText(value) {
  return String(value)
    .normalize("NFC")
    .toLocaleLowerCase()
    .replaceAll(",", "")
    .replaceAll("，", "")
    .replace(/https:\/\/[^\s"'<>\])}]+/giu, " ")
    .replace(
      /\b\d{4}-\d{1,2}-\d{1,2}(?:t\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2})?)?\b/giu,
      " ",
    )
    .replace(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/giu,
      " ",
    )
    .replace(/\b\d{4}年\d{1,2}月\d{1,2}日/gu, " ")
    .replace(/\b\d{1,2}月\d{1,2}日/gu, " ")
    .replace(/[零〇一二两三四五六七八九十百]{1,4}月[零〇一二两三四五六七八九十百]{1,4}日/gu, " ")
    .replace(
      /[零〇一二两三四五六七八九十百]{1,6}(?=(?:个)?(?:月|年|点|基点|百分点|只|项|层|家|条|次|种|行业|板块|环节))/gu,
      (match) => String(chineseInteger(match)),
    )
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, " ");
}

function claimUnit(before, after) {
  const head = before.slice(-32);
  const tail = after.trimStart();
  if (/^(?:%|％|个百分点|percent(?:age)?(?:\s+points?)?|pct\b)/iu.test(tail)) {
    return "percent";
  }
  if (/^(?:bp|bps|个?\s*基点|basis\s+points?\b)/iu.test(tail)) {
    return "basis_point";
  }
  if (/^(?:点|points?\b)/iu.test(tail) || /(?:level|收于|报于|报)\s*$/iu.test(head)) {
    return "level";
  }
  if (/^(?:-?months?\b|个?月\b)/iu.test(tail)) {
    return "count";
  }
  if (/^(?:-?year\b|years?\b|年期|年\b|y\b)/iu.test(tail)) {
    return "tenor";
  }
  if (
    /^(?:个|只|项|层|家|条|次|种|行业|板块|环节|股指|涨|跌|平|sectors?\b|layers?\b|indicators?\b|indices\b|indexes\b|stocks?\b|companies?\b|items?\b)/iu.test(
      tail,
    )
  ) {
    return "count";
  }
  return /(?:tenor)\s*$/iu.test(head) ? "tenor" : "bare";
}

function directionWord(value) {
  if (
    /(?:上涨|上升|收涨|涨幅|增长|增加|改善|走高|升|\bup\b|\brose\b|\brisen\b|\bgained\b|\badvanced\b|\bincreased\b|\bhigher\b)/iu.test(
      value,
    )
  ) {
    return "positive";
  }
  if (
    /(?:下跌|下降|收跌|跌幅|减少|降低|回落|走低|跌|\bdown\b|\bfell\b|\blost\b|\bdeclined\b|\bdecreased\b|\blower\b)/iu.test(
      value,
    )
  ) {
    return "negative";
  }
  if (/(?:持平|\bflat\b|\bunchanged\b)/iu.test(value)) return "flat";
  return "neutral";
}

function claimPolarity(raw, before, after, unit) {
  const sign = raw.startsWith("+")
    ? "positive"
    : raw.startsWith("-")
      ? "negative"
      : "neutral";
  if (/(?:至|到|\bto\b|\bat\b)\s*$/iu.test(before)) return "neutral";
  if (unit === "count" && /(?:\bof\b|共)\s*$/iu.test(before)) {
    return "neutral";
  }
  const prefix = before.match(
    /(?:上涨|上升|收涨|涨幅|增长|增加|改善|走高|下跌|下降|收跌|跌幅|减少|降低|回落|走低|\bup\b|\brose\b|\bgained\b|\badvanced\b|\bincreased\b|\bhigher\b|\bdown\b|\bfell\b|\blost\b|\bdeclined\b|\bdecreased\b|\blower\b|持平|\bflat\b|\bunchanged\b)\s*(?:约|了|为)?\s*$/iu,
  )?.[0];
  const suffix = after.match(
    /^(?:\s*(?:%|％|个百分点|percent(?:age)?(?:\s+points?)?|pct\b|bp|bps|个?\s*基点|basis\s+points?\b|点|points?\b|个|只|项|层|家|条|次|种|行业|板块|环节|股指|sectors?\b|layers?\b|indicators?\b|indices\b|indexes\b|stocks?\b|companies?\b|items?\b))*\s*(?:上涨|上升|收涨|涨幅|增长|增加|改善|走高|涨|下跌|下降|收跌|跌幅|减少|降低|回落|走低|跌|持平|\bup\b|\brose\b|\bgained\b|\badvanced\b|\bincreased\b|\bhigher\b|\bdown\b|\bfell\b|\blost\b|\bdeclined\b|\bdecreased\b|\blower\b|\bflat\b|\bunchanged\b)/iu,
  )?.[0];
  const word = directionWord(`${prefix ?? ""} ${suffix ?? ""}`);
  if (sign !== "neutral" && word !== "neutral" && sign !== word) {
    return "conflict";
  }
  return sign !== "neutral" ? sign : word;
}

export function numericClaims(value) {
  const text = sanitizeNumericText(value);
  const claims = [];
  const pattern = /[+-]?\d+(?:\.\d+)?/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index;
    const end = index + raw.length;
    const before = text.slice(Math.max(0, index - 48), index);
    const after = text.slice(end, Math.min(text.length, end + 48));
    const unit = claimUnit(before, after);
    const previous = text[index - 1] ?? "";
    const next = text[end] ?? "";
    if (
      /(?:s&p|csi|star|dgs|标普|沪深|中证|科创)\s*$/iu.test(before) ||
      /[a-z0-9_]/iu.test(previous) ||
      (/[a-z_]/iu.test(next) && unit !== "tenor") ||
      (unit === "bare" &&
        (/[\p{L}]/u.test(previous) ||
          /[\p{L}]/u.test(next)))
    ) {
      continue;
    }
    claims.push({
      raw,
      number: String(Math.abs(Number(raw))),
      unit,
      polarity: claimPolarity(raw, before, after, unit),
    });
  }
  return claims;
}

function assertNumbersBounded(sourceFacts, generatedText, label) {
  const sourceClaims = numericClaims(sourceFacts);
  for (const claim of numericClaims(generatedText)) {
    const sameNumberAndUnit = sourceClaims.filter(
      (source) =>
        source.number === claim.number && source.unit === claim.unit,
    );
    if (sameNumberAndUnit.length === 0) {
      throw new Error(`${label} 引用了证据未提供的数字 ${claim.raw}`);
    }
    if (
      claim.polarity === "conflict" ||
      (claim.polarity !== "neutral" &&
        !sameNumberAndUnit.some(
          (source) => source.polarity === claim.polarity,
        ))
    ) {
      throw new Error(
        `${label} 引用了证据未提供的数字 ${claim.raw}，或涨跌方向与证据不一致`,
      );
    }
  }
}

function inputGroundingText(input) {
  return approvedGroundingText(groundingEnvelope(input));
}

function marketGroundingText(input, market) {
  return approvedGroundingText(groundingEnvelope(input, market));
}

function aiGroundingText(input, market) {
  const aiLayers = input.aiChainPerformance.filter(
    (item) => item.market === market,
  );
  return approvedGroundingText({
    aiLayerCount: aiLayers.length,
    aiChainPerformance: aiLayers,
    aiLeaders: input.marketBriefs[market].aiLeaders,
    aiLaggards: input.marketBriefs[market].aiLaggards,
  });
}

function evidenceGroundingText(input, market, evidence) {
  const marketBindings = evidence
    .filter((item) => item.kind === "market_data")
    .flatMap((item) => marketDataBindings(input, market, item.source))
    .map((binding) => binding.data);
  return `${approvedGroundingText(marketBindings)} ${evidence
    .map((item) => `${item.title} ${item.facts}`)
    .join(" ")}`;
}

function validateDriver(value, input, index) {
  const label = `drivers[${index}]`;
  const driver = requireObject(value, label);
  if (
    !MARKETS.includes(driver.market) ||
    !["primary", "secondary"].includes(driver.role) ||
    !DRIVER_BASES.has(driver.basis) ||
    !DRIVER_DIRECTIONS.has(driver.direction)
  ) {
    throw new Error(`${label} 分类字段无效`);
  }
  const title = readerText(driver.title, `${label}.title`, 80, 5);
  const summary = readerText(driver.summary, `${label}.summary`, 300, 15);
  const mechanism = readerText(driver.mechanism, `${label}.mechanism`, 460, 20);
  const sectorSymbols = stringArray(
    driver.sectorSymbols,
    `${label}.sectorSymbols`,
    1,
    4,
    16,
  );
  const marketSectors = input.sectorPerformance.filter(
    (item) => item.market === driver.market,
  );
  const allowedSymbols = new Set(marketSectors.map((item) => item.symbol));
  if (sectorSymbols.some((symbol) => !allowedSymbols.has(symbol))) {
    throw new Error(`${label} 引用了其他市场或不存在的行业`);
  }
  if (
    !driverDirectionMatches(
      driver.direction,
      sectorSymbols,
      input.sectorPerformance,
    )
  ) {
    throw new Error(`${label} 与行业涨跌方向不一致`);
  }
  if (!Array.isArray(driver.evidence) || driver.evidence.length < 1 || driver.evidence.length > 4) {
    throw new Error(`${label}.evidence 数量必须为 1–4`);
  }
  const evidence = driver.evidence.map((item, evidenceIndex) =>
    validateEvidence(item, input, driver.market, `${label}.evidence[${evidenceIndex}]`),
  );
  if (new Set(evidence.map((item) => item.source)).size !== evidence.length) {
    throw new Error(`${label}.evidence URL 不得重复`);
  }
  const marketData = evidence.filter((item) => item.kind === "market_data");
  const external = evidence.filter((item) => item.kind !== "market_data");
  if (
    marketData.some((item) =>
      marketDataBindings(input, driver.market, item.source).every(
        (binding) =>
          binding.scope !== "index" &&
          !(
            ["sector", "sector_constituent"].includes(binding.scope) &&
            sectorSymbols.includes(binding.sectorSymbol)
          ),
      ),
    )
  ) {
    throw new Error(`${label} 的行情证据与驱动行业不匹配`);
  }
  if (
    (driver.basis === "structural" &&
      (marketData.length < 1 || external.length > 0)) ||
    (driver.basis !== "structural" &&
      (marketData.length < 1 ||
        !external.some((item) => item.sourceType !== "expert")))
  ) {
    throw new Error(`${label} 的 ${driver.basis} 证据组合不充分`);
  }
  const generatedText = `${title} ${summary} ${mechanism}`;
  assertNumbersBounded(
    `${marketGroundingText(input, driver.market)} ${evidenceGroundingText(
      input,
      driver.market,
      evidence,
    )}`,
    generatedText,
    label,
  );
  return {
    market: driver.market,
    role: driver.role,
    basis: driver.basis,
    direction: driver.direction,
    title,
    summary,
    mechanism,
    sectorSymbols,
    evidence,
  };
}

function validateAiUpdate(value, input, index) {
  const label = `aiChainUpdates[${index}]`;
  const update = requireObject(value, label);
  if (!MARKETS.includes(update.market) || !AI_CHAIN_LAYERS.includes(update.layer)) {
    throw new Error(`${label} 市场或环节无效`);
  }
  const title = readerText(update.title, `${label}.title`, 90, 5);
  const summary = readerText(update.summary, `${label}.summary`, 360, 20);
  const implication = readerText(
    update.implication,
    `${label}.implication`,
    420,
    20,
  );
  if (!Array.isArray(update.evidence) || update.evidence.length < 2 || update.evidence.length > 4) {
    throw new Error(`${label}.evidence 数量必须为 2–4`);
  }
  const evidence = update.evidence.map((item, evidenceIndex) =>
    validateEvidence(item, input, update.market, `${label}.evidence[${evidenceIndex}]`),
  );
  if (
    !evidence.some((item) => item.kind === "market_data") ||
    !evidence.some(
      (item) => item.kind !== "market_data" && item.sourceType !== "expert",
    )
  ) {
    throw new Error(`${label} 缺少 AI 行情与外部交叉证据`);
  }
  if (
    !evidence.some(
      (item) => {
        if (item.kind !== "market_data") return false;
        const bindings = marketDataBindings(input, update.market, item.source);
        const aiBindings = bindings.filter((binding) =>
          ["ai", "ai_constituent"].includes(binding.scope),
        );
        return aiBindings.some(
          (binding) =>
            binding.layer === update.layer &&
            (binding.scope === "ai_constituent" ||
              new Set(aiBindings.map((candidate) => candidate.layer)).size === 1),
        );
      },
    )
  ) {
    throw new Error(`${label} 未引用对应 AI 环节的本地行情`);
  }
  assertNumbersBounded(
    evidenceGroundingText(input, update.market, evidence),
    `${title} ${summary} ${implication}`,
    label,
  );
  return {
    market: update.market,
    layer: update.layer,
    title,
    summary,
    implication,
    evidence,
  };
}

function validateViews(value, label) {
  const views = requireObject(value, label);
  return Object.fromEntries(
    MARKETS.map((market) => {
      const view = requireObject(views[market], `${label}.${market}`);
      if (!DRIVER_STATUSES.has(view.driverStatus)) {
        throw new Error(`${label}.${market}.driverStatus 无效`);
      }
      return [
        market,
        {
          headline: readerText(
            view.headline,
            `${label}.${market}.headline`,
            90,
            5,
          ),
          summary: readerText(
            view.summary,
            `${label}.${market}.summary`,
            360,
            20,
          ),
          driverStatus: view.driverStatus,
        },
      ];
    }),
  );
}

function validateResearchAudit(value) {
  const audit = requireObject(value, "researchAudit");
  return Object.fromEntries(
    MARKETS.map((market) => {
      const item = requireObject(audit[market], `researchAudit.${market}`);
      const queries = stringArray(
        item.queries,
        `researchAudit.${market}.queries`,
        3,
        12,
        220,
      );
      if (
        !Number.isInteger(item.sourcesReviewed) ||
        item.sourcesReviewed < 1 ||
        !["sufficient", "limited"].includes(item.outcome)
      ) {
        throw new Error(`researchAudit.${market} 字段无效`);
      }
      return [
        market,
        {
          queries,
          sourcesReviewed: item.sourcesReviewed,
          outcome: item.outcome,
        },
      ];
    }),
  );
}

function validateTranslation(value, drivers, aiUpdates, input) {
  const translations = requireObject(value, "translations");
  const en = requireObject(translations.en, "translations.en");
  const marketViews = requireObject(
    en.marketViews,
    "translations.en.marketViews",
  );
  const aiChainViews = requireObject(
    en.aiChainViews,
    "translations.en.aiChainViews",
  );
  const translatedDrivers = Array.isArray(en.drivers) ? en.drivers : [];
  const translatedAiUpdates = Array.isArray(en.aiChainUpdates)
    ? en.aiChainUpdates
    : [];
  if (
    translatedDrivers.length !== drivers.length ||
    translatedAiUpdates.length !== aiUpdates.length
  ) {
    throw new Error("英文翻译必须与中文驱动和 AI 动态逐项对应");
  }
  const result = {
    headline: readerText(en.headline, "translations.en.headline", 140, 5),
    summary: readerText(en.summary, "translations.en.summary", 500, 20),
    marketViews: {},
    aiChainViews: {},
    drivers: translatedDrivers.map((value, index) => {
      const item = requireObject(value, `translations.en.drivers[${index}]`);
      return {
        title: readerText(item.title, `translations.en.drivers[${index}].title`, 140, 5),
        summary: readerText(item.summary, `translations.en.drivers[${index}].summary`, 500, 20),
        mechanism: readerText(
          item.mechanism,
          `translations.en.drivers[${index}].mechanism`,
          700,
          20,
        ),
      };
    }),
    aiChainUpdates: translatedAiUpdates.map((value, index) => {
      const item = requireObject(value, `translations.en.aiChainUpdates[${index}]`);
      return {
        title: readerText(item.title, `translations.en.aiChainUpdates[${index}].title`, 160, 5),
        summary: readerText(item.summary, `translations.en.aiChainUpdates[${index}].summary`, 600, 20),
        implication: readerText(
          item.implication,
          `translations.en.aiChainUpdates[${index}].implication`,
          700,
          20,
        ),
      };
    }),
  };
  for (const market of MARKETS) {
    const marketView = requireObject(
      marketViews[market],
      `translations.en.marketViews.${market}`,
    );
    const aiView = requireObject(
      aiChainViews[market],
      `translations.en.aiChainViews.${market}`,
    );
    result.marketViews[market] = {
      headline: readerText(
        marketView.headline,
        `translations.en.marketViews.${market}.headline`,
        160,
        5,
      ),
      summary: readerText(
        marketView.summary,
        `translations.en.marketViews.${market}.summary`,
        600,
        20,
      ),
    };
    result.aiChainViews[market] = {
      headline: readerText(
        aiView.headline,
        `translations.en.aiChainViews.${market}.headline`,
        160,
        5,
      ),
      summary: readerText(
        aiView.summary,
        `translations.en.aiChainViews.${market}.summary`,
        600,
        20,
      ),
    };

    const marketDriverEvidence = drivers
      .filter((item) => item.market === market)
      .flatMap((item) => item.evidence);
    const marketAiEvidence = aiUpdates
      .filter((item) => item.market === market)
      .flatMap((item) => item.evidence);
    assertNumbersBounded(
      `${marketGroundingText(input, market)} ${evidenceGroundingText(
        input,
        market,
        marketDriverEvidence,
      )}`,
      `${result.marketViews[market].headline} ${result.marketViews[market].summary}`,
      `translations.en.marketViews.${market}`,
    );
    assertNumbersBounded(
      `${aiGroundingText(input, market)} ${evidenceGroundingText(
        input,
        market,
        marketAiEvidence,
      )}`,
      `${result.aiChainViews[market].headline} ${result.aiChainViews[market].summary}`,
      `translations.en.aiChainViews.${market}`,
    );
  }

  for (const [index, item] of result.drivers.entries()) {
    const driver = drivers[index];
    assertNumbersBounded(
      `${marketGroundingText(input, driver.market)} ${evidenceGroundingText(
        input,
        driver.market,
        driver.evidence,
      )}`,
      `${item.title} ${item.summary} ${item.mechanism}`,
      `translations.en.drivers[${index}]`,
    );
  }
  for (const [index, item] of result.aiChainUpdates.entries()) {
    const update = aiUpdates[index];
    assertNumbersBounded(
      evidenceGroundingText(input, update.market, update.evidence),
      `${item.title} ${item.summary} ${item.implication}`,
      `translations.en.aiChainUpdates[${index}]`,
    );
  }
  assertNumbersBounded(
    `${inputGroundingText(input)} ${[...drivers, ...aiUpdates].flatMap((item) => item.evidence).map((item) => `${item.title} ${item.facts}`).join(" ")}`,
    `${result.headline} ${result.summary}`,
    "translations.en overview",
  );
  return { en: result };
}

function validateDriverSets(drivers, marketViews) {
  for (const market of MARKETS) {
    const rows = drivers.filter((driver) => driver.market === market);
    if (rows.length < 1 || rows.length > 3) {
      throw new Error(`${market} 必须包含一至三条驱动`);
    }
    if (rows.filter((driver) => driver.role === "primary").length !== 1) {
      throw new Error(`${market} 必须恰好包含一条主驱动`);
    }
    if (!rows.some((driver) => driver.basis === "structural")) {
      throw new Error(`${market} 缺少结构性盘面解释`);
    }
    const primary = rows.find((driver) => driver.role === "primary");
    const nonStructural = rows.some((driver) => driver.basis !== "structural");
    const status = marketViews[market].driverStatus;
    if (
      (status === "explained" && primary.basis === "structural") ||
      (status === "structural" && nonStructural) ||
      (status === "partial" && !nonStructural)
    ) {
      throw new Error(`${market} driverStatus 与证据类型不一致`);
    }
  }
}

export function validateReport(value, input) {
  const report = requireObject(value, "daily-report");
  if (report.contractVersion !== CONTRACT_VERSION) {
    throw new Error(`daily-report 必须使用 ${CONTRACT_VERSION}`);
  }
  const headline = readerText(report.headline, "headline", 100, 8);
  const summary = readerText(report.summary, "summary", 420, 30);
  const marketViews = validateViews(report.marketViews, "marketViews");
  const aiChainViews = validateViews(report.aiChainViews, "aiChainViews");
  if (!Array.isArray(report.drivers)) throw new Error("drivers 必须是数组");
  const drivers = report.drivers.map((item, index) =>
    validateDriver(item, input, index),
  );
  validateDriverSets(drivers, marketViews);
  if (!Array.isArray(report.aiChainUpdates) || report.aiChainUpdates.length > 8) {
    throw new Error("aiChainUpdates 最多八条");
  }
  const aiChainUpdates = report.aiChainUpdates.map((item, index) =>
    validateAiUpdate(item, input, index),
  );
  for (const market of MARKETS) {
    const rows = aiChainUpdates.filter((item) => item.market === market);
    if (
      rows.length > 4 ||
      new Set(rows.map((item) => item.layer)).size !== rows.length
    ) {
      throw new Error(`${market} AI 动态数量或环节重复`);
    }
    if (rows.length === 0 && aiChainViews[market].driverStatus !== "structural") {
      throw new Error(`${market} 无 AI 事件证据时必须使用结构性解释`);
    }
    if (rows.length > 0 && aiChainViews[market].driverStatus === "structural") {
      throw new Error(`${market} 有 AI 事件证据时不得标为纯结构性解释`);
    }
  }
  const researchAudit = validateResearchAudit(report.researchAudit);
  const translations = validateTranslation(
    report.translations,
    drivers,
    aiChainUpdates,
    input,
  );
  for (const market of MARKETS) {
    const marketDriverEvidence = drivers
      .filter((item) => item.market === market)
      .flatMap((item) => item.evidence);
    const marketAiEvidence = aiChainUpdates
      .filter((item) => item.market === market)
      .flatMap((item) => item.evidence);
    assertNumbersBounded(
      `${marketGroundingText(input, market)} ${evidenceGroundingText(
        input,
        market,
        marketDriverEvidence,
      )}`,
      `${marketViews[market].headline} ${marketViews[market].summary}`,
      `marketViews.${market}`,
    );
    assertNumbersBounded(
      `${aiGroundingText(input, market)} ${evidenceGroundingText(
        input,
        market,
        marketAiEvidence,
      )}`,
      `${aiChainViews[market].headline} ${aiChainViews[market].summary}`,
      `aiChainViews.${market}`,
    );
  }
  assertNumbersBounded(
    `${inputGroundingText(input)} ${drivers.flatMap((driver) => driver.evidence).map((item) => `${item.title} ${item.facts}`).join(" ")}`,
    `${headline} ${summary}`,
    "日报总览",
  );
  return {
    contractVersion: CONTRACT_VERSION,
    headline,
    summary,
    marketViews,
    aiChainViews,
    drivers,
    aiChainUpdates,
    translations,
    researchAudit,
  };
}

function stableId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function driverId(driver) {
  return stableId(
    [
      driver.market,
      driver.basis,
      driver.title,
      ...driver.evidence.map((item) => item.source),
    ].join("|"),
  );
}

function aiUpdateId(update) {
  return stableId(
    [
      update.market,
      update.layer,
      update.title,
      ...update.evidence.map((item) => item.source),
    ].join("|"),
  );
}

function sectorNames(input, drivers, market, direction, language = "zh") {
  const symbols = new Set(
    drivers
      .filter((driver) => driver.market === market && driver.direction === direction)
      .flatMap((driver) => driver.sectorSymbols),
  );
  return input.sectorPerformance
    .filter((sector) => sector.market === market && symbols.has(sector.symbol))
    .map((sector) => (language === "en" ? sector.nameEn : sector.name))
    .slice(0, 4);
}

function marketOverview(input, drivers, market, interpretation, language = "zh") {
  const primary = drivers.find(
    (driver) => driver.market === market && driver.role === "primary",
  );
  return {
    tone: primary?.direction ?? "mixed",
    interpretation,
    positive: sectorNames(input, drivers, market, "positive", language),
    negative: sectorNames(input, drivers, market, "negative", language),
  };
}

function storedEvidence(evidence) {
  const authority = {
    first_party: "first_party",
    publisher: "specialist",
    expert: "expert",
  }[evidence.sourceType];
  return {
    title: evidence.title,
    facts: evidence.facts,
    source: evidence.source,
    sourceLabel: evidence.sourceLabel,
    publishedAt: evidence.publishedAt,
    kind: evidence.kind,
    sourceType: evidence.sourceType,
    platform: evidence.platform,
    authority,
    ...(evidence.authorHandle ? { authorHandle: evidence.authorHandle } : {}),
  };
}

export function buildReportContent(input, report) {
  const marketAsOf = marketAsOfFromInput(input);
  const drivers = report.drivers.map((driver) => ({
    id: driverId(driver),
    market: driver.market,
    role: driver.role,
    basis: driver.basis,
    direction: driver.direction,
    title: driver.title,
    summary: driver.summary,
    mechanism: driver.mechanism,
    sectorSymbols: driver.sectorSymbols,
    evidence: driver.evidence.map(storedEvidence),
  }));
  const aiChainUpdates = report.aiChainUpdates.map((update) => ({
    id: aiUpdateId(update),
    market: update.market,
    layer: update.layer,
    title: update.title,
    summary: update.summary,
    implication: update.implication,
    evidence: update.evidence.map(storedEvidence),
  }));
  const marketViews = Object.fromEntries(
    MARKETS.map((market) => {
      const brief = input.marketBriefs[market];
      const driverIds = drivers
        .filter((driver) => driver.market === market)
        .map((driver) => driver.id);
      return [
        market,
        {
          ...report.marketViews[market],
          overview: marketOverview(
            input,
            report.drivers,
            market,
            report.marketViews[market].summary,
          ),
          leaderSectorSymbols: brief.sectorLeaders.map((item) => item.symbol),
          laggardSectorSymbols: brief.sectorLaggards.map((item) => item.symbol),
          driverIds,
        },
      ];
    }),
  );
  const aiChainViews = Object.fromEntries(
    MARKETS.map((market) => [
      market,
      {
        ...report.aiChainViews[market],
        leaderLayers: input.marketBriefs[market].aiLeaders.map((item) => item.layer),
        laggardLayers: input.marketBriefs[market].aiLaggards.map((item) => item.layer),
        driverIds: aiChainUpdates
          .filter((item) => item.market === market)
          .map((item) => item.id),
      },
    ]),
  );
  const overview = {
    tone: "mixed",
    interpretation: report.summary,
    positive: [
      ...new Set(
        MARKETS.flatMap((market) =>
          marketViews[market].overview.positive,
        ),
      ),
    ].slice(0, 6),
    negative: [
      ...new Set(
        MARKETS.flatMap((market) =>
          marketViews[market].overview.negative,
        ),
      ),
    ].slice(0, 6),
  };
  const en = report.translations.en;
  const translatedMarketViews = Object.fromEntries(
    MARKETS.map((market) => [
      market,
      {
        ...en.marketViews[market],
        overview: marketOverview(
          input,
          report.drivers,
          market,
          en.marketViews[market].summary,
          "en",
        ),
      },
    ]),
  );
  const translations = {
    en: {
      ...en,
      overview: {
        interpretation: en.summary,
        positive: [
          ...new Set(
            MARKETS.flatMap((market) =>
              translatedMarketViews[market].overview.positive,
            ),
          ),
        ].slice(0, 6),
        negative: [
          ...new Set(
            MARKETS.flatMap((market) =>
              translatedMarketViews[market].overview.negative,
            ),
          ),
        ].slice(0, 6),
      },
      marketViews: translatedMarketViews,
      stories: [],
    },
  };
  return JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    overview,
    marketViews,
    aiChainViews,
    updateKind: input.updateKind,
    marketAsOf,
    marketSessions: input.marketSessions,
    markets: input.markets.map(
      ({ asOf: _asOf, previousAsOf: _previousAsOf, ...market }) => market,
    ),
    sectorPerformance: input.sectorPerformance,
    aiChainPerformance: input.aiChainPerformance,
    sectorHeat: input.sectorHeat,
    drivers,
    aiChainUpdates,
    stories: [],
    translations,
    isSample: false,
  });
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function evidenceCount(report) {
  return new Set(
    [...report.drivers, ...report.aiChainUpdates].flatMap((item) =>
      item.evidence.map((evidence) => evidence.source),
    ),
  ).size;
}

function completedSql(input, report) {
  const finishedAt = new Date().toISOString();
  const marketAsOf = marketAsOfFromInput(input);
  const dataCut = `CN ${marketAsOf.CN} · US ${marketAsOf.US}`;
  const content = buildReportContent(input, report);
  const sourceCount = evidenceCount(report);
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
  ${sourceCount},
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
  0,
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
  const eventsPath = resolve(paths[2] ?? "work/daily-agent-events.jsonl");
  const input = validateInput(JSON.parse(await readFile(inputPath, "utf8")));
  const report = validateReport(
    JSON.parse(await readFile(reportPath, "utf8")),
    input,
  );
  const result = {
    status: checkOnly ? "valid" : "published",
    reportDate: input.reportDate,
    marketCount: input.markets.length,
    driverCount: report.drivers.length,
    aiUpdateCount: report.aiChainUpdates.length,
    evidenceCount: evidenceCount(report),
  };
  if (checkOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const eventsText = await readFile(eventsPath, "utf8");
  auditCodexRun(eventsText, report);
  await auditReportSources(report);

  try {
    const output = await executeSql(completedSql(input, report), { local });
    console.log(
      JSON.stringify(
        {
          ...result,
          database: local ? "stock-daily-db (local)" : "stock-daily-db",
          wrangler: output,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    try {
      await executeSql(failedSql(input, error), { local });
    } catch {
      // Preserve the publication failure as the primary error.
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
