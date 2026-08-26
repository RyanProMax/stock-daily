import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKET_QUERY_PATTERNS = {
  CN: /(?:A股|上证|深证|沪深|创业板|科创|中国股市|China(?:ese)? stocks?)/iu,
  US: /(?:美股|美国股市|华尔街|标普|纳斯达克|道琼斯|Wall Street|U\.?S\.? stocks?|S&P|Nasdaq|Dow Jones|NYSE)/iu,
};
const AI_QUERY_PATTERN =
  /(?:AI|人工智能|智能产业链|算力|芯片|存储|服务器|CPO|光互连|数据中心|云计算|NeoCloud|应用软件|机器人|artificial intelligence|semiconductor|memory|server|interconnect|data cent(?:er|re)|cloud|software|robot)/iu;
const CAUSE_QUERY_PATTERN =
  /(?:原因|催化|公告|财报|订单|供需|政策|业绩|why|reason|catalyst|filing|earnings|order|demand|supply|policy)/iu;

function queryMarket(query) {
  const matches = Object.entries(MARKET_QUERY_PATTERNS)
    .filter(([, pattern]) => pattern.test(query))
    .map(([market]) => market);
  return matches.length === 1 ? matches[0] : null;
}

function parseEventLines(text) {
  const events = [];
  let invalidLineCount = 0;
  const lines = String(text)
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      invalidLineCount += 1;
    }
  }
  return { events, invalidLineCount };
}

function searchQueries(item) {
  const actionQueries = Array.isArray(item?.action?.queries)
    ? item.action.queries
    : [];
  const values = actionQueries.length > 0
    ? actionQueries
    : item?.action?.type === "other"
      ? []
      : [item?.action?.query, item?.query];
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function normalizedQuery(value) {
  return String(value)
    .trim()
    .replace(/^site:\S+\s+/iu, "")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function citedExternalSources(report, market) {
  const items = [
    ...(Array.isArray(report?.drivers) ? report.drivers : []),
    ...(Array.isArray(report?.aiChainUpdates) ? report.aiChainUpdates : []),
  ];
  return new Set(
    items
      .filter((item) => item?.market === market)
      .flatMap((item) => (Array.isArray(item?.evidence) ? item.evidence : []))
      .filter((evidence) => evidence?.kind !== "market_data")
      .map((evidence) => evidence?.source)
      .filter((source) => typeof source === "string" && source.trim()),
  );
}

export function auditCodexRun(eventsText, report) {
  const { events, invalidLineCount } = parseEventLines(eventsText);
  if (invalidLineCount > 0) {
    throw new Error("Codex 研究事件流包含无法解析的记录");
  }
  if (events.some((event) => event.type === "turn.failed" || event.type === "error")) {
    throw new Error("Codex 研究运行包含失败事件");
  }
  if (!events.some((event) => event.type === "turn.completed")) {
    throw new Error("Codex 研究运行没有完成事件");
  }

  const searchItems = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "web_search",
    )
    .map((event) => event.item);
  const queryBatches = searchItems.map(searchQueries).filter((items) => items.length);
  const queries = [...new Set(queryBatches.flat())];
  if (queryBatches.length < 2 || queries.length < 8) {
    throw new Error("Codex 未执行足够的原生网页搜索");
  }

  const classifiedQueries = queries.map((query) => ({
    query,
    market: queryMarket(query),
  }));
  const coverageCounts = Object.fromEntries(
    Object.keys(MARKET_QUERY_PATTERNS).map((market) => [
      market,
      classifiedQueries.filter((item) => item.market === market).length,
    ]),
  );
  if (coverageCounts.CN < 4 || coverageCounts.US < 4) {
    throw new Error("Codex 原生网页搜索必须分别执行至少四条 CN 与 US 查询");
  }
  for (const market of ["CN", "US"]) {
    const aiCauseQueries = classifiedQueries.filter(
      (item) =>
        item.market === market &&
        AI_QUERY_PATTERN.test(item.query) &&
        CAUSE_QUERY_PATTERN.test(item.query),
    );
    if (aiCauseQueries.length < 2) {
      throw new Error(
        `${market} 必须至少执行两条同时包含 AI 对象与原因线索的主动归因查询`,
      );
    }
  }

  const normalizedQueries = new Set(queries.map(normalizedQuery));
  const marketsWithExternalEvidence = Object.fromEntries(
    ["CN", "US"].map((market) => [
      market,
      citedExternalSources(report, market),
    ]),
  );
  for (const market of ["CN", "US"]) {
    const declared = report?.researchAudit?.[market];
    if (
      !declared ||
      !Array.isArray(declared.queries) ||
      declared.queries.length < 4 ||
      !Number.isInteger(declared.sourcesReviewed) ||
      declared.sourcesReviewed < 1 ||
      !["sufficient", "limited"].includes(declared.outcome)
    ) {
      throw new Error(`${market} 研究审计字段不完整`);
    }
    if (
      declared.queries.some(
        (query) => !normalizedQueries.has(normalizedQuery(query)),
      )
    ) {
      throw new Error(`${market} 研究审计声明了未实际执行的查询`);
    }
    const declaredQueryMarkets = declared.queries.map(queryMarket);
    if (
      declaredQueryMarkets.some(
        (declaredMarket) => declaredMarket && declaredMarket !== market,
      ) ||
      declaredQueryMarkets.filter((declaredMarket) => declaredMarket === market)
        .length < 4
    ) {
      throw new Error(`${market} 研究审计查询缺少唯一、明确的市场标记`);
    }
    if (declared.sourcesReviewed < marketsWithExternalEvidence[market].size) {
      throw new Error(`${market} 查看来源数量少于报告实际引用数量`);
    }
  }

  return {
    status: "audited",
    searchEventCount: queryBatches.length,
    queryCount: queries.length,
    coverage: coverageCounts,
    queries,
  };
}

async function main() {
  const eventsPath = resolve(process.argv[2] ?? "work/daily-agent-events.jsonl");
  const reportPath = resolve(process.argv[3] ?? "work/daily-report.json");
  const [eventsText, report] = await Promise.all([
    readFile(eventsPath, "utf8"),
    readFile(reportPath, "utf8").then(JSON.parse),
  ]);
  console.log(JSON.stringify(auditCodexRun(eventsText, report), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
