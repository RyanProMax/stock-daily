const marketDate = (time, zone) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }).format(new Date(time));
const finitePositive = value => typeof value === "number" && Number.isFinite(value) && value > 0;

// A daily candle with a missing close cannot borrow a generic current price.
// Only the same response's identified regular-session closing quote can
// establish it. Open/high/low/volume and all historical bars remain untouched.
export function yahooClosingQuote(result, symbol, { cutoffTime, fetchedAt, expectedDate = null } = {}) {
  const meta = result?.meta, regular = meta?.currentTradingPeriod?.regular;
  const zone = meta?.exchangeTimezoneName;
  if (meta?.symbol !== symbol || !["America/New_York", "Asia/Shanghai"].includes(zone) || !["EQUITY", "ETF", "INDEX"].includes(meta.instrumentType)) return null;
  if (![regular?.start, regular?.end, meta.regularMarketTime].every(Number.isSafeInteger) || !finitePositive(meta.regularMarketPrice) || !Number.isFinite(cutoffTime) || !Number.isFinite(fetchedAt)) return null;
  const start = regular.start * 1000, end = regular.end * 1000, traded = meta.regularMarketTime * 1000;
  if (start >= end || end - start > 8 * 3600000 || end > cutoffTime || end > fetchedAt || traded < end || traded > end + 5 * 60000 || traded > fetchedAt || traded > cutoffTime + 5 * 60000) return null;
  const date = marketDate(start, zone);
  if (marketDate(end, zone) !== date || marketDate(traded, zone) !== date || (expectedDate && date !== expectedDate)) return null;
  const timestamps = result.timestamp, quote = result.indicators?.quote?.[0];
  if (!Array.isArray(timestamps) || !Array.isArray(quote?.close) || timestamps.length !== quote.close.length || !timestamps.every(Number.isSafeInteger) || new Set(timestamps).size !== timestamps.length) return null;
  const indices = timestamps.map((time, index) => ({ time: time * 1000, index })).filter(item => marketDate(item.time, zone) === date);
  if (indices.length !== 1 || indices[0].time !== start || indices[0].index !== timestamps.length - 1 || quote.close[indices[0].index] !== null) return null;
  if (![quote.open?.[indices[0].index], quote.high?.[indices[0].index], quote.low?.[indices[0].index]].every(finitePositive)) return null;
  const index = indices[0].index, high = quote.high[index], low = quote.low[index], price = meta.regularMarketPrice;
  if (low > Math.min(quote.open[index], price) || high < Math.max(quote.open[index], price) || low > high) return null;
  return { index, date, close: price, quoteTime: new Date(traded).toISOString(), sessionClose: new Date(end).toISOString(), basis: "identified_regular_session_closing_quote", version: "verified-yahoo-closing-quote-v1" };
}
