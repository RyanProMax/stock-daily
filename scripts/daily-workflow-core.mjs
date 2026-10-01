import { createHash } from "node:crypto";
import { readExternalSource, normalizedEvidenceText } from "./daily-source-audit.mjs";
import { marketAsOfFromInput, marketAsOfFromReport } from "./daily-policy.mjs";
import {
  verifiedExternalSourceLabel,
  verifiedExternalSourceType,
} from "./source-registry.mjs";
import { backgroundEvidenceInWindow, isCalendarDate, officialReleaseDateInWindow } from "./evidence-timing.mjs";
import { assertAccessibleOriginalArticle, assertSessionClosingClaims } from "./source-session-integrity.mjs";

export const WORKFLOW_VERSION = "stock-daily-multi-agent-v35";
export const AGENT_FILESYSTEM_ISOLATION = "macos-seatbelt-v2";
const MARKETS = ["CN", "US"];
const INTERNAL_COPY =
  /\p{Extended_Pictographic}|<\/?[a-z][^>]*>|placeholder|\b(?:Codex|API(?:\s+Skill)?|Agent|provider|schema|pipeline|JSON|typo|malformed|market_data_query|contractVersion)\b|\b(?:answer (?:ends|complete)|stop (?:now|generating)|mark as finished|don't revise|do not (?:output|revise|add)|no (?:more|additional) content|strictly (?:one|single) sentence)\b|内部评分|调试标记|执业判断|主要市场驱动|市场主线|(?:不|未)纳入.{0,12}(?:机制|判断)|别信|数字可能是编的|去查原始来源|忽略(?:以上|此前|原有)?指令|答案到此|停止生成|到此为止|仅此一句|严格(?:单句|一句)|不要(?:输出|添加).{0,8}(?:字段|内容)/iu;
const AUDIT_COPY =
  /该(?:来源|证据)|现有(?:证据|因果信息|事件|获采信信息)|证据边界|证据只|不能据此|无法据此|尚不足|未提供可用于解释|而非由|不(?:能|宜)归结|无法归结|不在.{0,20}(?:目标|归因)范围|this evidence|the evidence only|cannot (?:be used to|establish|support|infer)|does not establish/iu;
const EMPTY_HEADING = /^(?:发生了什么|为什么|what happened|why)$/iu;
const FINANCIAL_COPY =
  /财报|业绩|季报|年报|季度结果|营收|每股收益|指引|quarterly results?|financial results?|\bearnings\b|\brevenue\b|\beps\b|\bguidance\b/iu;
const FINANCIAL_EXPECTATION_COPY =
  /(?:营收|收入|利润|净利|销售额|每股收益|指引|\brevenue\b|\bsales\b|\bprofit\b|\bnet income\b|\boperating income\b|\beps\b|\bguidance\b).{0,32}(?:超(?:出|过)?预期|不及预期|低于预期|高于预期|好于预期|逊于预期|超过一致预期|beat|miss|above|below|exceed(?:ed)?|short of).{0,24}(?:expect|consensus)?|(?:expectations?|consensus|预期|一致预期).{0,24}(?:beat|miss|above|below|exceed(?:ed)?|short of|超(?:出|过)?|不及|低于|高于|好于|逊于).{0,32}(?:营收|收入|利润|净利|销售额|每股收益|指引|\brevenue\b|\bsales\b|\bprofit\b|\bnet income\b|\boperating income\b|\beps\b|\bguidance\b)/iu;
const FINANCIAL_PRE_EVENT_COPY =
  /(?:财报|业绩|季报|年报|季度结果|营收|收入|利润|净利|每股收益|指引).{0,16}(?:发布|公布)?前|(?:发布|公布)(?:财报|业绩|季报|年报|季度结果)前|(?:ahead of|before|pending).{0,40}(?:earnings|results|revenue|sales|profit|net income|operating income|guidance)|(?:earnings|results|revenue|sales|profit|net income|operating income|guidance).{0,24}(?:ahead|pending)/iu;
const FINANCIAL_RESULT_DISCLOSURE_COPY =
  /(?<!未)(?:公布|披露|发布|报告|实现|录得|显示)(?!前).{0,40}(?:财报|业绩|季报|年报|季度结果|营收|收入|利润|净利|每股收益|指引)(?!(?:发布|公布)?前)|(?:财报|业绩|季报|年报|季度结果|营收|收入|利润|净利|每股收益|指引).{0,32}(?:为|达到|升至|降至|增长|下降|实现|录得)|\b(?:reported|posted|announced|disclosed|recorded|delivered)\b.{0,64}(?:quarterly results?|financial results?|earnings|revenue|sales|profit|net income|operating income|eps|guidance)|(?:quarterly results?|financial results?|\bearnings\b|\brevenue\b|\bsales\b|\bprofit\b|\bnet income\b|\boperating income\b|\beps\b|\bguidance\b).{0,40}\b(?:was|were|reached|totaled|rose|fell|grew|increased|decreased)\b/iu;

export function requiresFinancialComparisons(value) {
  const copy = String(value);
  // An explicit beat/miss remains a reported-result claim even when the same
  // sentence also discusses positioning ahead of a later event.  The
  // pre-event exemption is only for copy that contains no result comparison.
  return (
    FINANCIAL_EXPECTATION_COPY.test(copy) ||
    (FINANCIAL_COPY.test(copy) &&
      (!FINANCIAL_PRE_EVENT_COPY.test(copy) ||
        FINANCIAL_RESULT_DISCLOSURE_COPY.test(copy)))
  );
}

export function stableHash(value) {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

function text(value, label, min = 1, max = 2_000) {
  if (typeof value !== "string") throw new Error(`${label} 缺失`);
  const result = value
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const length = [...result].length;
  if (length < min || length > max) {
    throw new Error(`${label} 长度必须为 ${min}–${max}`);
  }
  return result;
}

export function readerText(value, label, min, max) {
  const result = text(value, label, min, max);
  if (/\uFFFD/u.test(result)) throw new Error(`${label} 包含乱码替代字符`);
  if (INTERNAL_COPY.test(result) || AUDIT_COPY.test(result)) {
    throw new Error(`${label} 暴露了内部流程或审核措辞`);
  }
  if (EMPTY_HEADING.test(result)) {
    throw new Error(`${label} 不能使用空洞栏目词`);
  }
  return result;
}

function stringArray(value, label, min = 0, max = 12) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} 数量必须为 ${min}–${max}`);
  }
  const result = value.map((item, index) =>
    text(item, `${label}[${index}]`, 1, 1_200),
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} 不得重复`);
  }
  return result;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} 无效`);
  return value;
}

function dateTime(value, label) {
  const result = text(value, label, 16, 40);
  if (
    !Number.isFinite(Date.parse(result)) ||
    !/(?:[zZ]|[+-]\d{2}:\d{2}|(?:UTC|GMT))$/iu.test(result)
  ) {
    throw new Error(`${label} 必须是带时区的时间`);
  }
  return new Date(result).toISOString();
}

function marketArrays(input, market) {
  return {
    markets: input.markets.filter((item) => item.region === market),
    sectorPerformance: input.sectorPerformance.filter(
      (item) => item.market === market,
    ),
    aiChainPerformance: input.aiChainPerformance.filter(
      (item) => item.market === market,
    ),
  };
}

function moveMagnitude(value) {
  const match = /[+-]?\d+(?:\.\d+)?/u.exec(String(value ?? ""));
  return match ? Math.abs(Number(match[0])) : 0;
}

function crossMarketLeads(input, market) {
  const otherMarket = market === "CN" ? "US" : "CN";
  const otherAsOf = marketAsOfFromInput(input)[otherMarket] ?? null;
  const aiLayers = input.aiChainPerformance
    .filter((item) => item.market === otherMarket)
    .sort((left, right) => moveMagnitude(right.change) - moveMagnitude(left.change))
    .slice(0, 3)
    .map((item) => ({
      market: otherMarket,
      marketAsOf: otherAsOf,
      symbol: item.symbol,
      layer: item.layer,
      name: item.name,
      nameEn: item.nameEn,
      change: item.change,
      direction: item.direction,
      representativeMoves: [...(item.constituents ?? [])]
        .sort(
          (left, right) =>
            moveMagnitude(right.change) - moveMagnitude(left.change),
        )
        .slice(0, 2)
        .map((constituent) => ({
          symbol: constituent.symbol,
          name: constituent.name,
          nameEn: constituent.nameEn,
          change: constituent.change,
          direction: constituent.direction,
        })),
    }));
  return { market: otherMarket, marketAsOf: otherAsOf, aiLayers };
}

function anomalyMetric(envelope, kind, target) {
  const values = {
    market: envelope.markets,
    sector: envelope.sectorPerformance,
    ai_layer: envelope.aiChainPerformance,
    // Reader-facing company cards are bound to a V11 sector symbol during
    // publication.  AI-only constituents remain usable as leads for an
    // ai_layer anomaly, but are not representable as standalone company cards.
    company: envelope.sectorPerformance.flatMap(
      (item) => item.constituents ?? [],
    ),
  }[kind];
  const normalizedTarget = String(target).trim().toLocaleLowerCase();
  const exactSymbols = values?.filter(
    (item) =>
      String(item.symbol).trim().toLocaleLowerCase() === normalizedTarget,
  );
  if (exactSymbols?.length) return exactSymbols[0];
  const aliases = values?.filter((item) =>
    [item.layer, item.name, item.nameEn]
      .filter(Boolean)
      .some(
        (value) => String(value).trim().toLocaleLowerCase() === normalizedTarget,
      ),
  );
  if (!aliases || new Set(aliases.map((item) => item.symbol)).size !== 1) {
    return null;
  }
  return aliases[0];
}

function broadMetricImportance(metric) {
  const magnitude = moveMagnitude(metric.change);
  return /\bbp\b|基点/iu.test(String(metric.change ?? ""))
    ? magnitude / 8
    : magnitude;
}

function requiredBroadMetric(envelope) {
  return [...envelope.markets].sort(
    (left, right) => broadMetricImportance(right) - broadMetricImportance(left),
  )[0];
}

function requiredCrossMarketMetric(envelope) {
  const materialLead = eligibleCrossMarketLeads(envelope)
    .filter(
      (lead) =>
        moveMagnitude(lead.change) >= 5 ||
        lead.representativeMoves.some(
          (representative) => moveMagnitude(representative.change) >= 10,
        ),
    )
    .sort((left, right) => {
      const maximum = (lead) =>
        Math.max(
          moveMagnitude(lead.change),
          ...lead.representativeMoves.map((item) => moveMagnitude(item.change)),
        );
      return maximum(right) - maximum(left);
    })[0];
  if (!materialLead) return null;
  return envelope.aiChainPerformance.find(
    (metric) => metric.layer === materialLead.layer,
  ) ?? null;
}

function queryMentionsDate(query, asOf) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf ?? "")) return false;
  const [year, month, day] = asOf.split("-").map(Number);
  const numericDate = new RegExp(`(?:^|[^0-9])${year}(?:年|[-/])0?${month}(?:月|[-/])0?${day}(?:日|(?=$|[^0-9]))`, "u");
  const months = ["Jan(?:uary)?", "Feb(?:ruary)?", "Mar(?:ch)?", "Apr(?:il)?", "May", "Jun(?:e)?", "Jul(?:y)?", "Aug(?:ust)?", "Sep(?:t(?:ember)?)?", "Oct(?:ober)?", "Nov(?:ember)?", "Dec(?:ember)?"];
  const englishDate = new RegExp(`\\b(?:${months[month - 1]}\\.?\\s+0?${day}(?:st|nd|rd|th)?[,\\s]+${year}|0?${day}\\s+${months[month - 1]}\\.?[,\\s]+${year})\\b`, "iu");
  return numericDate.test(query) || englishDate.test(query);
}

function assertPlanQueries(queries, envelope, anomaly, metric, label, namedCompanyMarket = false) {
  const marketPattern =
    envelope.market === "CN"
      ? /\bCN\b|A股|中国|上证|深证|沪深|创业板|科创/iu
      : /\b(?:US|U\.S\.|American|S&P|Nasdaq|NYSE|Wall Street|Dow Jones|Treasury)\b/iu;
  const targetTokens = [
    metric.symbol,
    metric.layer,
    metric.name,
    metric.nameEn,
    ...deterministicTargetAliases(envelope, metric.symbol).map((alias) => alias.value),
    ...(metric.constituents ?? []).flatMap((item) => [
      item.symbol,
      item.name,
      item.nameEn,
    ]),
  ]
    .filter((value) => typeof value === "string" && value.trim().length >= 2)
    .map((value) => value.trim().toLocaleLowerCase());
  for (const query of queries) {
    if (query.length > 220) {
      throw new Error(`${anomaly.id}.${label} 必须是最多 220 字符的单条搜索语句`);
    }
    const normalized = query.toLocaleLowerCase();
    const compact = normalizedEvidenceText(query);
    if (
      !queryMentionsDate(query, envelope.marketAsOf) ||
      (!marketPattern.test(query) && !namedCompanyMarket) ||
      !targetTokens.some(
        (token) =>
          normalized.includes(token) ||
          compact.includes(normalizedEvidenceText(token)),
      )
    ) {
      throw new Error(
        `${anomaly.id}.${label} 必须包含交易日、市场标记及异动目标代码、名称或确定性代表成分`,
      );
    }
  }
}

export function marketEnvelope(input, market) {
  enumValue(market, MARKETS, "market");
  const asOf = marketAsOfFromInput(input)[market];
  if (!asOf) throw new Error(`${market} 缺少一致的行情日期`);
  const arrays = marketArrays(input, market);
  return {
    workflowVersion: WORKFLOW_VERSION,
    market,
    marketAsOf: asOf,
    reportDate: input.reportDate,
    cutoffAt: input.cutoffAt,
    session: input.marketSessions.find((item) => item.market === market),
    marketBrief: input.marketBriefs[market],
    crossMarketLeads: crossMarketLeads(input, market),
    ...arrays,
  };
}

export function marketInputHash(input, market) {
  return stableHash(marketEnvelope(input, market));
}

export function eligibleCrossMarketLeads(envelope) {
  const lead = envelope.crossMarketLeads;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(lead?.marketAsOf ?? "")) return [];
  // China closes before the US on the same calendar date. A US close can
  // inform the following China session, never China's already-finished one.
  const available = envelope.market === "CN"
    ? lead.marketAsOf < envelope.marketAsOf
    : lead.marketAsOf <= envelope.marketAsOf;
  return available ? lead.aiLayers : [];
}

export function researchMarketEnvelope(input, market) {
  const envelope = marketEnvelope(input, market);
  // Preserve the immutable collection hash for publication/recovery, while
  // excluding later sessions from every research-stage payload and artifact.
  return {
    ...envelope,
    crossMarketLeads: {
      ...envelope.crossMarketLeads,
      aiLayers: eligibleCrossMarketLeads(envelope),
    },
  };
}

export function advancedMarkets(input, previousReport, forcedMarket = null) {
  if (forcedMarket) {
    enumValue(forcedMarket, MARKETS, "forced market");
    return [forcedMarket];
  }
  const current = marketAsOfFromInput(input);
  const previous = previousReport ? marketAsOfFromReport(previousReport) : {};
  return MARKETS.filter(
    (market) => current[market] && current[market] > (previous[market] ?? ""),
  );
}

export function validatePlan(value, envelope) {
  const plan = object(value, "plan");
  if (
    plan.contractVersion !== "stock-daily-market-plan-v1" ||
    plan.market !== envelope.market ||
    plan.marketAsOf !== envelope.marketAsOf
  ) {
    throw new Error("研究计划与市场输入不一致");
  }
  if (!Array.isArray(plan.anomalies) || plan.anomalies.length !== 3) {
    throw new Error("研究计划必须包含两个首选异动和一个备用异动");
  }
  const seen = new Set();
  const seenTargets = new Set();
  const anomalies = plan.anomalies.map((raw, index) => {
    const anomaly = object(raw, `anomalies[${index}]`);
    const id = text(anomaly.id, `anomalies[${index}].id`, 3, 40);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/u.test(id)) {
      throw new Error(
        `anomalies[${index}].id 只能包含字母、数字、下划线和连字符`,
      );
    }
    if (seen.has(id)) throw new Error("异动 id 不得重复");
    seen.add(id);
    if (!Array.isArray(anomaly.hypotheses) || anomaly.hypotheses.length < 3 || anomaly.hypotheses.length > 4) {
      throw new Error(`${id} 必须包含三至四个相互竞争的假设`);
    }
    const kind = enumValue(
      anomaly.kind,
      ["market", "sector", "ai_layer", "company"],
      `${id}.kind`,
    );
    const declaredTarget = text(anomaly.target, `${id}.target`, 1, 80);
    const metric = anomalyMetric(envelope, kind, declaredTarget);
    if (!metric) throw new Error(`${id}.target 不在确定性市场输入中`);
    const target = metric.symbol;
    if (seenTargets.has(target)) {
      throw new Error(`研究计划不得重复选择同一异动目标 ${target}`);
    }
    seenTargets.add(target);
    const direction = enumValue(
      anomaly.direction,
      ["positive", "negative", "mixed"],
      `${id}.direction`,
    );
    const expectedDirection =
      metric.direction === "up"
        ? "positive"
        : metric.direction === "down"
          ? "negative"
          : "mixed";
    if (direction !== expectedDirection) {
      throw new Error(`${id}.direction 与确定性行情方向不一致`);
    }
    const observedMove = text(
      anomaly.observedMove,
      `${id}.observedMove`,
      2,
      160,
    );
    if (metric.change && !observedMove.includes(metric.change)) {
      throw new Error(`${id}.observedMove 未准确复制确定性涨跌幅`);
    }
    const hypothesisIds = new Set();
    const hypotheses = anomaly.hypotheses.map(
      (rawHypothesis, hypothesisIndex) => {
        const hypothesis = object(
          rawHypothesis,
          `${id}.hypotheses[${hypothesisIndex}]`,
        );
        const hypothesisId = text(
          hypothesis.id,
          `${id}.hypotheses.id`,
          3,
          50,
        );
        if (hypothesisIds.has(hypothesisId)) {
          throw new Error(`${id}.hypotheses.id 不得重复`);
        }
        hypothesisIds.add(hypothesisId);
        return {
          id: hypothesisId,
          claim: text(hypothesis.claim, `${id}.hypotheses.claim`, 8, 260),
          category: enumValue(
            hypothesis.category,
            ["company_event", "macro_policy", "industry_supply_demand", "positioning", "alternative"],
            `${id}.hypotheses.category`,
          ),
        };
      },
    );
    const factQueries = stringArray(
      anomaly.factQueries,
      `${id}.factQueries`,
      1,
      1,
    );
    const causalQueries = stringArray(
      anomaly.causalQueries,
      `${id}.causalQueries`,
      1,
      1,
    );
    assertPlanQueries(
      factQueries,
      envelope,
      { id, target },
      metric,
      "factQueries",
    );
    assertPlanQueries(
      causalQueries,
      envelope,
      { id, target },
      metric,
      "causalQueries",
    );
    return {
      id,
      kind,
      target,
      title: text(anomaly.title, `${id}.title`, 5, 120),
      direction,
      observedMove,
      researchQuestion: text(
        anomaly.researchQuestion,
        `${id}.researchQuestion`,
        10,
        300,
      ),
      hypotheses,
      factQueries,
      causalQueries,
    };
  });
  const broadMetric = requiredBroadMetric(envelope);
  if (
    broadMetric &&
    !anomalies.slice(0, 2).some(
      (anomaly) =>
        anomaly.kind === "market" && anomaly.target === broadMetric.symbol,
    )
  ) {
    throw new Error(
      `两个首选异动必须包含最重要的大盘指标 ${broadMetric.symbol} ${broadMetric.change}`,
    );
  }
  const crossMarketMetric = requiredCrossMarketMetric(envelope);
  if (
    crossMarketMetric &&
    !anomalies.slice(0, 2).some(
      (anomaly) =>
        anomaly.kind === "ai_layer" &&
        anomaly.target === crossMarketMetric.symbol,
    )
  ) {
    throw new Error(
      `两个首选异动必须覆盖重大跨市场映射 ${crossMarketMetric.symbol} ${crossMarketMetric.change}`,
    );
  }
  return {
    contractVersion: plan.contractVersion,
    market: plan.market,
    marketAsOf: plan.marketAsOf,
    anomalies,
  };
}

export function parseAgentEvents(eventsText, { requireSearch = false } = {}) {
  const events = [];
  for (const line of String(eventsText).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error("Agent 事件流包含无法解析的记录");
    }
  }
  if (events.some((event) => event.type === "turn.failed" || event.type === "error")) {
    throw new Error("Agent 运行包含失败事件");
  }
  if (!events.some((event) => event.type === "turn.completed")) {
    throw new Error("Agent 运行没有完成事件");
  }
  const queries = events
    .filter(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "web_search" &&
        event.item?.action?.type === "search",
    )
    .flatMap((event) => {
      const action = event.item?.action;
      if (Array.isArray(action?.queries)) return action.queries;
      return [action?.query];
    })
    .filter((query) => typeof query === "string" && query.trim())
    .map((query) => query.trim());
  if (requireSearch && queries.length === 0) {
    throw new Error("研究 Agent 未执行网页搜索");
  }
  return {
    eventCount: events.length,
    queries: [...new Set(queries)],
    searchCount: queries.length,
  };
}

const COMPARISON_NUMBER_SOURCE = "[+-]?\\d[\\d,]*(?:\\.\\d+)?";

function matchedComparisonValues(
  display,
  pattern,
  convert = (value) => value,
) {
  return [...String(display).matchAll(pattern)].map((match) =>
    convert(Number(match[1].replaceAll(",", ""))),
  );
}

function unitBoundComparisonValues(value, unit) {
  const display = String(value);
  const numberSource = COMPARISON_NUMBER_SOURCE;
  switch (unit) {
    case "billion_usd":
      return [
        ...matchedComparisonValues(
          display,
          new RegExp(`\\$\\s*(${numberSource})\\s*B\\b`, "giu"),
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(
            `(${numberSource})\\s*billion(?:\\s+(?:US\\s+)?dollars?)?\\b`,
            "giu",
          ),
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(`(${numberSource})\\s*亿美元`, "gu"),
          (shown) => shown / 10,
        ),
      ];
    case "million_usd":
      return [
        ...matchedComparisonValues(
          display,
          new RegExp(`\\$\\s*(${numberSource})\\s*M\\b`, "giu"),
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(
            `(${numberSource})\\s*million(?:\\s+(?:US\\s+)?dollars?)?\\b`,
            "giu",
          ),
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(`(${numberSource})\\s*万美元`, "gu"),
          (shown) => shown / 100,
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(`(${numberSource})\\s*亿美元`, "gu"),
          (shown) => shown * 100,
        ),
      ];
    case "usd":
      return [
        ...matchedComparisonValues(
          display,
          new RegExp(
            `\\$\\s*(${numberSource})(?![\\d,.])(?!\\s*(?:[BMK]\\b|billion\\b|million\\b|thousand\\b))`,
            "giu",
          ),
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(`(${numberSource})\\s*美元`, "gu"),
        ),
      ];
    case "hundred_million_cny":
      return matchedComparisonValues(
        display,
        new RegExp(`(${numberSource})\\s*(?:亿元|亿人民币)`, "gu"),
      );
    case "million_cny":
      return [
        ...matchedComparisonValues(
          display,
          new RegExp(`(${numberSource})\\s*百万元`, "gu"),
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(
            `(${numberSource})\\s*million\\s+(?:yuan|rmb)\\b`,
            "giu",
          ),
        ),
      ];
    case "cny":
      return [
        ...matchedComparisonValues(
          display,
          new RegExp(
            `(?:人民币|\\b(?:CNY|RMB)\\b)\\s*(${numberSource})`,
            "giu",
          ),
        ),
        ...matchedComparisonValues(
          display,
          new RegExp(
            `(${numberSource})\\s*(?:人民币|元|\\b(?:CNY|RMB)\\b)`,
            "giu",
          ),
        ),
      ];
    case "percent":
      return matchedComparisonValues(
        display,
        new RegExp(`(${numberSource})\\s*-?(?:%|％|percent\\b)`, "giu"),
      );
    case "basis_points":
      return matchedComparisonValues(
        display,
        new RegExp(
          `(${numberSource})\\s*-?(?:bps?\\b|basis[ -]points?\\b|基点)`,
          "giu",
        ),
      );
    case "count":
    case "other":
      return [
        ...display.matchAll(new RegExp(`(${numberSource})`, "gu")),
      ].map((match) => Number(match[1].replaceAll(",", "")));
    default:
      return [];
  }
}

export function hasUnitBoundComparisonValue(value, unit, expected) {
  return unitBoundComparisonValues(value, unit).some(
    (candidate) => Math.abs(candidate - expected) < 1e-9,
  );
}

function validateComparison(raw, label, sourceUrl) {
  const comparison = object(raw, label);
  const actualValue = Number(comparison.actualValue);
  const baselineValue = Number(comparison.baselineValue);
  if (!Number.isFinite(actualValue) || !Number.isFinite(baselineValue)) {
    throw new Error(`${label} 的实际值和基准值必须是数值`);
  }
  if (comparison.sourceUrl !== sourceUrl) {
    throw new Error(`${label}.sourceUrl 必须对应当前来源`);
  }
  const unit = enumValue(
    comparison.unit,
    [
      "billion_usd",
      "million_usd",
      "usd",
      "hundred_million_cny",
      "million_cny",
      "cny",
      "percent",
      "basis_points",
      "count",
      "other",
    ],
    `${label}.unit`,
  );
  function assertDisplayUnit(value, displayLabel) {
    const display = String(value);
    const compactDollar = /\$\s*-?\d[\d,]*(?:\.\d+)?\s*([BM])\b/iu.exec(
      display,
    )?.[1]?.toUpperCase();
    const scaledCny =
      /亿元|亿人民币|百万元|万元|\b(?:billion|million|thousand)\s+(?:yuan|rmb)\b/iu.test(
        display,
      );
    if (
      (unit === "billion_usd" && compactDollar === "M") ||
      (unit === "million_usd" && compactDollar === "B") ||
      (unit === "cny" && scaledCny) ||
      (unit === "usd" &&
        (compactDollar ||
          /(?:\$|\b(?:USD|US dollars?)\b).{0,24}\b(?:billion|million|thousand)\b|\$\s*-?\d[\d,]*(?:\.\d+)?\s*[BMK]\b/iu.test(
            display,
          )))
    ) {
      throw new Error(`${displayLabel} 金额后缀与类型化单位不一致`);
    }
    const unitMatches = {
      billion_usd:
        compactDollar === "B" || /\bbillion\b|亿美元/iu.test(display),
      million_usd:
        compactDollar === "M" || /\bmillion\b|万美元|亿美元/iu.test(display),
      usd:
        !compactDollar && /\$|美元/iu.test(display),
      hundred_million_cny:
        /亿元|亿人民币|hundred million (?:yuan|rmb)/iu.test(display),
      million_cny: /百万元|million (?:yuan|rmb)/iu.test(display),
      cny: /(?:人民币|元|\b(?:cny|rmb)\b)/iu.test(display),
      percent: /%|％|\bpercent\b/iu.test(display),
      basis_points: /\bbps?\b|basis[ -]points?|基点/iu.test(display),
      count: true,
      other: true,
    }[unit];
    if (!unitMatches) {
      throw new Error(`${displayLabel} 缺少与类型化数值一致的单位`);
    }
  }
  assertDisplayUnit(comparison.actualDisplay, `${label}.actualDisplay`);
  assertDisplayUnit(comparison.baselineDisplay, `${label}.baselineDisplay`);
  function displayContains(value, expected) {
    const candidates = [
      ...new Set(
        unitBoundComparisonValues(value, unit).map((candidate) =>
          String(candidate),
        ),
      ),
    ].map(Number);
    return (
      candidates.length === 1 &&
      Math.abs(candidates[0] - expected) < 1e-9
    );
  }
  if (
    !displayContains(comparison.actualDisplay, actualValue) ||
    !displayContains(comparison.baselineDisplay, baselineValue)
  ) {
    throw new Error(`${label} 的显示值与类型化数值不一致`);
  }
  return {
    label: text(comparison.label, `${label}.label`, 2, 40),
    actualValue,
    actualDisplay: text(
      comparison.actualDisplay,
      `${label}.actualDisplay`,
      1,
      40,
    ),
    baselineLabel: text(
      comparison.baselineLabel,
      `${label}.baselineLabel`,
      2,
      24,
    ),
    baselineValue,
    baselineDisplay: text(
      comparison.baselineDisplay,
      `${label}.baselineDisplay`,
      1,
      40,
    ),
    unit,
    higherIsPositive: comparison.higherIsPositive === true,
    note:
      typeof comparison.note === "string" && comparison.note.trim()
        ? readerText(comparison.note, `${label}.note`, 1, 180)
        : "",
    sourceUrl,
  };
}

export function validateResearchOutput(value, role, anomaly, envelope, { targetedRepair = false } = {}) {
  const result = object(value, `${role} research`);
  if (
    result.contractVersion !== "stock-daily-evidence-worker-v1" ||
    result.role !== role ||
    result.market !== envelope.market ||
    result.anomalyId !== anomaly.id
  ) {
    throw new Error(`${role} 研究结果与任务不一致`);
  }
  const queries = stringArray(result.queries, `${role}.queries`, 2, 2);
  const metric = anomalyMetric(envelope, anomaly.kind, anomaly.target);
  if (!metric) throw new Error(`${role} 研究目标不在确定性市场输入中`);
  const knownCompanies = [
    ...(anomaly.kind === "company" ? [metric] : []),
    ...(metric.constituents ?? []),
    ...eligibleCrossMarketLeads(envelope)
      .filter((lead) => metric.layer && lead.layer === metric.layer)
      .flatMap((lead) => lead.representativeMoves),
  ];
  const companyNames = knownCompanies.flatMap((item) => [item.name, item.nameEn]).filter((name) => typeof name === "string" && name.length >= 3);
  const companyTickers = envelope.market === "US" ? knownCompanies.map(item => item.symbol).filter(symbol => typeof symbol === "string" && /^[A-Z]{1,6}(?:[.-][A-Z])?$/u.test(symbol)) : [];
  const namesCompany = (query) => companyNames.some((name) => query.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
  if (!targetedRepair) assertPlanQueries(
    queries.slice(0, 1),
    envelope,
    anomaly,
    metric,
    `${role}.queries`,
    namesCompany(queries[0]),
  );
  for (const queryIndex of targetedRepair ? [0, 1] : [1]) {
    const query = queries[queryIndex];
    const namesKnownCompany = namesCompany(query) || companyTickers.some(symbol => new RegExp(`\\b${symbol.replaceAll(".", "\\.")}\\b`, "u").test(query));
    // A verified US sector ETF is itself an explicit market identifier.
    // Custom AI basket/series codes must still retain a market name.
    const namesUsSectorEtf = envelope.market === "US" && anomaly.kind === "sector" && /^XL(?:[A-Z]|RE)$/u.test(anomaly.target) && new RegExp(`\\b${anomaly.target}\\b`, "iu").test(query);
    if (
      !/(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|20\d{2}年\d{1,2}月\d{1,2}日|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?[,\s]+20\d{2})/iu.test(query) ||
      (!/\b(?:CN|US|U\.S\.|Wall Street|Dow Jones|DJI|SPX|IXIC|Nasdaq|S&P|Treasury)\b|A股|中国|美股|上证|沪深|科创|创业板/iu.test(query) && !namesKnownCompany && !namesUsSectorEtf)
    ) {
      throw new Error(
        `${role}.queries[${queryIndex}] 必须保留明确的交易日和所研究市场或跨市场标记`,
      );
    }
  }
  if (!Array.isArray(result.sources) || result.sources.length > 5) {
    throw new Error(`${role}.sources 最多五项`);
  }
  const rejectedSources = [];
  const sources = result.sources.flatMap((raw, index) => {
    try {
      const source = object(raw, `${role}.sources[${index}]`);
      const url = text(
        source.url,
        `${role}.sources[${index}].url`,
        12,
        1_200,
      );
      try {
        if (new URL(url).protocol !== "https:") throw new Error();
      } catch {
        throw new Error(`${role}.sources[${index}].url 必须是 HTTPS URL`);
      }
      const rawComparisons = Array.isArray(source.comparisons)
        ? source.comparisons
        : [];
      if (role === "causal" && rawComparisons.length > 0) {
        throw new Error(
          "causal 研究不得产出财务对比；财务数字只能来自独立 facts 研究",
        );
      }
      const comparisons = rawComparisons.flatMap((item, comparisonIndex) => {
        try {
          return [
            validateComparison(
              item,
              `${role}.sources[${index}].comparisons[${comparisonIndex}]`,
              url,
            ),
          ];
        } catch (error) {
          rejectedSources.push({
            anomalyId: anomaly.id,
            role,
            url,
            reason: `comparison[${comparisonIndex}]: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return [];
        }
      });
      const candidate = {
        originalUrl: url,
        sourceLabel: text(source.sourceLabel, `${role}.sourceLabel`, 2, 80),
        title: text(source.title, `${role}.title`, 4, 220),
        publishedAt: isCalendarDate(source.publishedAt) && role === "facts" && ["official", "background"].includes(source.kind) && verifiedExternalSourceType(url) === "first_party"
          ? source.publishedAt : dateTime(source.publishedAt, `${role}.publishedAt`),
        kind: enumValue(
          source.kind,
          ["official", "event", "market_wrap", ...(anomaly.researchPurpose === "comprehensive_recap" ? ["background"] : [])],
          `${role}.kind`,
        ),
        supportingExcerpt: text(
          source.supportingExcerpt,
          `${role}.supportingExcerpt`,
          24,
          700,
        ),
        facts: text(source.facts, `${role}.facts`, 20, 1_600),
        scope: enumValue(
          source.scope,
          [
            "market",
            "sector",
            "subsector",
            "ai_layer",
            "company",
            "event_only",
          ],
          `${role}.scope`,
        ),
        targets: stringArray(source.targets, `${role}.targets`, 1, 4),
        hypothesisIds: stringArray(
          source.hypothesisIds,
          `${role}.hypothesisIds`,
          1,
          4,
        ),
        causalConnection: source.causalConnection === true,
        comparisons,
        role,
        anomalyId: anomaly.id,
      };
      if (candidate.kind === "background" && (role !== "facts" || verifiedExternalSourceType(url) !== "first_party" || comparisons.length)) throw new Error("背景机制只能来自一手披露，不能产出本期财务对比或价格因果结论");
      if (
        (role === "causal" && !candidate.causalConnection) ||
        (role === "facts" && candidate.causalConnection)
      ) {
        throw new Error(
          `${role} 研究来源的 causalConnection 与职责不一致`,
        );
      }
      if (
        role === "causal" &&
        !["event", "market_wrap"].includes(candidate.kind)
      ) {
        throw new Error(`${role} 研究来源类型与职责不一致`);
      }
      const hypothesisIds = new Set(
        anomaly.hypotheses.map((item) => item.id),
      );
      if (candidate.hypothesisIds.some((id) => !hypothesisIds.has(id))) {
        throw new Error(`${role} 研究引用了计划外假设`);
      }
      if (
        candidate.targets.length !== 1 ||
        candidate.targets[0] !== anomaly.target
      ) {
        throw new Error(
          `${role} 研究来源必须精确绑定计划中的确定性异动目标`,
        );
      }
      return [candidate];
    } catch (error) {
      rejectedSources.push({
        anomalyId: anomaly.id,
        role,
        url:
          raw && typeof raw === "object" && typeof raw.url === "string"
            ? raw.url
            : "",
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
  const declaredOutcome = enumValue(
    result.outcome,
    ["found", "limited", "none"],
    `${role}.outcome`,
  );
  if (
    (declaredOutcome === "found" &&
      sources.length === 0 &&
      rejectedSources.length === 0) ||
    (declaredOutcome === "none" && sources.length > 0)
  ) {
    throw new Error(`${role}.outcome 与来源数量不一致`);
  }
  const outcome =
    declaredOutcome === "found" && sources.length === 0
      ? "limited"
      : declaredOutcome;
  const rawAlternatives = Array.isArray(result.alternatives)
    ? result.alternatives
    : [];
  if (role === "causal" && rawAlternatives.length === 0) {
    throw new Error("causal 研究必须记录至少一个已检查的竞争解释");
  }
  return {
    contractVersion: result.contractVersion,
    role,
    market: result.market,
    anomalyId: result.anomalyId,
    outcome,
    queries,
    sources,
    rejectedSources,
    alternatives: rawAlternatives.length > 0
      ? rawAlternatives.map((raw, index) => {
          const alternative = object(raw, `${role}.alternatives[${index}]`);
          return {
            claim: text(alternative.claim, `${role}.alternatives.claim`, 5, 300),
            status: enumValue(
              alternative.status,
              ["supported", "contradicted", "unresolved"],
              `${role}.alternatives.status`,
            ),
            sourceUrls: stringArray(
              alternative.sourceUrls,
              `${role}.alternatives.sourceUrls`,
              0,
              4,
            ),
          };
        })
      : [],
  };
}

function sourceTimeInEvidenceWindow(source, envelope, value) {
  if (source.kind === "background") return backgroundEvidenceInWindow(value, envelope);
  const published = Date.parse(value);
  const start = Date.parse(envelope.session.windowStart);
  const close = Date.parse(envelope.session.windowEnd);
  const deadline = Date.parse(envelope.session.wrapDeadline);
  const factsStart = start - 72 * 60 * 60 * 1_000;
  const marketWrapDeadline = Math.max(
    deadline,
    close + 8 * 60 * 60 * 1_000,
  );
  return (
    source.role === "facts"
      ? published > factsStart &&
        (published <= close ||
          (source.kind === "market_wrap" && published <= marketWrapDeadline))
      : published > start &&
        (published <= close ||
          (source.kind === "market_wrap" && published <= marketWrapDeadline))
  );
}

function verifiedSourceTime(source, envelope, candidates, dateCandidates = [], sourceType) {
  if (isCalendarDate(source.publishedAt)) {
    if (source.role !== "facts" || !["official", "background"].includes(source.kind) || sourceType !== "first_party" || !dateCandidates.includes(source.publishedAt)) throw new Error(`${source.originalUrl} 日期级正式发布与一手原文不一致`);
    if (!(source.kind === "background" ? backgroundEvidenceInWindow(source.publishedAt, envelope) : officialReleaseDateInWindow(source.publishedAt, envelope))) throw new Error(`${source.originalUrl} 正式发布日期不在交易窗口内或背景已过期`);
    return source.publishedAt;
  }
  if (candidates.length === 0) {
    throw new Error(`${source.originalUrl} 未找到文章级发布时间`);
  }
  const allowed = candidates.filter((value) =>
    sourceTimeInEvidenceWindow(source, envelope, value),
  );
  if (allowed.length === 0) {
    throw new Error(`${source.originalUrl} 不在 ${envelope.market} 交易窗口内`);
  }
  return [...allowed].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  )[0];
}

const FACT_NUMBER_MENTION =
  /(?<outerSign>[+-]?)(?:(?<prefix>US\$|\$|USD|US dollars?|¥|CNY|RMB|人民币)\s*)?(?<number>[+-]?\d[\d,]*(?:\.\d+)?)\s*(?<suffix>percentage points?|ppts?\b|pp\b|-?percent|-?basis[ -]points?|bps?|billion(?:\s+(?:US\s+)?dollars?)?|million(?:\s+(?:US\s+)?dollars?)?|thousand(?:\s+(?:US\s+)?dollars?)?|[BMK](?![a-z])|US dollars?\b|USD\b|%|％|个百分点|百分点|个基点|基点|亿美元|万美元|美元|亿元|亿人民币|百万元|万元|人民币|元)?/giu;
const POSITIVE_DIRECTION =
  /上涨|上升|上行|增长|增加|提高|升至|高于|超过|超出|好于|改善|扩大|\b(?:rose|risen|rise|rising|grew|grown|growth|increased?|gained?|jumped?|climbed?|higher|above|exceed(?:ed|s|ing)?|improved?|expanded?|hikes?|hiked|raises?|raised|up)\b/giu;
const NEGATIVE_DIRECTION =
  /下跌|下降|下行|减少|降低|降至|低于|不及|逊于|恶化|收窄|\b(?:fell|fallen|falling|declines?|declined|decreases?|decreased|dips?|dipped|drops?|dropped|dropping|slid|slides?|slips?|slipped|sank|sunk|retreat(?:ed|s|ing)?|lower|below|missed?|weakened?|contracted?|cuts?|reduces?|reduced|down)\b/giu;

function numberMentionUnit(prefix = "", suffix = "") {
  const currency = prefix.toLocaleLowerCase();
  const scale = suffix.toLocaleLowerCase().replace(/^-/, "");
  if (/percentage points?|^ppts?$|^pp$|百分点/iu.test(scale)) return "percentage_points";
  if (/-?basis[ -]points?|bps?|基点/iu.test(scale)) return "basis_points";
  if (/^(?:%|％|percent)$/iu.test(scale)) return "percent";
  if (/亿美元/u.test(scale)) return "hundred_million_usd";
  if (/万美元/u.test(scale)) return "ten_thousand_usd";
  if (/亿元|亿人民币/u.test(scale)) return "hundred_million_cny";
  if (/百万元/u.test(scale)) return "million_cny";
  if (/万元/u.test(scale)) return "ten_thousand_cny";
  const isUsd = /^(?:us\$|\$|usd|us dollars?)$/iu.test(currency) || /美元|\b(?:US dollars?|USD)\b/iu.test(scale);
  const isCny = /^(?:¥|cny|rmb|人民币)$/iu.test(currency) || /人民币|元/u.test(scale);
  if (/^(?:b|billion(?:\s+(?:us\s+)?dollars?)?)$/iu.test(scale)) {
    return isUsd ? "billion_usd" : "billion";
  }
  if (/^(?:m|million(?:\s+(?:us\s+)?dollars?)?)$/iu.test(scale)) {
    return isUsd ? "million_usd" : "million";
  }
  if (/^(?:k|thousand(?:\s+(?:us\s+)?dollars?)?)$/iu.test(scale)) {
    return isUsd ? "thousand_usd" : "thousand";
  }
  if (isUsd) return "usd";
  if (isCny) return "cny";
  return "number";
}

function nearestDirection(value, start, end, rawNumber) {
  // A calendar component is not a market movement. A bound on a count (e.g.
  // “超过3600只个股下跌”) must not override the actual movement verb.
  if (/^[年月日]/u.test(value.slice(end))) return null;
  if (rawNumber.startsWith("+")) return "positive";
  if (rawNumber.startsWith("-")) return "negative";
  // In a quoted (signed bp change, yield level) pair, the sign belongs to
  // that maturity's level. A later "new high" must not reverse it.
  const pairStart = value.lastIndexOf("(", start);
  if (pairStart >= 0 && value.indexOf(")", pairStart) >= end) {
    const pair = value.slice(pairStart + 1, start);
    const delta = /^\s*([+-])\d+(?:\.\d+)?\s*(?:bps?|basis points?)\s*,\s*$/iu.exec(pair);
    if (delta) return delta[1] === "-" ? "negative" : "positive";
  }
  const attached = /^\s*(higher|lower|up|down)\b/iu.exec(value.slice(end));
  if (attached) return /^(?:lower|down)$/iu.test(attached[1]) ? "negative" : "positive";
  const boundaries = [...value.matchAll(/[。.!！?？；;，,\n]/gu)]
    .filter(match => !(/[.,]/u.test(match[0]) && /\d/u.test(value[(match.index ?? 0) - 1] ?? "") && /\d/u.test(value[(match.index ?? 0) + 1] ?? "")))
    .map(match => match.index ?? 0);
  let leftBoundary = boundaries.filter(index => index < start).at(-1) ?? -1;
  // A settlement clause can continue the same movement after a comma.
  // Decimal points and thousands separators above are not clause boundaries.
  if (/[，,]/u.test(value[leftBoundary] ?? "") && /^\s*(?:收于|收报|报收|至|settled? at|closed at|closing at)/iu.test(value.slice(leftBoundary + 1, start))) {
    leftBoundary = boundaries.filter(index => index < leftBoundary && !/[，,]/u.test(value[index])).at(-1) ?? -1;
  }
  const rightBoundary = boundaries.find(index => index >= end) ?? value.length;
  const clauseStart = leftBoundary + 1;
  const clause = value.slice(clauseStart, rightBoundary);
  const numberOffset = start - clauseStart;
  const candidates = [];
  for (const [direction, pattern] of [
    ["positive", POSITIVE_DIRECTION],
    ["negative", NEGATIVE_DIRECTION],
  ]) {
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) {
      if (match[0].toLowerCase() === "up" && /\b(?:gave|give|given)\s+$/iu.test(clause.slice(0, match.index))) continue;
      if (/^(?:超过|高于|低于)$/u.test(match[0]) && /^\s*(?:只|家|项|人)/u.test(value.slice(end)) && (match.index ?? 0) < numberOffset) continue;
      candidates.push({
        direction,
        preceding: (match.index ?? 0) < numberOffset,
        distance: Math.abs((match.index ?? 0) - numberOffset),
      });
    }
  }
  candidates.sort((left, right) => Number(right.preceding) - Number(left.preceding) || left.distance - right.distance);
  return candidates[0]?.direction ?? null;
}

