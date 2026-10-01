const INDEX_NAMES = {
  SPX: ["S&P 500", "Standard & Poor’s 500", "Standard & Poor's 500", "Standard and Poor's 500"],
  IXIC: ["Nasdaq Composite", "Nasdaq composite", "Nasdaq"],
  DJI: ["Dow Jones Industrial Average", "Dow Jones industrial average", "Dow Jones", "Dow"],
};
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const number = value => Number(String(value).replaceAll(",", ""));
const precision = value => 0.5 * 10 ** -(value.split(".")[1]?.length ?? 0);
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function localDay(value, zone) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value ?? "")) return value;
  if (!Number.isFinite(Date.parse(value))) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).map(item => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function assertAccessibleOriginalArticle(opened) {
  const host = new URL(opened.finalUrl).hostname;
  // This is the article's explicit truncation prompt, not Yahoo's general
  // subscription links. A 200 response with only a teaser is not a full read.
  if ((host === "finance.yahoo.com" || host.endsWith(".finance.yahoo.com")) && /Upgrade to read this [^.\n]{1,100} article\s+and get so much more\./iu.test(opened.text)) throw new Error("来源正文需订阅，当前可访问内容不足以核查引文");
}

export function assertSessionClosingClaims(text, envelope, publishedAt) {
  if (envelope.market !== "US" || localDay(publishedAt, "America/New_York") !== envelope.marketAsOf) return [];
  const expected = new Map(envelope.markets.filter(item => INDEX_NAMES[item.symbol] && item.asOf === envelope.marketAsOf).map(item => [item.symbol, item]));
  const currentWeekday = weekdays[new Date(`${envelope.marketAsOf}T12:00:00Z`).getUTCDay()];
  const claims = [];
  for (const paragraph of String(text).split(/\n+/u)) {
    if (!/\b(?:at (?:the )?closing bell|all told|at (?:the )?close)\b/iu.test(paragraph) || /\b(?:forecast|expected|could|would|tomorrow)\b/iu.test(paragraph)) continue;
    const explicitDays = paragraph.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gu) ?? [];
    const explicitDates = paragraph.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
    if (explicitDays.some(day => day !== currentWeekday) || explicitDates.some(day => day !== envelope.marketAsOf)) continue;
    const aliases = Object.entries(INDEX_NAMES).flatMap(([symbol, values]) => values.map((value, index) => `(?<${symbol}_${index}>${escape(value)})`)).join("|");
    const names = [...paragraph.matchAll(new RegExp(`(?<![A-Za-z0-9])(?:${aliases})(?![A-Za-z0-9])`, "giu"))];
    for (let i = 0; i < names.length; i++) {
      const name = names[i], symbol = Object.keys(name.groups).find(key => name.groups[key] != null)?.split("_")[0];
      const reference = expected.get(symbol);
      if (!reference) continue;
      const clause = paragraph.slice(name.index + name[0].length, names[i + 1]?.index ?? paragraph.length);
      if (/^\s*(?:100\b|futures\b|-?listed\b|Inc\b|Chemical\b|Transportation\b|Utility\b|shares\b|stock\b)/iu.test(clause)) continue;
      const move = /\b(?:was |had |is |has )?(down|up|fell|fallen|dropped|declined|slipped|rose|gained|lower|higher)\s+(?:by\s+)?([+-]?\d[\d,]*(?:\.\d+)?)\s*%/iu.exec(clause);
      if (move) {
        const sign = /^(?:up|rose|gained|higher)$/iu.test(move[1]) ? 1 : -1;
        const actual = number(reference.change.replace("%", ""));
        if (!Number.isFinite(actual)) throw new Error("核验收盘报道缺少确定性指数涨跌幅");
        const reported = sign * Math.abs(number(move[2]));
        if (Math.abs(reported - actual) > precision(move[2]) + 0.005 + 1e-9) throw new Error(`${symbol} 当日收盘报道涨跌幅与已核验行情矛盾：${reported}% 对照 ${reference.change}`);
        claims.push({ symbol, field: "change", reported, actual });
      }
      const close = /\b(?:to|at|close at|closed at|settled at)\s+([0-9][\d,]*(?:\.\d+)?)(?!\d|[,.]\d)/iu.exec(clause);
      if (close && !/^\s*%/u.test(clause.slice(close.index + close[0].length))) {
        const actual = number(reference.value), reported = number(close[1]);
        if (!Number.isFinite(actual)) throw new Error("核验收盘报道缺少确定性指数收盘值");
        if (Math.abs(reported - actual) > precision(close[1]) + 0.01 + 1e-9) throw new Error(`${symbol} 当日收盘报道点位与已核验行情矛盾：${reported} 对照 ${reference.value}`);
        claims.push({ symbol, field: "close", reported, actual });
      }
    }
  }
  return claims;
}
