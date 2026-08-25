const MARKET_SESSION_CONFIG = {
  CN: { symbol: "SSE", closeHour: 15, timeZone: "Asia/Shanghai" },
  US: { symbol: "SPX", closeHour: 16, timeZone: "America/New_York" },
};

const WRAP_PATTERN =
  /收评|收盘|盘后|复盘|market wrap|market recap|(?:stocks?|indexes?|wall street).{0,50}(?:closed|ended|finished)/i;
const MARKET_MOVE_PATTERN =
  /(?:指数|股指|板块|sector|s&p|nasdaq|dow|创业板|上证|深证).{0,40}(?:[+-]?\d+(?:\.\d+)?%|上涨|下跌|收涨|收跌|走强|走弱|rose|fell|gained|slid)/i;
const INTRADAY_WRAP_PATTERN =
  /午间|半日|早盘|盘中|开盘|午盘|morning (?:trade|session)|midday|intraday|opening bell|market open/i;
const FOREIGN_US_WRAP_PATTERN =
  /加拿大股市|多伦多证交所|标普\/多伦多|\bcanadian (?:stocks?|shares?|market)\b|\btoronto stock exchange\b|\btsx\b/i;
const LOCAL_WRAP_PATTERN = {
  CN: /\ba[- ]?shares?\b|A股|上证|沪指|深证|创业板|科创板|沪深\s*300|中国股市/i,
  US: /\bu\.?s\.? stocks?\b|美股|华尔街|标普(?:\s*500)?|纳斯达克|道琼斯|\bwall street\b|\bs&p(?: 500)?\b|\bnasdaq\b|\bdow(?: jones)?\b/i,
};
const CAUSAL_EVENT_PATTERN =
  /宣布|公告|发布(?:政策|报告|财报|业绩|数据|决定)|出台|获批|批准|签署|上调|下调|加息|降息|关税|制裁|出口管制|订单|中标|营收|净利润|业绩|指引|预增|预亏|产量|减产|停产|供应|需求|库存|通胀|就业|非农|采购经理|\b(?:announc|report|approv|sign|rais|cut|tariff|sanction|export control|order|contract|revenue|earnings|profit|guidance|output|production|supply|demand|inventory|inflation|payroll|employment|pmi|gdp|cpi|ppi)\w*\b/i;

function newsText(item) {
  const facts = Array.isArray(item.facts) ? item.facts.join(" ") : item.facts ?? "";
  return `${item.title ?? ""} ${facts}`;
}

function wallTimeParts(timestamp, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

export function zonedDateTimeIso(date, hour, timeZone) {
  const [year, month, day] = String(date).split("-").map(Number);
  if (![year, month, day, hour].every(Number.isFinite)) {
    throw new Error(`Invalid market session date: ${date}`);
  }
  const desiredUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  let timestamp = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = wallTimeParts(timestamp, timeZone);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    timestamp += desiredUtc - actualUtc;
  }
  return new Date(timestamp).toISOString();
}

export function buildMarketSessions(markets) {
  return Object.entries(MARKET_SESSION_CONFIG).map(([market, config]) => {
    const metric = markets.find(
      (item) => (item.market ?? item.region) === market && item.symbol === config.symbol,
    );
    if (!metric?.asOf || !metric?.previousAsOf) {
      throw new Error(`${market} market session is missing asOf or previousAsOf`);
    }
    const windowStart = zonedDateTimeIso(
      metric.previousAsOf,
      config.closeHour,
      config.timeZone,
    );
    const windowEnd = zonedDateTimeIso(metric.asOf, config.closeHour, config.timeZone);
    return {
      market,
      asOf: metric.asOf,
      previousAsOf: metric.previousAsOf,
      windowStart,
      windowEnd,
      wrapDeadline: new Date(Date.parse(windowEnd) + 2 * 60 * 60 * 1_000).toISOString(),
    };
  });
}

export function classifyNewsKind(item) {
  const text = newsText(item);
  return WRAP_PATTERN.test(text) && MARKET_MOVE_PATTERN.test(text)
    ? "market_wrap"
    : "event";
}

export function evidenceFitsSession(item, session) {
  const publishedAt = Date.parse(item?.publishedAt ?? "");
  if (!Number.isFinite(publishedAt)) return false;
  const start = Date.parse(session.windowStart);
  const close = Date.parse(session.windowEnd);
  const end = Date.parse(
    item.kind === "market_wrap" ? session.wrapDeadline : session.windowEnd,
  );
  return (
    publishedAt > start &&
    publishedAt <= end &&
    (item.kind !== "market_wrap" || publishedAt >= close)
  );
}

export function filterNewsToMarketSessions(items, sessions) {
  return items
    .map((item) => {
      const kind = item.kind ?? classifyNewsKind(item);
      return {
        ...item,
        kind,
        regions: (item.regions ?? []).filter((market) => {
          const session = sessions.find((candidate) => candidate.market === market);
          return session ? evidenceFitsSession({ ...item, kind }, session) : false;
        }),
      };
    })
    .filter((item) => item.regions.length > 0);
}

export function sectorExtremes(performance, market, limit = 3) {
  const rows = performance.filter((item) => item.market === market);
  const leaders = rows
    .filter((item) => Number.parseFloat(item.change) > 0)
    .sort((left, right) => Number.parseFloat(right.change) - Number.parseFloat(left.change))
    .slice(0, limit);
  const laggards = rows
    .filter((item) => Number.parseFloat(item.change) < 0)
    .sort((left, right) => Number.parseFloat(left.change) - Number.parseFloat(right.change))
    .slice(0, limit);
  return { leaders, laggards };
}

export function driverDirectionMatches(direction, sectorSymbols, performance) {
  if (direction === "mixed") return sectorSymbols.length > 0;
  return sectorSymbols.some((symbol) => {
    const change = Number.parseFloat(
      performance.find((item) => item.symbol === symbol)?.change ?? "NaN",
    );
    return direction === "positive" ? change > 0 : change < 0;
  });
}

export function localMarketWrapMatches(
  item,
  market,
  _sectors = [],
  session,
) {
  if (item.kind !== "market_wrap") return false;
  const title = String(item.title ?? "");
  const text = newsText(item);
  if (INTRADAY_WRAP_PATTERN.test(title)) return false;
  if (market === "US" && FOREIGN_US_WRAP_PATTERN.test(title)) return false;
  if (!LOCAL_WRAP_PATTERN[market]?.test(text)) return false;
  return session ? evidenceFitsSession(item, session) : true;
}

export function causalEventEvidenceMatches(item) {
  if (item?.kind !== "event") return false;
  return CAUSAL_EVENT_PATTERN.test(newsText(item));
}