const CALENDAR_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ENGLISH_ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

function canonicalMention(mention) {
  const scales = { billion_usd: ["usd", 1e9], million_usd: ["usd", 1e6], thousand_usd: ["usd", 1e3], hundred_million_usd: ["usd", 1e8], ten_thousand_usd: ["usd", 1e4], hundred_million_cny: ["cny", 1e8], million_cny: ["cny", 1e6], ten_thousand_cny: ["cny", 1e4] };
  const scale = scales[mention.unit];
  if (scale) return { ...mention, unit: scale[0], number: Number((mention.number * scale[1]).toPrecision(15)) };
  // Basis points and percentage points are changes, not yield levels. An
  // unsigned magnitude after "fell" equals a negative signed change; this
  // rule must never turn a positive dollar/EPS level into a negative one.
  if (["basis_points", "percentage_points"].includes(mention.unit)) {
    const amount = Math.abs(mention.number) * (mention.unit === "percentage_points" ? 100 : 1);
    return { ...mention, unit: "rate_difference", number: Number((amount * (mention.direction === "negative" ? -1 : 1)).toPrecision(15)) };
  }
  return mention;
}

function numericMentions(value) {
  // Convert only explicitly bound mixed fractional durations, never bare
  // fractions in ratios, dates, currencies or quoted financial amounts.
  const copy = String(value).replace(/−/gu, "-").replace(/\b(\d+)-(\d+)\/(\d+)(?=-?years?\b)/giu, (raw, whole, numerator, denominator) => Number(denominator) > 0 && Number(numerator) < Number(denominator) ? String(Number(whole) + Number(numerator) / Number(denominator)) : raw);
  const dates = [...copy.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)].filter(match => isCalendarDate(match[0]));
  FACT_NUMBER_MENTION.lastIndex = 0;
  const mentions = [...copy.matchAll(FACT_NUMBER_MENTION)].filter(match => !dates.some(date => match.index >= date.index && match.index < date.index + date[0].length)).map(match => {
    const start = match.index ?? 0, end = start + match[0].length;
    const before = copy.slice(Math.max(0, start - 45), start), after = copy.slice(end);
    if (match.groups.outerSign && /^[+-]/u.test(match.groups.number)) throw new Error("事实数值带有重复符号");
    // An explicit repeated-currency range separator is not a negative upper
    // bound. A standalone -$0.25 remains a loss; other hyphens stay signed.
    const currencyRange = match.groups.outerSign === "-" && match.groups.prefix && new RegExp(`(?:${escapeRegularExpression(match.groups.prefix)})\\s*\\d[\\d,]*(?:\\.\\d+)?\\s*$`, "iu").test(before);
    const signedNumber = (currencyRange ? "" : match.groups.outerSign) + match.groups.number;
    const number = Number(signedNumber.replaceAll(",", ""));
    let unit = numberMentionUnit(match.groups.prefix, match.groups.suffix);
    let direction = nearestDirection(copy, start, end, signedNumber);
    if (unit === "number") {
      if (/(?:S&P|Standard (?:&|and) Poor[’']s|标普)\s*$/iu.test(before)) unit = "index_identifier_sp";
      else if (/^月(?!份?的?期)/u.test(after)) unit = "calendar_month";
      else if (number >= 1900 && number <= 2199 && (/^(?:财)?年/u.test(after) || /(?:\b(?:since|in|FY|fiscal year)\s*|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2}[, ]*)?)$/iu.test(before))) unit = "calendar_year";
      else if (/^日/u.test(after) || /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*$/u.test(before)) unit = "calendar_day";
      else if (/^季度/u.test(after) && /第$/u.test(before) || /\bQ$/u.test(before)) unit = "quarter_number";
      else if (/第$/u.test(before) || /^(?:st|nd|rd|th)\b/u.test(after)) unit = "ordinal_number";
      else if (/^(?:-?years?\b|年(?:期|以来|低|高|纪录|新|半))/iu.test(after)) unit = "duration_years";
      if (["index_identifier_sp", "calendar_month", "calendar_year", "calendar_day", "quarter_number", "ordinal_number", "duration_years"].includes(unit)) direction = null;
    }
    return canonicalMention({ number, display: match[0].trim(), unit, direction });
  });
  for (const date of dates) {
    const [year, month, day] = date[0].split("-").map(Number);
    for (const [number, unit] of [[year, "calendar_year"], [month, "calendar_month"], [day, "calendar_day"]]) mentions.push({ number, unit, direction: null, display: date[0] });
  }
  for (let i = 0; i < CALENDAR_MONTHS.length; i++) {
    const name = CALENDAR_MONTHS[i];
    // Capitalized May is also a modal at the start of a sentence. Only its
    // calendar uses can substantiate a translated month.
    const pattern = new RegExp(`\\b${name}\\b`, "gu");
    for (const match of copy.matchAll(pattern)) {
      if (name === "May" && !/\b(?:in|for|since|during|through|from|of|this|last|next|to)\s+$/iu.test(copy.slice(Math.max(0, match.index - 12), match.index)) && !/^\s+(?:\d|was\b|is\b|had\b|ended\b|reading\b|data\b|survey\b)/u.test(copy.slice(match.index + 3))) continue;
      mentions.push({ number: i + 1, unit: "calendar_month", direction: null, display: name });
    }
  }
  for (let i = 0; i < ENGLISH_ORDINALS.length; i++) {
    for (const match of copy.matchAll(new RegExp(`\\b${ENGLISH_ORDINALS[i]}\\b`, "giu"))) {
      const before = copy.slice(Math.max(0, match.index - 12), match.index), after = copy.slice(match.index + match[0].length);
      if (/one[- ]$/iu.test(before) || !/^[ -]+(?:straight|consecutive|successive|months?|quarters?|years?|times?|place|largest|smallest|highest|lowest|rank|days?|weeks?|rounds?|release|company)\b/iu.test(after)) continue;
      mentions.push({ number: i + 1, unit: /^[ -]+quarters?\b/iu.test(after) ? "quarter_number" : "ordinal_number", direction: null, display: match[0] });
    }
  }
  return mentions;
}

