import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKET_QUERY_PATTERNS = {
  CN: /(?:A股|上证|深证|沪深|创业板|科创|中国股市|China(?:ese)? stocks?)/iu,
  US: /(?:美股|美国股市|华尔街|标普|纳斯达克|道琼斯|Wall Street|U\.?S\.? stocks?|S&P|Nasdaq|Dow Jones|NYSE)/iu,
};

function parseEvents(text) {
  const events = [];
  for (const line of String(text).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error("独立复盘事件流包含无法解析的记录");
    }
  }
  return events;
}

function normalizedQuery(value) {
  return String(value)
    .trim()
    .replace(/^site:\S+\s+/iu, "")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function queryMarket(query) {
  const matches = Object.entries(MARKET_QUERY_PATTERNS)
    .filter(([, pattern]) => pattern.test(query))
    .map(([market]) => market);
  return matches.length === 1 ? matches[0] : null;
}

function searchQueries(item) {
  if (item?.action?.type !== "search") return [];
  const values = Array.isArray(item?.action?.queries)
    ? item.action.queries
    : [item?.action?.query, item?.query];
  return values.filter((value) => typeof value === "string" && value.trim());
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function citedExternalSources(report) {
  return [
    ...new Set(
      [
        ...(Array.isArray(report?.drivers) ? report.drivers : []),
        ...(Array.isArray(report?.aiChainUpdates) ? report.aiChainUpdates : []),
      ]
        .flatMap((item) => (Array.isArray(item?.evidence) ? item.evidence : []))
        .filter((evidence) => evidence?.kind !== "market_data")
        .map((evidence) => normalizedUrl(evidence?.source))
        .filter(Boolean),
    ),
  ];
}

export function auditIndependentReview(eventsText, review, report) {
  const events = parseEvents(eventsText);
  if (events.some((event) => event.type === "turn.failed" || event.type === "error")) {
    throw new Error("独立复盘运行包含失败事件");
  }
  if (!events.some((event) => event.type === "turn.completed")) {
    throw new Error("独立复盘运行没有完成事件");
  }
  const webItems = events
    .filter(
      (event) => event.type === "item.completed" && event.item?.type === "web_search",
    )
    .map((event) => event.item);
  const actualQueries = [...new Set(webItems.flatMap(searchQueries))];
  const normalizedActual = new Set(actualQueries.map(normalizedQuery));
  const researcherQueries = new Set(
    ["CN", "US"]
      .flatMap((market) => report?.researchAudit?.[market]?.queries ?? [])
      .map(normalizedQuery),
  );
  for (const market of ["CN", "US"]) {
    const declared = review?.reviewAudit?.[market]?.queries;
    if (!Array.isArray(declared) || declared.length < 1 || declared.length > 6) {
      throw new Error(`${market} 独立复盘查询缺失`);
    }
    for (const query of declared) {
      const normalized = normalizedQuery(query);
      if (!normalizedActual.has(normalized)) {
        throw new Error(`${market} 独立复盘声明了未实际执行的查询`);
      }
      if (researcherQueries.has(normalized)) {
        throw new Error(`${market} 独立复盘不得原样复制研究查询`);
      }
      if (queryMarket(query) !== market) {
        throw new Error(`${market} 独立复盘查询缺少唯一、明确的市场标记`);
      }
    }
  }
  const citedSources = citedExternalSources(report);
  const sourceOpenActions = webItems.filter(
    (item) => item?.action?.type !== "search",
  );
  // Codex records direct page opens as `other` actions, but the event stream does
  // not consistently expose the final URL after a search-result click. Require at
  // least one auditable open action per cited source; the separate source audit
  // still verifies each exact URL at the publication boundary.
  if (sourceOpenActions.length < citedSources.length) {
    throw new Error(
      `独立复盘打开来源数量不足：需要 ${citedSources.length}，实际 ${sourceOpenActions.length}`,
    );
  }
  return {
    status: "audited",
    queryCount: actualQueries.length,
    openedSourceCount: sourceOpenActions.length,
  };
}

async function main() {
  const eventsPath = resolve(process.argv[2] ?? "work/daily-review-events.jsonl");
  const reviewPath = resolve(process.argv[3] ?? "work/daily-review.json");
  const reportPath = resolve(process.argv[4] ?? "work/daily-report.json");
  const [eventsText, review, report] = await Promise.all([
    readFile(eventsPath, "utf8"),
    readFile(reviewPath, "utf8").then(JSON.parse),
    readFile(reportPath, "utf8").then(JSON.parse),
  ]);
  console.log(JSON.stringify(auditIndependentReview(eventsText, review, report), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
