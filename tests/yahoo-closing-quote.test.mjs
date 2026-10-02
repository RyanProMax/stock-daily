import assert from "node:assert/strict";
import test from "node:test";
import { yahooClosingQuote } from "../scripts/yahoo-closing-quote.mjs";
import { yahooEquityConstituent } from "../scripts/ai-chain.mjs";

const second = iso => Date.parse(iso) / 1000;
const options = { cutoffTime: Date.parse("2026-10-01T22:00:00Z"), fetchedAt: Date.parse("2026-10-02T00:00:00Z"), expectedDate: "2026-10-01" };
function fixture() {
  return { meta: { symbol: "META", instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York", regularMarketTime: second("2026-10-01T20:00:01Z"), regularMarketPrice: 725.93, currentTradingPeriod: { regular: { start: second("2026-10-01T13:30:00Z"), end: second("2026-10-01T20:00:00Z") } } }, timestamp: [second("2026-09-30T13:30:00Z"), second("2026-10-01T13:30:00Z")], indicators: { quote: [{ close: [725.18, null], open: [720, 728.525], high: [730, 735.88], low: [710, 721.51], volume: [100, 200] }] } };
}

test("only a missing final candle can use its same-day, post-close regular quotation", () => {
  const result = fixture(), before = structuredClone(result), record = yahooClosingQuote(result, "META", options);
  assert.equal(record.close, 725.93); assert.equal(record.index, 1); assert.equal(record.date, "2026-10-01"); assert.equal(record.quoteTime, "2026-10-01T20:00:01.000Z");
  assert.deepEqual(result, before, "the original response is never filled in or rewritten");
});

test("a different session, instrument, time, symbol or inconsistent range cannot fill the missing close", () => {
  const mutations = [r => r.meta.symbol = "OTHER", r => r.meta.instrumentType = "CRYPTOCURRENCY", r => r.meta.exchangeTimezoneName = "UTC", r => r.meta.regularMarketPrice = -1, r => r.meta.regularMarketPrice = "725.93", r => r.meta.regularMarketTime = second("2026-10-01T19:59:59Z"), r => r.meta.regularMarketTime = second("2026-10-01T20:05:01Z"), r => r.meta.regularMarketTime = second("2026-10-02T00:00:00Z"), r => r.meta.currentTradingPeriod.regular.end = second("2026-10-02T20:00:00Z"), r => r.timestamp[1] += 60, r => r.timestamp.push(r.timestamp[1]), r => r.indicators.quote[0].close.pop(), r => r.indicators.quote[0].close[1] = 726, r => r.indicators.quote[0].close[1] = 0, r => r.indicators.quote[0].high[1] = 725, r => r.indicators.quote[0].low[1] = 730, r => r.indicators.quote[0].open[1] = null];
  for (const mutate of mutations) { const result = fixture(); mutate(result); assert.equal(yahooClosingQuote(result, "META", options), null); }
  for (const overrides of [{ expectedDate: "2026-09-30" }, { cutoffTime: Date.parse("2026-10-01T19:59:59Z") }, { fetchedAt: Date.parse("2026-10-01T19:59:59Z") }, { fetchedAt: Date.parse("2026-10-01T20:00:00Z") }]) assert.equal(yahooClosingQuote(fixture(), "META", { ...options, ...overrides }), null);
});

test("representative quotes retain the current closing day or fail; they never silently roll back", () => {
  const result = fixture(), payload = { chart: { result: [result] } }, stock = ["META", "Meta", "Meta"];
  const quote = yahooEquityConstituent(payload, stock, options.cutoffTime, options.fetchedAt);
  assert.equal(quote.asOf, "2026-10-01"); assert.equal(quote.value, "725.93"); assert.equal(quote.change, "+0.10%"); assert.equal(quote.source, "https://finance.yahoo.com/quote/META/");
  result.meta.regularMarketTime = second("2026-10-01T19:59:59Z");
  assert.throws(() => yahooEquityConstituent(payload, stock, options.cutoffTime, options.fetchedAt), /fewer than two|不能回退/);
  result.indicators.quote[0].close[1] = 726;
  const historical = yahooEquityConstituent(payload, stock, options.cutoffTime, options.fetchedAt);
  assert.equal(historical.value, "726.00"); assert.equal(historical.source, "https://finance.yahoo.com/quote/META/history");
  assert.throws(() => yahooEquityConstituent(payload, ["OTHER", "Other", "Other"], options.cutoffTime, options.fetchedAt), /标的/);
  result.timestamp.unshift(second("2026-09-29T13:30:00Z"));
  for (const prices of Object.values(result.indicators.quote[0])) prices.unshift(prices[0]);
  result.indicators.quote[0].close[1] = null;
  assert.throws(() => yahooEquityConstituent(payload, stock, options.cutoffTime, options.fetchedAt), /前一交易日/);
  result.indicators.quote[0].close[1] = 725.18;
  result.timestamp[0] = result.timestamp[1];
  assert.throws(() => yahooEquityConstituent(payload, stock, options.cutoffTime, options.fetchedAt), /时间与价格/);
});