export function assertFactsNumbersInExcerpt(source) {
  const excerptMentions = numericMentions(source.supportingExcerpt);
  const factCopy = [source.facts, ...(source.comparisons ?? []).map((item) => item.note ?? "")].join(" ");
  const missing = numericMentions(factCopy).filter(
    (fact) =>
      !excerptMentions.some(
        (excerpt) =>
          excerpt.number === fact.number &&
          excerpt.unit === fact.unit &&
          (!fact.direction || excerpt.direction === fact.direction),
      ),
  );
  if (missing.length > 0) {
    throw new Error(
      `事实字段包含无法按单位和方向在支持段落中定位的数字：${[
        ...new Set(missing.map((item) => item.display)),
      ].join(", ")}`,
    );
  }
}

export function hasCausalPassage(excerpt) {
  // A necessary prose check, not proof of causation. Adjudication and review
  // must still establish the event, connection and exact affected target.
  // A price table or "index up; constituents up" recap has none of these
  // causal expressions, even if a researcher labels it causalConnection=true.
  return /(?:因为|由于|缘于|归因|原因|导火索|催化|受.{0,35}(?:影响|提振|拖累)|推动|带动|拖累|提振|支撑|促使|导致|引发|影响|压制|冲击|共振|担忧|预期|抛压|承接不足|\b(?:because|amid|after|following|(?:re)?pricing|due\s+to|driv\w*|drove|driven|drag\w*|lift\w*|help\w*|support\w*|weigh\w*|spurr?\w*|fuel\w*|boost\w*|spark\w*|prompt\w*|catal\w*|react\w*|respond\w*|concern\w*|worr\w*|expect\w*)\b)/iu.test(String(excerpt ?? ""));
}

export function hasEarningsPerShareComparison(source) {
  return (source.comparisons ?? []).some((item) => /每股(?:收益|盈利)|earnings per share|\beps\b/iu.test(item.label ?? ""));
}

export function assertComparisonNotesInExcerpt(source) {
  assertFactsNumbersInExcerpt({ ...source, facts: "" });
}

export function assertMaterialEarningsContext(source, body) {
  if (!hasEarningsPerShareComparison(source)) return;
  const qualification = /投资.{0,8}收益|非经常性.{0,12}(?:收益|损益)|一次性.{0,12}(?:收益|损益)|(?:gains?|income).{0,35}(?:strategic investments?|one[ -]off|non[ -]recurring)|(?:one[ -]off|non[ -]recurring).{0,35}(?:gains?|income)/giu;
  const fullText = String(body);
  const material = [...fullText.matchAll(qualification)].some((match) =>
    /每股(?:收益|盈利)|earnings per share|\beps\b/iu.test(fullText.slice(Math.max(0, match.index - 350), match.index + match[0].length + 350)),
  );
  qualification.lastIndex = 0;
  if (material && !qualification.test(source.supportingExcerpt)) {
    throw new Error("财报每股收益原文含投资或非经常性收益的重要解释，支持摘录遗漏该口径；须补入原文及指标说明，不能把全部盈利差额解释为经营改善");
  }
}

export function supportingExcerptMatches(normalizedBody, normalizedExcerpt, excerpt) {
  const sourceComparable = normalizedBody.replaceAll("维权", "");
  const excerptComparable = normalizedExcerpt.replaceAll("维权", "");
  if (sourceComparable.includes(excerptComparable)) return true;
  const fragments = String(excerpt)
    .split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/u)
    .map((value) =>
      normalizedEvidenceText(value)
        .replaceAll("维权", "")
        .replace(/[.]+$/u, ""),
    )
    .filter((value) => value.length > 0);
  if (fragments.length < 2) return false;
  let cursor = 0;
  for (const fragment of fragments) {
    const index = sourceComparable.indexOf(fragment, cursor);
    if (index < 0) return false;
    cursor = index + fragment.length;
  }
  return true;
}

function deterministicTargetAliases(envelope, target) {
  const metrics = [
    ...envelope.markets,
    ...envelope.sectorPerformance,
    ...envelope.aiChainPerformance,
    ...envelope.sectorPerformance.flatMap((item) => item.constituents ?? []),
    ...envelope.aiChainPerformance.flatMap((item) => item.constituents ?? []),
  ];
  const normalizedTarget = String(target).trim().toLocaleLowerCase();
  const metric = metrics.find((item) =>
    [item.symbol, item.layer, item.name, item.nameEn]
      .filter(Boolean)
      .some(
        (value) =>
          String(value).trim().toLocaleLowerCase() === normalizedTarget,
      ),
  );
  if (!metric) return [];
  const layerAliases = {
    servers: ["服务器", "算力硬件", "AI server", "AI servers"],
    memory: ["存储芯片", "存储板块", "存储股", "memory chips", "memory stocks"],
    robotics: ["机器人", "robotics"],
    applications: [
      "AI应用",
      "AI软件",
      "人工智能应用",
      "AI办公",
      "AI编程",
      "应用软件",
      "软件板块",
      "软件股",
      "软件开发",
    ],
    interconnect: ["光互连", "光模块", "CPO"],
    data_center: ["数据中心", "液冷"],
    cloud: ["云计算", "NeoCloud"],
  }[metric.layer] ?? [];
  const marketAliases =
    metric.symbol === "DGS10"
      ? ["10-year Treasury", "10-year Treasury yield"]
      : metric.symbol === "SPX" ? ["S&P 500", "Standard & Poor’s 500", "Standard & Poor's 500", "Standard and Poor's 500"] : [];
  const isAiLayer = envelope.aiChainPerformance.includes(metric);
  const aliases = [
    ...new Set([
      metric.symbol,
      metric.name,
      metric.nameEn,
      ...marketAliases,
      ...(isAiLayer ? [metric.layer, ...layerAliases] : []),
    ]),
  ]
    .filter((value) => typeof value === "string" && value.trim().length >= 2);
  return aliases.map((value) => ({
    value: value.normalize("NFKC").toLocaleLowerCase(),
    normalized: normalizedEvidenceText(value),
    token:
      value === metric.symbol &&
      /^[A-Za-z][A-Za-z0-9.-]*$/u.test(value),
    explicitTicker:
      value === metric.symbol &&
      /^[A-Za-z]{1,2}$/u.test(value),
  }));
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function bodySupportsDeterministicTarget(body, envelope, target) {
  const aliases = deterministicTargetAliases(envelope, target);
  if (aliases.length === 0) return false;
  const raw = String(body).normalize("NFKC").toLocaleLowerCase();
  const normalized = normalizedEvidenceText(body);
  return aliases.some((alias) => {
    if (alias.explicitTicker) {
      return new RegExp(
        `(?:\\$|(?:nasdaq|nyse|amex|nasdaqgs|nasdaqcm|nasdaqgm)[\\s:]*)${escapeRegularExpression(alias.value)}(?=$|[^a-z0-9])`,
        "iu",
      ).test(raw);
    }
    return alias.token
      ? new RegExp(
          `(?:^|[^a-z0-9])${escapeRegularExpression(alias.value)}(?=$|[^a-z0-9])`,
          "iu",
        ).test(raw)
      : normalized.includes(alias.normalized);
  });
}

function normalizedSourceKind(source, envelope) {
  if (source.kind !== "market_wrap") return source.kind;
  return Date.parse(source.publishedAt) < Date.parse(envelope.session.windowEnd)
    ? "event"
    : source.kind;
}

export async function verifyResearchSources(
  researchOutputs,
  envelope,
  { reader = readExternalSource, signal, verifiedCache = new Map(), checkSessionIntegrity = false } = {},
) {
  const candidates = researchOutputs.flatMap((output) => output.sources);
  const results = new Array(candidates.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < candidates.length) {
      signal?.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      try {
        if (candidate.role === "causal" && candidate.causalConnection && !hasCausalPassage(candidate.supportingExcerpt)) {
          throw new Error("因果支持段落仅并列行情，未表达事件与价格反应的联系");
        }
        const candidateHash = stableHash(candidate);
        const cached = verifiedCache.get(candidateHash);
        if (cached?.candidateHash === candidateHash && cached.timingChecked === true && cached.comparisonNotesChecked === true && (!checkSessionIntegrity || cached.closingIntegrityChecked === true) && (!hasEarningsPerShareComparison(candidate) || cached.earningsContextChecked === true)) {
          results[index] = { verified: structuredClone(cached) };
          continue;
        }
        const backgroundSecDocument = candidate.kind === "background" && new URL(candidate.originalUrl).hostname === "www.sec.gov";
        const opened = await reader(candidate.originalUrl, { signal, ...(backgroundSecDocument ? { maxBytes: 8 * 1024 * 1024 } : {}) });
        assertAccessibleOriginalArticle(opened);
        const sourceType = verifiedExternalSourceType(opened.finalUrl, "web");
        if (candidate.kind === "background" && (candidate.role !== "facts" || sourceType !== "first_party" || candidate.comparisons.length || candidate.causalConnection)) throw new Error("背景来源与一手披露职责不一致");
        const publishedAt = verifiedSourceTime(
          candidate,
          envelope,
          opened.publishedAtCandidates ?? [],
          opened.publishedDateCandidates ?? [],
          sourceType,
        );
        const closingChecks = checkSessionIntegrity ? assertSessionClosingClaims(opened.text, envelope, publishedAt) : [];
        let normalizedCandidate = {
          ...candidate,
          title: readerText(candidate.title, "verified source title", 4, 220),
          facts: readerText(candidate.facts, "verified source facts", 20, 1_600),
          publishedAt,
          kind: normalizedSourceKind(
            { ...candidate, publishedAt },
            envelope,
          ),
        };
        if (sourceType === "expert") {
          throw new Error("来源不在一手或专业媒体注册表中");
        }
        const normalizedBody = normalizedEvidenceText(opened.text);
        const normalizedExcerpt = normalizedEvidenceText(
          candidate.supportingExcerpt,
        );
        if (
          normalizedExcerpt.length < 20 ||
          !supportingExcerptMatches(
            normalizedBody,
            normalizedExcerpt,
            candidate.supportingExcerpt,
          )
        ) {
          throw new Error("支持段落无法在来源正文中定位");
        }
        assertFactsNumbersInExcerpt(candidate);
        assertMaterialEarningsContext(candidate, opened.text);
        const excerptSupportsTarget = bodySupportsDeterministicTarget(
          candidate.supportingExcerpt,
          envelope,
          candidate.targets[0],
        );
        let backgroundSubjects;
        if (candidate.kind === "background") {
          const metric = [...envelope.markets, ...envelope.sectorPerformance, ...envelope.aiChainPerformance].find(item => item.symbol === candidate.targets[0]);
          const expectedScope = envelope.sectorPerformance.includes(metric) ? "sector" : envelope.aiChainPerformance.includes(metric) ? "ai_layer" : "market";
          if (candidate.scope !== "company" && candidate.scope !== expectedScope) throw new Error("背景披露的适用范围与对应目标不一致");
          const industryAuthorities = ["commerce.gov", "conference-board.org", "eia.gov", "energy.gov", "federalreserve.gov", "gov.cn", "miit.gov.cn", "ndrc.gov.cn", "stats.gov.cn"];
          const sourceHost = new URL(opened.finalUrl).hostname;
          if (expectedScope === "ai_layer" && candidate.scope !== "company" && !industryAuthorities.some(domain => sourceHost === domain || sourceHost.endsWith(`.${domain}`))) throw new Error("发行人或单家公司披露不能自动扩大为整个 AI 环节的背景机制");
          backgroundSubjects = candidate.scope === "company" ? (metric?.constituents ?? []).filter(item => bodySupportsDeterministicTarget(candidate.supportingExcerpt, envelope, item.symbol)).map(item => item.symbol) : excerptSupportsTarget ? [candidate.targets[0]] : [];
          if (!backgroundSubjects.length) throw new Error("背景披露未明确对应目标或其指定成分，不能用泛泛风险套用板块");
          if (!/需求|供给|成本|利率|融资|监管|风险|\b(?:demand|supply|costs?|rates?|financing|regulat\w*|risks?)\b/iu.test(candidate.supportingExcerpt)) throw new Error("背景原文未包含可检验的经济传导因素");
        }
        if (candidate.role === "causal" && !excerptSupportsTarget) {
          throw new Error("因果支持段落未出现确定性归因目标的代码或名称");
        }
        if (candidate.role === "facts" && candidate.kind !== "background" && !excerptSupportsTarget) {
          normalizedCandidate = {
            ...normalizedCandidate,
            scope: "event_only",
          };
        }
        for (const comparison of candidate.comparisons) {
          for (const [display, expected] of [
            [comparison.actualDisplay, comparison.actualValue],
            [comparison.baselineDisplay, comparison.baselineValue],
          ]) {
            if (
              !hasUnitBoundComparisonValue(
                candidate.supportingExcerpt,
                comparison.unit,
                expected,
              )
            ) {
              throw new Error(
                `财报对比值无法按声明单位在支持段落中定位：${display}`,
              );
            }
          }
        }
        const finalUrl = new URL(opened.finalUrl).toString();
        const id = stableHash(
          `${candidate.anomalyId}|${candidate.role}|${finalUrl}|${normalizedExcerpt}`,
        ).slice(0, 20);
        results[index] = {
          verified: {
            ...normalizedCandidate,
            earningsContextChecked: true,
            comparisonNotesChecked: true,
            timingChecked: true,
            ...(checkSessionIntegrity ? { closingIntegrityChecked: true, closingChecks } : {}),
            ...(backgroundSubjects ? { backgroundSubjects, useLimitation: "Background exposure/mechanism only; not a current-session event, price reaction, or proven catalyst." } : {}),
            timePrecision: isCalendarDate(publishedAt) ? "date" : "instant",
            ...(isCalendarDate(publishedAt) ? { timingLimitation: "The source establishes a release date; intraday publication and availability are unverified." } : {}),
            candidateHash,
            id,
            url: finalUrl,
            sourceLabel: verifiedExternalSourceLabel(finalUrl),
            status: opened.status,
            contentType: opened.contentType,
            sourceType,
            excerptHash: stableHash(normalizedExcerpt),
            verifiedAt: new Date().toISOString(),
            comparisons: [
              ...new Map(
                candidate.comparisons.map((comparison) => [
                  comparisonSemanticKey(comparison),
                  comparison,
                ]),
              ).values(),
            ].map(
              (comparison, comparisonIndex) => ({
                ...comparison,
                id: `${id}:${comparisonIndex}`,
                sourceUrl: finalUrl,
              }),
            ),
          },
        };
        verifiedCache.set(candidateHash, structuredClone(results[index].verified));
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        results[index] = {
          rejected: {
            anomalyId: candidate.anomalyId,
            role: candidate.role,
            url: candidate.originalUrl,
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(4, candidates.length) },
      () => worker(),
    ),
  );
  const verified = results.flatMap((item) => item?.verified ?? []);
  const rejected = [
    ...researchOutputs.flatMap((output) => output.rejectedSources ?? []),
    ...results.flatMap((item) => item?.rejected ?? []),
  ];
  const deduplicated = [...new Map(verified.map((item) => [item.id, item])).values()];
  const sourceIdsByOriginalUrl = new Map();
  for (const source of deduplicated) {
    const ids = sourceIdsByOriginalUrl.get(source.originalUrl) ?? [];
    ids.push(source.id);
    sourceIdsByOriginalUrl.set(source.originalUrl, ids);
  }
  const alternatives = researchOutputs.flatMap((output) =>
    output.alternatives.map((alternative) => {
      const evidenceIds = alternative.sourceUrls.flatMap(
        (url) => sourceIdsByOriginalUrl.get(url) ?? [],
      );
      const verifiedAlternative =
        alternative.status === "unresolved" ||
        (alternative.sourceUrls.length > 0 && evidenceIds.length > 0);
      return {
        anomalyId: output.anomalyId,
        role: output.role,
        claim: alternative.claim,
        status: verifiedAlternative ? alternative.status : "unresolved",
        evidenceIds: [...new Set(evidenceIds)],
      };
    }),
  );
  return {
    contractVersion: "stock-daily-evidence-ledger-v1",
    market: envelope.market,
    marketAsOf: envelope.marketAsOf,
    verifiedAt: new Date().toISOString(),
    sources: deduplicated,
    rejected,
    alternatives,
  };
}

function formatNumber(value, digits = 2) {
  return Math.abs(value).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function decimalPlaces(value) {
  const match = /^(?:\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(
    Math.abs(value).toString(),
  );
  if (!match) return 0;
  return Math.max(0, (match[1]?.length ?? 0) - Number(match[2] ?? 0));
}

function comparisonSemanticKey(comparison) {
  return JSON.stringify([
    String(comparison.label ?? "")
      .normalize("NFKC")
      .trim()
      .toLocaleLowerCase(),
    comparison.actualValue,
    comparison.baselineValue,
    comparison.unit,
    comparison.higherIsPositive,
  ]);
}

function deltaDisplay(comparison) {
  const delta = comparison.actualValue - comparison.baselineValue;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const unit = {
    billion_usd: ["$", "B"],
    million_usd: ["$", "M"],
    usd: ["$", ""],
    hundred_million_cny: ["", "亿元"],
    million_cny: ["", "百万元"],
    cny: ["¥", ""],
    percent: ["", "个百分点"],
    basis_points: ["", " bp"],
    count: ["", ""],
    other: ["", ""],
  }[comparison.unit];
  const nonzeroDigits =
    delta !== 0 && Math.abs(delta) < 1
      ? Math.ceil(-Math.log10(Math.abs(delta)))
      : 0;
  const deltaDigits = Math.min(
    20,
    Math.max(
      2,
      nonzeroDigits,
      decimalPlaces(comparison.actualValue),
      decimalPlaces(comparison.baselineValue),
    ),
  );
  const absolute = `${unit[0]}${formatNumber(delta, deltaDigits)}${unit[1]}`;
  const percent =
    comparison.baselineValue === 0
      ? ""
      : `（${delta > 0 ? "+" : delta < 0 ? "-" : ""}${formatNumber(
          (delta / Math.abs(comparison.baselineValue)) * 100,
          1,
        )}%）`;
  return `${sign}${absolute}${percent}`;
}

export function publicComparison(comparison) {
  const delta = comparison.actualValue - comparison.baselineValue;
  const positive = comparison.higherIsPositive ? delta >= 0 : delta <= 0;
  const normalizedLabel = comparison.label.replace(
    /^Probability of a Federal Reserve rate hike as soon as next month$/iu,
    "Next-month Fed rate-hike probability",
  );
  const label =
    [...normalizedLabel].length <= 40
      ? normalizedLabel
      : `${[...normalizedLabel].slice(0, 39).join("").trimEnd()}…`;
  const baselineAliases = new Map([
    ["FactSet Wall Street consensus forecast", "FactSet consensus"],
    ["Analysts’ average forecast", "Analyst consensus"],
    ["Analysts' average forecast", "Analyst consensus"],
  ]);
  const normalizedBaseline =
    baselineAliases.get(comparison.baselineLabel) ?? comparison.baselineLabel;
  const baselineLabel =
    [...normalizedBaseline].length <= 24
      ? normalizedBaseline
      : `${[...normalizedBaseline].slice(0, 23).join("").trimEnd()}…`;
  const note = comparison.note
    .replace(/(?:[；;，,]?\s*)?(?:未|不由(?:研究者|模型|人工))计算(?:差值|差额)[。.]?/gu, "")
    .trim();
  return {
    label,
    actual: comparison.actualDisplay,
    baselineLabel,
    baseline: comparison.baselineDisplay,
    delta: deltaDisplay(comparison),
    tone: delta === 0 ? "neutral" : positive ? "positive" : "negative",
    note,
  };
}

export function validateAdjudication(value, plan, ledger, envelope) {
  const result = object(value, "adjudication");
  if (
    result.contractVersion !== "stock-daily-adjudication-v1" ||
    result.market !== plan.market ||
    envelope?.market !== plan.market ||
    envelope?.marketAsOf !== plan.marketAsOf
  ) {
    throw new Error("归因裁决与研究计划不一致");
  }
  const anomalyIds = new Set(plan.anomalies.map((item) => item.id));
  const sourceMap = new Map(ledger.sources.map((item) => [item.id, item]));
  if (!Array.isArray(result.decisions) || result.decisions.length === 0) {
    throw new Error("归因裁决缺少决策");
  }
  const decisions = result.decisions.map((raw, index) => {
    const decision = object(raw, `decisions[${index}]`);
    if (!anomalyIds.has(decision.anomalyId)) {
      throw new Error(`未知异动 ${decision.anomalyId}`);
    }
    const verdict = enumValue(
      decision.verdict,
      ["accepted", "rejected", "unresolved"],
      `${decision.anomalyId}.verdict`,
    );
    const publishedAs = enumValue(
      decision.publishedAs,
      ["market_driver", "ai_update", "none"],
      `${decision.anomalyId}.publishedAs`,
    );
    if ((verdict === "accepted") !== (publishedAs !== "none")) {
      throw new Error(`${decision.anomalyId} 的发布状态与裁决矛盾`);
    }
    return {
      anomalyId: decision.anomalyId,
      verdict,
      publishedAs,
      reason: text(decision.reason, `${decision.anomalyId}.reason`, 10, 500),
    };
  });
  if (
    decisions.length !== anomalyIds.size ||
    new Set(decisions.map((item) => item.anomalyId)).size !== decisions.length
  ) {
    throw new Error("归因裁决必须逐项且只裁决一次每个异动");
  }
  const decisionByAnomaly = new Map(
    decisions.map((item) => [item.anomalyId, item]),
  );
  const acceptedIds = new Set(
    decisions.filter((item) => item.verdict === "accepted").map((item) => item.anomalyId),
  );
  if (!Array.isArray(result.claimCards) || result.claimCards.length > 3) {
    throw new Error("claimCards 最多三项");
  }
  const claimCards = result.claimCards.map((raw, index) => {
    const claim = object(raw, `claimCards[${index}]`);
    if (!acceptedIds.has(claim.anomalyId)) {
      throw new Error(`${claim.anomalyId} 未被接受却生成了归因卡片`);
    }
    const evidenceIds = stringArray(
      claim.evidenceIds,
      `${claim.anomalyId}.evidenceIds`,
      2,
      3,
    );
    const evidence = evidenceIds.map((id) => {
      const source = sourceMap.get(id);
      if (!source) throw new Error(`${claim.anomalyId} 引用了未知证据 ${id}`);
      if (source.anomalyId !== claim.anomalyId) {
        throw new Error(`${claim.anomalyId} 引用了其他异动的证据 ${id}`);
      }
      return source;
    });
    if (!evidence.some((item) => item.role === "facts") || !evidence.some((item) => item.role === "causal" && item.causalConnection)) {
      throw new Error(`${claim.anomalyId} 缺少相互独立的事实与因果证据`);
    }
    if (!evidence.some((item) => item.role === "causal" && item.causalConnection && hasCausalPassage(item.supportingExcerpt))) {
      throw new Error(`${claim.anomalyId} 的因果原文仅并列行情，未表达事件与价格反应的联系；必须补查因果证据，不能用改写事实摘要代替`);
    }
    const anomaly = plan.anomalies.find(
      (item) => item.id === claim.anomalyId,
    );
    if (
      !ledger.alternatives.some(
        (alternative) =>
          alternative.anomalyId === claim.anomalyId &&
          alternative.role === "causal",
      )
    ) {
      throw new Error(`${claim.anomalyId} 未记录独立因果研究检查的竞争解释`);
    }
    const factsHypothesisIds = new Set(
      evidence
        .filter((item) => item.role === "facts")
        .flatMap((item) => item.hypothesisIds),
    );
    const causalHypothesisIds = new Set(
      evidence
        .filter((item) => item.role === "causal" && item.causalConnection)
        .flatMap((item) => item.hypothesisIds),
    );
    const sharedHypotheses = anomaly.hypotheses.filter(
      (hypothesis) =>
        factsHypothesisIds.has(hypothesis.id) &&
        causalHypothesisIds.has(hypothesis.id),
    );
    if (sharedHypotheses.length === 0) {
      throw new Error(`${claim.anomalyId} 的事实与因果证据未共同支持同一候选原因`);
    }
    const hypothesisId = claim.hypothesisId ?? sharedHypotheses[0].id;
    if (!sharedHypotheses.some((hypothesis) => hypothesis.id === hypothesisId)) {
      throw new Error(`${claim.anomalyId}.hypothesisId 未获两类独立证据共同支持`);
    }
    const factExcerptHashes = new Set(
      evidence
        .filter((item) => item.role === "facts")
        .map((item) => item.excerptHash),
    );
    if (
      evidence
        .filter((item) => item.role === "causal")
        .some((item) => factExcerptHashes.has(item.excerptHash))
    ) {
      throw new Error(`${claim.anomalyId} 的事实与因果证据不得复用同一段正文`);
    }
    const scope = enumValue(
      claim.scope,
      ["market", "sector", "subsector", "ai_layer", "company"],
      `${claim.anomalyId}.scope`,
    );
    const targets = stringArray(claim.targets, `${claim.anomalyId}.targets`, 1, 4);
    if (targets.length !== 1 || targets[0] !== anomaly.target) {
      throw new Error(`${claim.anomalyId} 的归因目标必须精确等于计划中的确定性异动目标`);
    }
    const causalMatches = evidence.some(
      (item) =>
        item.role === "causal" &&
        item.causalConnection &&
        item.scope === scope &&
        targets.every((target) => item.targets.includes(target)),
    );
    if (!causalMatches) {
      throw new Error(`${claim.anomalyId} 的因果证据范围与归因目标不匹配`);
    }
    const declaredComparisonIds = stringArray(
      claim.comparisonIds,
      `${claim.anomalyId}.comparisonIds`,
      0,
      4,
    );
    const comparisonRecords = declaredComparisonIds.map((id) => {
      const match = evidence
        .filter((item) => item.role === "facts")
        .flatMap((item) => item.comparisons)
        .find((item) => item.id === id);
      if (!match) throw new Error(`${claim.anomalyId} 引用了未知对比数据 ${id}`);
      return { id, comparison: match };
    });
    const uniqueComparisonRecords = [
      ...new Map(
        comparisonRecords.map((item) => [
          comparisonSemanticKey(item.comparison),
          item,
        ]),
      ).values(),
    ];
    const comparisonIds = uniqueComparisonRecords.map((item) => item.id);
    const comparisons = uniqueComparisonRecords.map((item) => item.comparison);
    const title = text(claim.title, `${claim.anomalyId}.title`, 5, 100);
    const factSummary = text(
      claim.factSummary,
      `${claim.anomalyId}.factSummary`,
      20,
      800,
    );
    const causalStatement = text(
      claim.causalStatement,
      `${claim.anomalyId}.causalStatement`,
      40,
      600,
    );
    assertNumbersGrounded(
      `${title} ${factSummary} ${causalStatement}`,
      `${JSON.stringify(anomaly)} ${evidence
        .map((item) => `${item.facts} ${JSON.stringify(item.comparisons)}`)
        .join(" ")}`,
      `${claim.anomalyId} 归因卡片`,
    );
    if (
      requiresFinancialComparisons(`${title} ${factSummary} ${causalStatement}`) &&
      comparisons.length < 2
    ) {
      throw new Error(`${claim.anomalyId} 的财报归因缺少至少两项实际值与预期值对比`);
    }
    const publishedAs = enumValue(
      claim.publishedAs,
      ["market_driver", "ai_update"],
      `${claim.anomalyId}.publishedAs`,
    );
    if (decisionByAnomaly.get(claim.anomalyId)?.publishedAs !== publishedAs) {
      throw new Error(`${claim.anomalyId} 的卡片类型与裁决不一致`);
    }
    if (anomaly.kind === "ai_layer" && publishedAs !== "ai_update") {
      throw new Error(`${claim.anomalyId} 的 AI 分层异动必须发布为 AI 产业链归因`);
    }
    if (publishedAs === "ai_update" && scope !== "ai_layer") {
      throw new Error(`${claim.anomalyId} 的 AI 产业链归因范围必须为 ai_layer`);
    }
    if (publishedAs === "market_driver" && scope === "ai_layer") {
      throw new Error(`${claim.anomalyId} 的大盘归因不得使用 ai_layer 范围`);
    }
    const sectorSymbols =
      scope === "market" || publishedAs === "ai_update"
        ? []
        : stringArray(
            claim.sectorSymbols,
            `${claim.anomalyId}.sectorSymbols`,
            1,
            4,
          );
    if (
      sectorSymbols.some(
        (symbol) =>
          !envelope.sectorPerformance.some((sector) => sector.symbol === symbol),
      )
    ) {
      throw new Error(`${claim.anomalyId} 的板块绑定不在确定性市场输入中`);
    }
    if (scope === "company") {
      const parentSectors = envelope.sectorPerformance.filter((sector) =>
        (sector.constituents ?? []).some(
          (constituent) => constituent.symbol === targets[0],
        ),
      );
      if (
        parentSectors.length !== 1 ||
        !sectorSymbols.includes(parentSectors[0].symbol)
      ) {
        throw new Error(`${claim.anomalyId} 的公司归因未绑定确定性所属板块`);
      }
    }
    if (
      ["sector", "subsector"].includes(scope) &&
      !sectorSymbols.includes(anomaly.target)
    ) {
      throw new Error(`${claim.anomalyId} 的板块归因未绑定确定性异动板块`);
    }
    const direction = enumValue(
      claim.direction,
      ["positive", "negative", "mixed"],
      `${claim.anomalyId}.direction`,
    );
    if (direction !== anomaly.direction) {
      throw new Error(`${claim.anomalyId} 的卡片方向与行情异动不一致`);
    }
    const layer =
      publishedAs === "ai_update"
        ? /^AI-(?:CN|US)-(.+)$/u.exec(anomaly.target)?.[1] ?? ""
        : "";
    if (publishedAs === "ai_update" && !layer) {
      throw new Error(`${claim.anomalyId} 的 AI 归因目标无法映射到确定性产业链环节`);
    }
    return {
      id: stableHash(`${plan.market}|${claim.anomalyId}|${evidenceIds.join("|")}`).slice(0, 20),
      anomalyId: claim.anomalyId,
      hypothesisId,
      publishedAs,
      basis: enumValue(claim.basis, ["event", "macro"], `${claim.anomalyId}.basis`),
      direction,
      scope,
      targets,
      sectorSymbols,
      layer,
      title,
      factSummary,
      causalStatement,
      evidenceIds,
      comparisonIds,
      comparisons: comparisons.map(publicComparison),
      alternativeAssessment: text(
        claim.alternativeAssessment,
        `${claim.anomalyId}.alternativeAssessment`,
        10,
        500,
      ),
    };
  });
  const cardAnomalyIds = new Set(claimCards.map((card) => card.anomalyId));
  if (
    claimCards.filter((card) => card.publishedAs === "market_driver").length > 2
  ) {
    throw new Error("归因裁决最多接受两条市场驱动");
  }
  if (
    claimCards.length !== acceptedIds.size ||
    cardAnomalyIds.size !== claimCards.length ||
    [...acceptedIds].some((anomalyId) => !cardAnomalyIds.has(anomalyId))
  ) {
    throw new Error("已接受裁决与归因卡片数量不一致");
  }
  return {
    contractVersion: result.contractVersion,
    market: result.market,
    decisions,
    claimCards,
  };
}

function quoteForClaim(envelope, claim) {
  const companyTargets = new Set(claim.targets.map((item) => item.toUpperCase()));
  if (claim.publishedAs === "ai_update") {
    const layer = envelope.aiChainPerformance.find(
      (item) => item.layer === claim.layer,
    );
    if (layer) return layer;
  }
  for (const sector of envelope.sectorPerformance) {
    const company = sector.constituents?.find((item) =>
      companyTargets.has(String(item.symbol).toUpperCase()),
    );
    if (company) return company;
  }
  const marketMetric = envelope.markets.find((item) =>
    claim.targets.some((target) =>
      [item.symbol, item.name]
        .filter(Boolean)
        .some(
          (value) =>
            String(value).trim().toLocaleLowerCase() ===
            String(target).trim().toLocaleLowerCase(),
        ),
    ),
  );
  if (marketMetric) return marketMetric;
  const sector = envelope.sectorPerformance.find(
    (item) =>
      claim.sectorSymbols.includes(item.symbol) ||
      claim.targets.includes(item.symbol),
  );
  if (sector) return sector;
  const preferred = envelope.market === "CN" ? ["SSE", "CSI300"] : ["SPX", "IXIC"];
  return preferred
    .map((symbol) => envelope.markets.find((item) => item.symbol === symbol))
    .find(Boolean) ?? envelope.markets[0];
}

export function marketEvidence(envelope, claim) {
  const quote = quoteForClaim(envelope, claim);
  if (!quote?.source) throw new Error(`${claim.id} 无法绑定确定性行情来源`);
  const action = quote.direction === "up" ? "上涨" : quote.direction === "down" ? "下跌" : "持平";
  return {
    title: `${quote.name ?? quote.symbol}收盘行情`,
    facts: `${quote.name ?? quote.symbol}本交易日收盘相较上一交易日${action}${quote.change ?? ""}。`,
    source: quote.source,
    sourceLabel: verifiedExternalSourceLabel(quote.source),
    publishedAt: envelope.session.windowEnd,
    kind: "market_data",
    sourceType: verifiedExternalSourceType(quote.source, "web"),
    platform: "web",
    authorHandle: "",
  };
}

function externalEvidence(source) {
  const comparisons = source.comparisons.map(publicComparison);
  const comparisonFacts = source.comparisons
    .map((comparison, index) => {
      const item = comparisons[index];
      const movement =
        comparison.actualValue > comparison.baselineValue
          ? "升至"
          : comparison.actualValue < comparison.baselineValue
            ? "降至"
            : "持平于";
      return `${item.label}：${item.baselineLabel}为${item.baseline}，${movement}${item.actual}，差额为${item.delta}。${item.note ? ` ${item.note}` : ""}`;
    })
    .join(" ");
  const publicFacts = source.facts
    .replace(/(?:该报道|该页面|来源正文)未提及[^。！？]*[。！？]?/gu, "")
    .replace(/The (?:report|page|source) (?:did not|does not) mention[^.]*\./giu, "")
    .trim();
  const title = readerText(source.title, "public evidence title", 4, 220);
  const facts = readerText(
    `${publicFacts}${comparisonFacts ? ` ${comparisonFacts}` : ""}`,
    "public evidence facts",
    20,
    2_000,
  );
  return {
    title,
    facts,
    source: source.url,
    sourceLabel: source.sourceLabel,
    publishedAt: source.publishedAt,
    kind: source.kind,
    sourceType: source.sourceType,
    platform: "web",
    authorHandle: "",
  };
}

function claimMap(cards) {
  return new Map(cards.map((item) => [item.id, item]));
}

export function assertFinancialCopyIncludesMetrics(copy, claim, label) {
  const claimRequiresComparisons = requiresFinancialComparisons(
    `${claim.title} ${claim.factSummary} ${claim.causalStatement ?? ""}`,
  );
  const copyRequiresComparisons = requiresFinancialComparisons(copy);
  if (!claimRequiresComparisons && !copyRequiresComparisons) return;
  if (claim.comparisons.length < 2) {
    throw new Error(`${label} 的财报或业绩表述缺少至少两项实际值与基准对比`);
  }
  for (const metric of claim.comparisons) {
    for (const value of [metric.actual, metric.baseline]) {
      const acceptedDisplays = [
        value,
        value.replace(/\s+per\s+share$/iu, ""),
      ];
      if (!acceptedDisplays.some((display) => copy.includes(display))) {
        throw new Error(`${label} 未展示财报对比值 ${value}`);
      }
    }
    if (!copy.includes(metric.delta)) {
      throw new Error(`${label} 未展示代码计算的财报差额 ${metric.delta}`);
    }
  }
}

function numericValueSet(value) {
  const quantitativeCopy = String(value).replace(
    /(?:S\s*[&＆]\s*P|标普)\s*500|(?:CSI|沪深)\s*300|(?:STAR|科创)\s*50|(?:NASDAQ|纳斯达克)\s*100|\b360\s+Security(?:\s+Technology)?\b|\b(?:Data|Headless)\s+360\b/giu,
    " ",
  );
  return new Set(
    [...quantitativeCopy.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?/gu)].map((match) =>
      String(Math.abs(Number(match[0].replaceAll(",", "")))),
    ),
  );
}

export function assertNumbersGrounded(copy, grounding, label) {
  const allowed = numericValueSet(grounding);
  for (const value of numericValueSet(copy)) {
    if (!allowed.has(value)) {
      throw new Error(`${label} 引用了未进入类型化事实字段的数字 ${value}`);
    }
  }
}

export function validateWriterDraft(value, cards, market, groundingByClaim = {}) {
  const draft = object(value, "writer draft");
  if (
    draft.contractVersion !== "stock-daily-market-draft-v1" ||
    draft.market !== market
  ) {
    throw new Error("读者成稿与市场不一致");
  }
  const cardsById = claimMap(cards);
  const drivers = Array.isArray(draft.drivers) ? draft.drivers : [];
  const updates = Array.isArray(draft.aiChainUpdates) ? draft.aiChainUpdates : [];
  const writtenIds = [...drivers, ...updates].map((item) => item.claimId);
  if (
    writtenIds.length !== cards.length ||
    new Set(writtenIds).size !== writtenIds.length ||
    writtenIds.some((id) => !cardsById.has(id))
  ) {
    throw new Error("读者成稿必须逐项覆盖已接受归因卡片");
  }
  function validateItem(raw, label, expectedType) {
    const item = object(raw, label);
    const claim = cardsById.get(item.claimId);
    if (!claim || claim.publishedAs !== expectedType) {
      throw new Error(`${label}.claimId 无效`);
    }
    const summary = readerText(item.summary, `${label}.summary`, 100, 220);
    const mechanism = readerText(
      expectedType === "market_driver" ? item.mechanism : item.implication,
      `${label}.mechanism`,
      100,
      220,
    );
    const title = readerText(
      item.title,
      `${label}.title`,
      5,
      expectedType === "market_driver" ? 80 : 90,
    );
    assertFinancialCopyIncludesMetrics(
      `${title} ${summary} ${mechanism}`,
      claim,
      label,
    );
    assertNumbersGrounded(
      `${title} ${summary} ${mechanism}`,
      `${JSON.stringify(claim)} ${groundingByClaim[claim.id] ?? ""}`,
      label,
    );
    const metricLabels = item.metrics ?? [];
    if (!Array.isArray(metricLabels) || metricLabels.length !== claim.comparisons.length) {
      throw new Error(`${label}.metrics 中文指标标签与比较项数量不一致：只为 claimCards 中此卡的 ${claim.comparisons.length} 项 comparisons 提供标签，收到 ${Array.isArray(metricLabels) ? metricLabels.length : "非数组"} 项；不得为 verifiedEvidence 中未附入此卡的比较项添加标签`);
    }
    const metrics = metricLabels.map((rawMetric, index) => {
      const metric = object(rawMetric, `${label}.metrics[${index}]`);
      const localized = {
        label: readerText(metric.label, `${label}.metrics[${index}].label`, 2, 40),
        baselineLabel: readerText(metric.baselineLabel, `${label}.metrics[${index}].baselineLabel`, 2, 24),
        note: metric.note?.trim() ? readerText(metric.note, `${label}.metrics[${index}].note`, 2, 180) : "",
      };
      for (const [field, copy] of Object.entries(localized)) {
        if (copy && !/\p{Script=Han}/u.test(copy)) {
          throw new Error(`${label}.metrics[${index}].${field} 必须使用中文指标标签`);
        }
      }
      assertNumbersGrounded(JSON.stringify(localized), `${JSON.stringify(claim.comparisons[index])} ${groundingByClaim[claim.id] ?? ""}`, `${label}.metrics[${index}]`);
      return { ...claim.comparisons[index], ...localized };
    });
    return {
      claimId: item.claimId,
      title,
      summary,
      metrics,
      ...(expectedType === "market_driver"
        ? { mechanism }
        : { implication: mechanism }),
    };
  }
  const marketView = object(draft.marketView, "marketView");
  const aiChainView = object(draft.aiChainView, "aiChainView");
  const marketDriverStatus = enumValue(
    marketView.driverStatus,
    ["explained", "partial", "insufficient"],
    "marketView.driverStatus",
  );
  const aiDriverStatus = enumValue(
    aiChainView.driverStatus,
    ["explained", "partial", "insufficient"],
    "aiChainView.driverStatus",
  );
  const result = {
    contractVersion: draft.contractVersion,
    market,
    overviewHeadline: readerText(
      draft.overviewHeadline,
      "overviewHeadline",
      8,
      100,
    ),
    overviewSummary: readerText(
      draft.overviewSummary,
      "overviewSummary",
      100,
      420,
    ),
    marketView: {
      headline: readerText(marketView.headline, "marketView.headline", 5, 90),
      summary: readerText(
        marketView.summary,
        "marketView.summary",
        marketDriverStatus === "insufficient" ? 12 : 80,
        360,
      ),
      driverStatus: marketDriverStatus,
    },
    aiChainView: {
      headline: readerText(aiChainView.headline, "aiChainView.headline", 5, 90),
      summary: readerText(
        aiChainView.summary,
        "aiChainView.summary",
        aiDriverStatus === "insufficient" ? 12 : 60,
        360,
      ),
      mechanism:
        typeof aiChainView.mechanism === "string" && aiChainView.mechanism.trim()
          ? readerText(aiChainView.mechanism, "aiChainView.mechanism", 80, 460)
          : null,
      driverStatus: aiDriverStatus,
    },
    drivers: drivers.map((item, index) =>
      validateItem(item, `drivers[${index}]`, "market_driver"),
    ),
    aiChainUpdates: updates.map((item, index) =>
      validateItem(item, `aiChainUpdates[${index}]`, "ai_update"),
    ),
  };
  if ((result.drivers.length === 0) !== (result.marketView.driverStatus === "insufficient")) {
    throw new Error("marketView.driverStatus 与市场归因数量不一致");
  }
  if ((result.aiChainUpdates.length === 0) !== (result.aiChainView.driverStatus === "insufficient")) {
    throw new Error("aiChainView.driverStatus 与 AI 归因数量不一致");
  }
  if (result.aiChainUpdates.length === 0 && result.aiChainView.mechanism !== null) {
    throw new Error("没有 AI 归因时不得输出 AI 机制");
  }
  if (
    result.aiChainView.driverStatus === "insufficient" &&
    ([...result.aiChainView.summary].length > 40 ||
      /\d/u.test(result.aiChainView.summary) ||
      !/暂无.{0,16}归因/u.test(result.aiChainView.summary))
  ) {
    throw new Error("没有 AI 归因时只能输出简短报告状态，不得复述行情或审核理由");
  }
  assertNumbersGrounded(
    [
      result.overviewHeadline,
      result.overviewSummary,
      result.marketView.headline,
      result.marketView.summary,
      result.aiChainView.headline,
      result.aiChainView.summary,
      result.aiChainView.mechanism ?? "",
    ].join(" "),
    cards
      .map(
        (claim) =>
          `${JSON.stringify(claim)} ${groundingByClaim[claim.id] ?? ""}`,
      )
      .join(" "),
    "读者成稿概览",
  );
  return result;
}

export function validateReview(value, cards, market) {
  const review = object(value, "review");
  if (
    review.contractVersion !== "stock-daily-market-review-v1" ||
    review.market !== market
  ) {
    throw new Error("独立复核与市场不一致");
  }
  if (!Array.isArray(review.claimReviews) || review.claimReviews.length !== cards.length) {
    throw new Error("独立复核必须逐项覆盖归因卡片");
  }
  const expected = new Set(cards.map((item) => item.id));
  const claimReviews = review.claimReviews.map((raw, index) => {
    const item = object(raw, `claimReviews[${index}]`);
    if (!expected.delete(item.claimId)) {
      throw new Error(`独立复核 claimId 无效或重复：${item.claimId}`);
    }
    const scores = object(item.scores, `${item.claimId}.scores`);
    const normalizedScores = Object.fromEntries(
      ["factualAccuracy", "causalLogic", "evidenceDirectness", "readerUtility"].map((key) => {
        const score = Number(scores[key]);
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          throw new Error(`${item.claimId}.${key} 必须为 1–5`);
        }
        return [key, score];
      }),
    );
    const itemVerdict = enumValue(
      item.verdict,
      ["pass", "revise"],
      `${item.claimId}.verdict`,
    );
    const defectCodes = stringArray(
      item.defectCodes,
      `${item.claimId}.defectCodes`,
      0,
      6,
    );
    const repairStage = enumValue(
      item.repairStage,
      ["none", "research", "adjudication", "writing"],
      `${item.claimId}.repairStage`,
    );
    const scoresPass = Object.values(normalizedScores).every(
      (score) => score >= 4,
    );
    if (
      (itemVerdict === "pass" &&
        (!scoresPass || defectCodes.length > 0 || repairStage !== "none")) ||
      (itemVerdict === "revise" &&
        (defectCodes.length === 0 || repairStage === "none"))
    ) {
      throw new Error(`${item.claimId} 的逐条判定、缺陷与返工阶段不一致`);
    }
    return {
      claimId: item.claimId,
      verdict: itemVerdict,
      defectCodes,
      repairStage,
      summary: text(item.summary, `${item.claimId}.summary`, 20, 500),
      scores: normalizedScores,
    };
  });
  const verdict = enumValue(review.verdict, ["pass", "revise"], "review.verdict");
  const allPass = claimReviews.every(
    (item) =>
      item.verdict === "pass" &&
      item.defectCodes.length === 0 &&
      item.repairStage === "none" &&
      Object.values(item.scores).every((score) => score >= 4),
  );
  if ((verdict === "pass") !== allPass) {
    throw new Error("独立复核总判定与逐条评分不一致");
  }
  return {
    contractVersion: review.contractVersion,
    market,
    verdict,
    summary: text(review.summary, "review.summary", 20, 600),
    claimReviews,
  };
}

export function validateTranslation(value, draft, cards, market) {
  const translation = object(value, "translation");
  if (
    translation.contractVersion !== "stock-daily-market-translation-v1" ||
    translation.market !== market
  ) {
    throw new Error("英文翻译与市场不一致");
  }
  const cardsById = claimMap(cards);
  function translatedItems(values, sourceItems, type) {
    if (!Array.isArray(values) || values.length !== sourceItems.length) {
      throw new Error(`英文 ${type} 数量与中文不一致`);
    }
    return values.map((raw, index) => {
      const item = object(raw, `translation.${type}[${index}]`);
      const source = sourceItems[index];
      if (item.claimId !== source.claimId) {
        throw new Error(`英文 ${type}[${index}] claimId 与中文不一致`);
      }
      const claim = cardsById.get(item.claimId);
      const title = readerText(
        item.title,
        `translation.${type}.title`,
        5,
        160,
      );
      const summary = readerText(
        item.summary,
        `translation.${type}.summary`,
        100,
        700,
      );
      const detail = readerText(
        type === "drivers" ? item.mechanism : item.implication,
        `translation.${type}.${type === "drivers" ? "mechanism" : "implication"}`,
        100,
        700,
      );
      if (
        !Array.isArray(item.metrics) ||
        item.metrics.length !== claim.comparisons.length
      ) {
        throw new Error(`英文 ${type}[${index}] 数据标签与比较项数量不一致`);
      }
      const metrics = item.metrics.map((rawMetric, metricIndex) => {
        const metric = object(
          rawMetric,
          `translation.${type}[${index}].metrics[${metricIndex}]`,
        );
        const sourceMetric = claim.comparisons[metricIndex];
        return {
          ...sourceMetric,
          label: readerText(
            metric.label,
            `translation.${type}[${index}].metrics[${metricIndex}].label`,
            2,
            40,
          ),
          baselineLabel: readerText(
            metric.baselineLabel,
            `translation.${type}[${index}].metrics[${metricIndex}].baselineLabel`,
            2,
            24,
          ),
          note:
            typeof metric.note === "string" && metric.note.trim()
              ? readerText(
                  metric.note,
                  `translation.${type}[${index}].metrics[${metricIndex}].note`,
                  1,
                  180,
                )
              : "",
        };
      });
      assertFinancialCopyIncludesMetrics(
        `${title} ${summary} ${detail}`,
        claim,
        `translation.${type}[${index}]`,
      );
      return {
        claimId: item.claimId,
        title,
        summary,
        metrics,
        ...(type === "drivers"
          ? { mechanism: detail }
          : { implication: detail }),
      };
    });
  }
  const marketView = object(translation.marketView, "translation.marketView");
  const aiChainView = object(translation.aiChainView, "translation.aiChainView");
  const result = {
    contractVersion: translation.contractVersion,
    market,
    overviewHeadline: readerText(
      translation.overviewHeadline,
      "translation.overviewHeadline",
      5,
      160,
    ),
    overviewSummary: readerText(
      translation.overviewSummary,
      "translation.overviewSummary",
      100,
      700,
    ),
    marketView: {
      headline: readerText(marketView.headline, "translation.marketView.headline", 5, 160),
      summary: readerText(marketView.summary, "translation.marketView.summary", 60, 600),
    },
    aiChainView: {
      headline: readerText(aiChainView.headline, "translation.aiChainView.headline", 5, 160),
      summary: readerText(aiChainView.summary, "translation.aiChainView.summary", 40, 600),
      mechanism:
        typeof aiChainView.mechanism === "string" && aiChainView.mechanism.trim()
          ? readerText(aiChainView.mechanism, "translation.aiChainView.mechanism", 60, 700)
          : null,
    },
    drivers: translatedItems(translation.drivers, draft.drivers, "drivers"),
    aiChainUpdates: translatedItems(
      translation.aiChainUpdates,
      draft.aiChainUpdates,
      "aiChainUpdates",
    ),
  };
  const englishCopy = [
      result.overviewHeadline,
      result.overviewSummary,
      result.marketView.headline,
      result.marketView.summary,
      result.aiChainView.headline,
      result.aiChainView.summary,
      result.aiChainView.mechanism ?? "",
      ...result.drivers.flatMap((item) => [
        item.title,
        item.summary,
        item.mechanism,
        ...item.metrics.flatMap((metric) => [
          metric.label,
          metric.baselineLabel,
          metric.note,
        ]),
      ]),
      ...result.aiChainUpdates.flatMap((item) => [
        item.title,
        item.summary,
        item.implication,
        ...item.metrics.flatMap((metric) => [
          metric.label,
          metric.baselineLabel,
          metric.note,
        ]),
      ]),
    ].join(" ");
  const comparisonDisplays = cards.flatMap((card) =>
    card.comparisons.flatMap((comparison) => [
      comparison.actual,
      comparison.baseline,
      comparison.delta,
    ]),
  );
  const proseWithoutSuppliedDisplays = comparisonDisplays.reduce(
    (copy, display) => copy.replaceAll(display, ""),
    englishCopy,
  );
  if (/\p{Script=Han}/u.test(proseWithoutSuppliedDisplays)) {
    throw new Error("英文翻译不得残留中文正文或中文计量单位");
  }
  const grounding = `${JSON.stringify(draft)} ${JSON.stringify(cards)}`;
  assertNumbersGrounded(
    englishCopy,
    grounding,
    "英文翻译",
  );
  return result;
}

function rawPreviousSlice(previous, market) {
  if (!previous) {
    return {
      marketView: {
        headline: market === "CN" ? "A 股暂无已验证复盘" : "美股暂无已验证复盘",
        summary:
          market === "CN"
            ? "当前没有可沿用的 A 股已验证市场归因，本期保持空缺。"
            : "当前没有可沿用的美股已验证市场归因，本期保持空缺。",
        driverStatus: "insufficient",
      },
      aiChainView: {
        headline: "AI 产业链暂无已验证复盘",
        summary: "当前没有可沿用的已验证 AI 产业链归因，本期保持空缺。",
        driverStatus: "insufficient",
        mechanism: null,
      },
      drivers: [],
      aiChainUpdates: [],
      translatedMarketView: {
        headline: market === "CN" ? "No verified China recap" : "No verified U.S. recap",
        summary: "No previously verified attribution is available to carry forward.",
      },
      translatedAiChainView: {
        headline: "No verified AI-chain recap",
        summary: "No previously verified AI-chain attribution is available to carry forward.",
        mechanism: null,
      },
      translatedDrivers: [],
      translatedAiChainUpdates: [],
    };
  }
  const drivers = (previous.drivers ?? []).filter((item) => item.market === market);
  const aiChainUpdates = (previous.aiChainUpdates ?? []).filter(
    (item) => item.market === market,
  );
  const driverIndexes = (previous.drivers ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.market === market)
    .map(({ index }) => index);
  const aiIndexes = (previous.aiChainUpdates ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.market === market)
    .map(({ index }) => index);
  return {
    marketView: {
      headline: previous.marketViews[market].headline,
      summary: previous.marketViews[market].summary,
      driverStatus: previous.marketViews[market].driverStatus,
    },
    aiChainView: {
      headline: previous.aiChainViews[market].headline,
      summary: previous.aiChainViews[market].summary,
      driverStatus: previous.aiChainViews[market].driverStatus,
      mechanism: previous.aiChainViews[market].mechanism ?? null,
    },
    drivers: drivers.map(({ id: _id, ...item }) => ({
      ...item,
      evidence: item.evidence.map(({ authority: _authority, ...evidence }) => evidence),
    })),
    aiChainUpdates: aiChainUpdates.map(({ id: _id, ...item }) => ({
      ...item,
      evidence: item.evidence.map(({ authority: _authority, ...evidence }) => evidence),
    })),
    translatedMarketView: previous.translations.en.marketViews[market],
    translatedAiChainView: previous.translations.en.aiChainViews[market],
    translatedDrivers: driverIndexes.map(
      (index) => previous.translations.en.drivers[index],
    ),
    translatedAiChainUpdates: aiIndexes.map(
      (index) => previous.translations.en.aiChainUpdates[index],
    ),
  };
}

function activeRawSlice(envelope, cards, ledger, draft, translation) {
  const sourceMap = new Map(ledger.sources.map((item) => [item.id, item]));
  const cardsById = claimMap(cards);
  function claimExternalEvidence(claim) {
    const byUrl = new Map();
    for (const id of claim.evidenceIds) {
      const source = sourceMap.get(id);
      const previous = byUrl.get(source.url);
      if (!previous) {
        byUrl.set(source.url, source);
        continue;
      }
      const preferred = source.role === "causal" ? source : previous;
      const comparisons = [...previous.comparisons, ...source.comparisons];
      byUrl.set(source.url, {
        ...preferred,
        facts: [...new Set([previous.facts, source.facts])].join(" "),
        comparisons: [
          ...new Map(comparisons.map((item) => [item.id, item])).values(),
        ],
      });
    }
    return [...byUrl.values()].map(externalEvidence);
  }
  const drivers = draft.drivers.map((item, index) => {
    const claim = cardsById.get(item.claimId);
    return {
      market: envelope.market,
      role: index === 0 ? "primary" : "secondary",
      basis: claim.basis,
      direction: claim.direction,
      attributionScope: claim.scope,
      attributionTargets: claim.targets,
      title: item.title,
      summary: item.summary,
      metrics: item.metrics ?? claim.comparisons,
      mechanism: item.mechanism,
      sectorSymbols: claim.sectorSymbols,
      evidence: [
        marketEvidence(envelope, claim),
        ...claimExternalEvidence(claim),
      ],
    };
  });
  const aiChainUpdates = draft.aiChainUpdates.map((item) => {
    const claim = cardsById.get(item.claimId);
    return {
      market: envelope.market,
      layer: claim.layer,
      title: item.title,
      summary: item.summary,
      metrics: item.metrics ?? claim.comparisons,
      implication: item.implication,
      evidence: [
        marketEvidence(envelope, claim),
        ...claimExternalEvidence(claim),
      ],
    };
  });
  return {
    marketView: draft.marketView,
    aiChainView: draft.aiChainView,
    drivers,
    aiChainUpdates,
    translatedMarketView: translation.marketView,
    translatedAiChainView: translation.aiChainView,
    translatedDrivers: translation.drivers.map(({ claimId: _claimId, ...item }, index) => ({
      ...item,
      metrics: item.metrics ?? drivers[index]?.metrics ?? [],
    })),
    translatedAiChainUpdates: translation.aiChainUpdates.map(
      ({ claimId: _claimId, ...item }, index) => ({
        ...item,
        metrics: item.metrics ?? aiChainUpdates[index]?.metrics ?? [],
      }),
    ),
  };
}

function trimCharacters(value, max) {
  return [...value].slice(0, max).join("").trim();
}

export function trimReaderSummary(value, max) {
  const copy = String(value).trim();
  if ([...copy].length <= max) return copy;
  let complete = "";
  for (const { segment } of new Intl.Segmenter("en", { granularity: "sentence" }).segment(copy)) {
    if ([...complete, ...segment.trimEnd()].length > max) break;
    complete += segment;
  }
  if (complete.trim()) return complete.trim();
  // An unusually long single sentence still needs an explicit truncation mark
  // and must never leave half an English word in reader-facing metadata.
  return `${trimCharacters(copy, max - 1).replace(/[A-Za-z0-9][A-Za-z0-9'-]*$/u, "").trimEnd()}…`;
}

export function mergeMarketReport(
  input,
  activeMarket,
  previousReport,
  cards,
  ledger,
  draft,
  translation,
) {
  const envelope = marketEnvelope(input, activeMarket);
  const active = activeRawSlice(
    envelope,
    cards,
    ledger,
    draft,
    translation,
  );
  const slices = Object.fromEntries(
    MARKETS.map((market) => [
      market,
      market === activeMarket
        ? active
        : rawPreviousSlice(previousReport, market),
    ]),
  );
  const inactiveMarket = activeMarket === "CN" ? "US" : "CN";
  const inactive = slices[inactiveMarket];
  const headline = trimCharacters(
    `${draft.overviewHeadline}；${inactive.marketView.headline}`,
    100,
  );
  const summary = trimReaderSummary(
    `${draft.overviewSummary} ${inactive.marketView.summary}`,
    420,
  );
  const headlineEn = trimCharacters(
    `${translation.overviewHeadline}; ${inactive.translatedMarketView.headline}`,
    140,
  );
  const summaryEn = trimReaderSummary(
    `${translation.overviewSummary} ${inactive.translatedMarketView.summary}`,
    500,
  );
  const drivers = MARKETS.flatMap((market) => slices[market].drivers);
  const aiChainUpdates = MARKETS.flatMap(
    (market) => slices[market].aiChainUpdates,
  );
  return {
    contractVersion: "codex-market-research-v11",
    workflowOverview: {
      market: activeMarket,
      headline: draft.overviewHeadline,
      summary: draft.overviewSummary,
      headlineEn: translation.overviewHeadline,
      summaryEn: translation.overviewSummary,
    },
    headline,
    summary,
    marketViews: Object.fromEntries(
      MARKETS.map((market) => [market, slices[market].marketView]),
    ),
    aiChainViews: Object.fromEntries(
      MARKETS.map((market) => [market, slices[market].aiChainView]),
    ),
    drivers,
    aiChainUpdates,
    translations: {
      en: {
        headline: headlineEn,
        summary: summaryEn,
        marketViews: Object.fromEntries(
          MARKETS.map((market) => [
            market,
            slices[market].translatedMarketView,
          ]),
        ),
        aiChainViews: Object.fromEntries(
          MARKETS.map((market) => [
            market,
            slices[market].translatedAiChainView,
          ]),
        ),
        drivers: MARKETS.flatMap(
          (market) => slices[market].translatedDrivers,
        ),
        aiChainUpdates: MARKETS.flatMap(
          (market) => slices[market].translatedAiChainUpdates,
        ),
      },
    },
  };
}

export function auditWorkflowManifest(manifest, reportText) {
  const value = object(manifest, "workflow manifest");
  if (
    value.workflowVersion !== WORKFLOW_VERSION ||
    value.status !== "ready" ||
    !MARKETS.includes(value.market)
  ) {
    throw new Error("多 Agent 工作流尚未达到发布状态");
  }
  if (value.reportHash !== stableHash(reportText)) {
    throw new Error("发布报告与工作流清单哈希不一致");
  }
  if (!Array.isArray(value.agentRuns) || value.agentRuns.length < 7) {
    throw new Error("独立 Agent 阶段记录不完整");
  }
  const runIds = value.agentRuns.map((item) => item.agentRunId);
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("Agent 运行必须使用相互隔离的独立进程");
  }
  const roles = new Set(value.agentRuns.map((item) => item.role));
  for (const role of [
    "planner",
    "facts",
    "causal",
    "adjudicator",
    "writer",
    "reviewer",
    "translator",
  ]) {
    if (!roles.has(role)) throw new Error(`缺少独立 ${role} Agent`);
  }
  if (
    value.agentRuns.some(
      (item) =>
        item.ephemeral !== true ||
        item.filesystemIsolation !== AGENT_FILESYSTEM_ISOLATION ||
        item.status !== "completed" ||
        !item.promptHash ||
        !item.outputHash,
    )
  ) {
    throw new Error("Agent 隔离或完成记录无效");
  }
  const reviewerRuns = value.agentRuns.filter((item) => ["reviewer", "recap_reviewer"].includes(item.role));
  if (
    reviewerRuns.some((item) =>
      (item.inputArtifacts ?? []).some((path) => /events|prompt/iu.test(path)),
    )
  ) {
    throw new Error("Reviewer 不得读取 Writer 对话或事件流");
  }
  if (!value.evidence || value.evidence.verifiedSourceCount < 2 || value.evidence.rejectedSourceCount < 0) {
    throw new Error("工作流证据验证记录不完整");
  }
  const approval = object(value.approval, "workflow approval");
  if (
    approval.verdict !== "pass" ||
    approval.reviewArtifact !== "artifacts/review-final.json" ||
    typeof approval.reviewHash !== "string" ||
    approval.reviewHash.length !== 64 ||
    !Array.isArray(approval.claimIds) ||
    approval.claimIds.length !== value.claimCount ||
    !Array.isArray(approval.scores) ||
    approval.scores.length !== value.claimCount ||
    approval.scores.some((item) =>
      [
        item?.factualAccuracy,
        item?.causalLogic,
        item?.evidenceDirectness,
        item?.readerUtility,
      ].some((score) => !Number.isInteger(score) || score < 4 || score > 5),
    )
  ) {
    throw new Error("最终 Reviewer 批准记录不完整");
  }
  return {
    status: "audited",
    market: value.market,
    agentRunCount: value.agentRuns.length,
    verifiedSourceCount: value.evidence.verifiedSourceCount,
    minimumReviewScore: Math.min(
      ...approval.scores.flatMap((item) => [
        item.factualAccuracy,
        item.causalLogic,
        item.evidenceDirectness,
        item.readerUtility,
      ]),
    ),
  };
}
