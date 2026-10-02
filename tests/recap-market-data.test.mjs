import assert from "node:assert/strict";
import test from "node:test";
import { stableHash } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { collectRecapTradingData, parseTradingSnapshot, tradingRequests, validateRecapTradingData } from "../scripts/recap-market-data.mjs";
import { completeRecapPlan } from "../scripts/complete-recap.mjs";

function payload(symbol, close = 101, change = 1) {
  const dates = [];
  let day = new Date("2026-08-21T13:30:00Z");
  while (dates.length < 24) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.getTime() / 1000);
    day = new Date(day.getTime() - 86_400_000);
  }
  const previous = close / (1 + change / 100);
  const quote = {
    close: dates.map(() => previous), open: dates.map(() => previous),
    high: dates.map(() => previous * 1.01), low: dates.map(() => previous * 0.99), volume: dates.map(() => 100),
  };
  quote.close[23] = close;
  quote.open[23] = previous * 1.0025;
  quote.high[23] = Math.max(close, previous) * 1.01;
  quote.low[23] = Math.min(close, previous) * 0.99;
  quote.volume[23] = 200;
  return { chart: { result: [{ meta: { symbol }, timestamp: dates, indicators: { quote: [quote] } }] } };
}

function fixture() {
  const envelope = recapFixture().envelope;
  const request = { symbol: "TEST", quoteSymbol: "TEST", expectedReturn: 1, expectedClose: 101 };
  const data = payload("TEST");
  const snapshot = { symbol: "TEST", url: "https://query1.finance.yahoo.com/v8/finance/chart/TEST?interval=1d", payload: data, payloadHash: stableHash(data), fetchedAt: "2026-08-21T22:00:00Z" };
  return { envelope, request, snapshot };
}

test("daily range, opening gap and volume use original bars and exclude the current day from baselines", () => {
  const f = fixture();
  const result = parseTradingSnapshot(f.snapshot, f.request, f.envelope);
  assert.equal(result.closingReturn, 1);
  assert.equal(result.openingGap, 0.25);
  assert.equal(result.openToClose, 0.75);
  assert.equal(result.intradayRange, 3.01);
  assert.equal(result.volumeVsPrior20Median, 2);
  assert.equal(result.baselineSessions, 20);
  assert.equal(result.rangeVsPrior20Median, 1.505);
  assert.equal(result.intradayRangeDisplay, "3.01%");
});

test("a missing daily close uses only the bound regular-session closing quote and is rebuilt from unchanged original bytes", () => {
  const f = fixture(), r = f.snapshot.payload.chart.result[0];
  r.meta = { ...r.meta, instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York", regularMarketPrice: 101, regularMarketTime: Date.parse("2026-08-21T20:00:01Z") / 1000, currentTradingPeriod: { regular: { start: r.timestamp.at(-1), end: Date.parse("2026-08-21T20:00:00Z") / 1000 } } };
  r.indicators.quote[0].close[23] = null;
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  const before = structuredClone(f.snapshot), bar = parseTradingSnapshot(f.snapshot, f.request, f.envelope);
  assert.equal(bar.close, 101); assert.equal(bar.closingReturn, 1); assert.equal(bar.intradayRange, 3.01); assert.equal(bar.volumeVsPrior20Median, 2);
  assert.equal(bar.closingQuote.basis, "identified_regular_session_closing_quote");
  assert.equal(bar.closingQuote.quoteTime, "2026-08-21T20:00:01.000Z");
  assert.match(bar.returnBasis, /regular-session closing quote/);
  assert.deepEqual(f.snapshot, before);
  r.meta.regularMarketTime = Date.parse("2026-08-21T19:59:59Z") / 1000;
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  assert.throws(() => parseTradingSnapshot(f.snapshot, f.request, f.envelope), /缺失价格/);
  r.meta.regularMarketTime = Date.parse("2026-08-21T20:00:01Z") / 1000;
  r.indicators.quote[0].close[22] = null;
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  assert.throws(() => parseTradingSnapshot(f.snapshot, f.request, f.envelope), /缺失价格/);
});

test("future bars cannot enter the session or its volume baseline", () => {
  const f = fixture(), result = f.snapshot.payload.chart.result[0];
  result.timestamp.push(Date.parse("2026-08-24T13:30:00Z") / 1000);
  for (const values of Object.values(result.indicators.quote[0])) values.push(999999);
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  assert.equal(parseTradingSnapshot(f.snapshot, f.request, f.envelope).volumeVsPrior20Median, 2);
  assert.equal(parseTradingSnapshot(f.snapshot, f.request, f.envelope).close, 101);
});

test("an adjusted-series discontinuity triggers issuer verification without replacing the quoted return", () => {
  const f = fixture(), r = f.snapshot.payload.chart.result[0], closes = r.indicators.quote[0].close;
  r.indicators.adjclose = [{ adjclose: closes.map((close, index) => index === closes.length - 1 ? close : close - 2.51) }];
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  const bar = parseTradingSnapshot(f.snapshot, f.request, f.envelope);
  assert.equal(bar.closingReturn, 1); assert.equal(bar.openingGap, 0.25);
  assert.equal(bar.adjustmentReview.status, "requires_primary_verification");
  assert.equal(bar.adjustmentReview.factualAuthority, false);
  assert.deepEqual(bar.adjustmentReview.leads, []);
  assert.match(bar.returnBasis, /distinct from the provider's adjusted-close series/);
  r.indicators.adjclose[0].adjclose = closes.map(close => close * 0.9);
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  assert.equal(parseTradingSnapshot(f.snapshot, f.request, f.envelope).adjustmentReview.status, "no_provider_adjustment_detected");
  delete r.indicators.adjclose;
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  assert.equal(parseTradingSnapshot(f.snapshot, f.request, f.envelope).adjustmentReview.status, "unavailable");
});

test("cash dividend and split records retain effective dates and provider-only status, excluding future actions", () => {
  const f = fixture(), r = f.snapshot.payload.chart.result[0], time = r.timestamp.at(-1), future = time + 3 * 86400;
  f.snapshot.url += "&events=div%2Csplits";
  r.meta.currency = "USD";
  r.events = { dividends: { [time]: { date: time, amount: 2.51 }, [future]: { date: future, amount: 9.99 } }, splits: { [time]: { date: time, numerator: 2, denominator: 1, splitRatio: "2:1" } } };
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  const review = parseTradingSnapshot(f.snapshot, f.request, f.envelope).adjustmentReview;
  assert.equal(review.status, "requires_primary_verification");
  assert.equal(review.eventRequest, true); assert.equal(review.factualAuthority, false);
  assert.deepEqual(review.leads, [
    { type: "cash_dividend", effectiveDate: f.envelope.marketAsOf, amount: 2.51, currency: "USD" },
    { type: "stock_split", effectiveDate: f.envelope.marketAsOf, numerator: 2, denominator: 1 },
  ]);
  assert.match(review.limitation, /Never replace announcement time with the effective date/);
});

test("malformed corporate-action dates, currency, amounts and split ratios cannot enter the observation", () => {
  for (const mutate of [
    r => r.events.dividends = [],
    r => r.events.dividends[Object.keys(r.events.dividends)[0]].date += 1,
    r => r.events.dividends[Object.keys(r.events.dividends)[0]].amount = -2.51,
    r => r.meta.currency = "unknown",
    r => r.events.splits[Object.keys(r.events.splits)[0]].splitRatio = "1:2",
    r => r.events.splits[Object.keys(r.events.splits)[0]].denominator = 0,
  ]) {
    const f = fixture(), r = f.snapshot.payload.chart.result[0], time = r.timestamp.at(-1);
    r.meta.currency = "USD"; r.events = { dividends: { [time]: { date: time, amount: 2.51 } }, splits: { [time]: { date: time, numerator: 2, denominator: 1, splitRatio: "2:1" } } };
    mutate(r); f.snapshot.payloadHash = stableHash(f.snapshot.payload);
    assert.throws(() => parseTradingSnapshot(f.snapshot, f.request, f.envelope), /公司行动|分红|拆股/);
  }
});

test("later adjusted bars cannot create a historical current-session adjustment flag", () => {
  const f = fixture(), r = f.snapshot.payload.chart.result[0];
  r.indicators.adjclose = [{ adjclose: [...r.indicators.quote[0].close] }];
  r.timestamp.push(Date.parse("2026-08-24T13:30:00Z") / 1000);
  for (const values of Object.values(r.indicators.quote[0])) values.push(100);
  r.indicators.adjclose[0].adjclose.push(40);
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  const bar = parseTradingSnapshot(f.snapshot, f.request, f.envelope);
  assert.equal(bar.adjustmentReview.status, "no_provider_adjustment_detected");
  assert.equal(bar.closingReturn, 1);
});

test("a flat constituent with an adjustment flag remains in the factual search seed", async () => {
  const f = recapFixture(), target = f.envelope.aiChainPerformance[0], company = target.constituents[3];
  company.change = "0.00%";
  const mean = target.constituents.reduce((sum, item) => sum + Number(item.change.slice(0, -1)), 0) / 4;
  target.change = mean.toFixed(2) + "%";
  const requests = tradingRequests(f.envelope);
  const book = await collectRecapTradingData(f.envelope, { now: () => new Date("2026-08-21T22:00:00Z"), fetchJson: async url => {
    const symbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1)), request = requests.find(item => item.quoteSymbol === symbol);
    const value = payload(symbol, request.expectedClose ?? 101, request.expectedReturn), result = value.chart.result[0];
    if (request.symbol === company.symbol) result.indicators.adjclose = [{ adjclose: result.indicators.quote[0].close.map((close, index) => index === 23 ? close : close - 2.51) }];
    return value;
  } });
  const anomaly = completeRecapPlan(f.envelope, book).anomalies.find(a => a.target === target.symbol);
  assert.ok(anomaly.factQueries[0].includes(company.nameEn ?? company.name));
  assert.match(anomaly.factQueries[0], /dividend split ex-date/);
  assert.equal(anomaly.quantitativeObservations.representativeTrading.find(item => item.symbol === company.symbol).adjustmentReview.factualAuthority, false);
});

test("missing volume or fewer than twenty prior sessions never implies thin trading", () => {
  const f = fixture(), result = f.snapshot.payload.chart.result[0];
  result.indicators.quote[0].volume[23] = null;
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  assert.equal(parseTradingSnapshot(f.snapshot, f.request, f.envelope).volume, null);
  assert.equal(parseTradingSnapshot(f.snapshot, f.request, f.envelope).volumeVsPrior20Median, null);
  result.timestamp = result.timestamp.slice(-10);
  for (const [key, values] of Object.entries(result.indicators.quote[0])) result.indicators.quote[0][key] = values.slice(-10);
  f.snapshot.payloadHash = stableHash(f.snapshot.payload);
  assert.equal(parseTradingSnapshot(f.snapshot, f.request, f.envelope).rangeVsPrior20Median, null);
});

test("tampered origin, payload, symbol, close, date, incomplete session and malformed bars fail", () => {
  for (const mutate of [
    f => f.snapshot.url = "https://unknown.example/v8/finance/chart/TEST?interval=1d",
    f => f.snapshot.payloadHash = "fake",
    f => f.snapshot.payload.chart.result[0].meta.symbol = "OTHER",
    f => f.request.expectedClose = 999,
    f => f.request.expectedReturn = -1,
    f => f.envelope.marketAsOf = "2026-08-24",
    f => f.snapshot.fetchedAt = "2026-08-21T19:00:00Z",
    f => f.snapshot.payload.chart.result[0].indicators.quote[0].low[23] = 200,
  ]) {
    const f = fixture(); mutate(f);
    // Even a re-hashed payload must pass symbol/date/price/bar validation.
    if (f.snapshot.payloadHash !== "fake") f.snapshot.payloadHash = stableHash(f.snapshot.payload);
    assert.throws(() => parseTradingSnapshot(f.snapshot, f.request, f.envelope));
  }
});

test("collection freezes every unique requested quote; derived mutations and missing gaps cannot pass", async () => {
  const f = recapFixture(), requests = tradingRequests(f.envelope);
  assert.equal(new Set(requests.map(item => item.symbol)).size, requests.length);
  const book = await collectRecapTradingData(f.envelope, { now: () => new Date("2026-08-21T22:00:00Z"), fetchJson: async url => {
    assert.equal(new URL(url).searchParams.get("events"), "div,splits");
    const symbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    const request = requests.find(item => item.quoteSymbol === symbol);
    return payload(symbol, request.expectedClose ?? 101, request.expectedReturn);
  } });
  assert.equal(book.entries.length, requests.length);
  assert.equal(book.gaps.length, 0);
  assert.equal(validateRecapTradingData(book, f.envelope), book);
  const actionTamper = structuredClone(book);
  actionTamper.entries[0].adjustmentReview.status = "primary_verified";
  assert.throws(() => validateRecapTradingData(actionTamper, f.envelope), /派生值/);
  book.entries[0].volumeVsPrior20Median = 10;
  assert.throws(() => validateRecapTradingData(book, f.envelope), /派生值/);
  const absent = await collectRecapTradingData(f.envelope, { fetchJson: async () => { throw new Error("unavailable"); } });
  assert.equal(absent.gaps.length, requests.length);
  assert.equal(absent.entries.length, 0);
  absent.gaps.pop();
  assert.throws(() => validateRecapTradingData(absent, f.envelope), /遗漏/);
});

test("China official sector bars and Shanghai fallback validate instrument and dates independently", () => {
  const envelope = recapFixture("CN").envelope;
  const data = payload("932077", 101, 1).chart.result[0];
  const quote = data.indicators.quote[0];
  const records = data.timestamp.map((timestamp, index) => ({ indexCode: "932077", tradeDate: new Date(timestamp * 1000).toISOString().slice(0, 10).replaceAll("-", ""), open: quote.open[index], high: quote.high[index], low: quote.low[index], close: quote.close[index], tradingVol: quote.volume[index] }));
  const snapshot = { symbol: "932077", url: "https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=932077", payload: { code: "200", data: records }, fetchedAt: "2026-08-21T22:00:00Z" };
  snapshot.payloadHash = stableHash(snapshot.payload);
  const request = { symbol: "932077", quoteSymbol: "932077.SS", expectedReturn: 1, expectedClose: null };
  assert.equal(parseTradingSnapshot(snapshot, request, envelope).sourceLabel, "CSI");
  assert.equal(parseTradingSnapshot(snapshot, request, envelope).volumeVsPrior20Median, 2);
  snapshot.payload.data[0].indexCode = "932078";
  snapshot.payloadHash = stableHash(snapshot.payload);
  assert.throws(() => parseTradingSnapshot(snapshot, request, envelope), /标的不一致/);
  const tencent = { symbol: "SSE", url: "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,2026-07-01,2026-08-21,60,qfq", fetchedAt: snapshot.fetchedAt, payload: { data: { sh000001: { day: records.map(row => [row.tradeDate.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3"), String(row.open), String(row.close), String(row.high), String(row.low), String(row.tradingVol)]) } } } };
  tencent.payloadHash = stableHash(tencent.payload);
  assert.equal(parseTradingSnapshot(tencent, { ...request, symbol: "SSE" }, envelope).sourceLabel, "Tencent Finance");
  tencent.url = tencent.url.replace("sh000001", "sh000300");
  assert.throws(() => parseTradingSnapshot(tencent, { ...request, symbol: "SSE" }, envelope), /来源与标的/);
});

test("recap numeric copy cites verified bars; fabricated range cannot be grounded by a nearby price", () => {
  const f = recapFixture(), request = tradingRequests(f.envelope).find(item => item.symbol === "SPX");
  const data = payload(request.quoteSymbol, request.expectedClose, request.expectedReturn);
  const snapshot = { symbol: request.symbol, url: "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d", payload: data, payloadHash: stableHash(data), fetchedAt: "2026-08-21T22:00:00Z" };
  f.tradingData.snapshots.push(snapshot);
  f.tradingData.entries.push(parseTradingSnapshot(snapshot, request, f.envelope));
  f.tradingData.gaps = f.tradingData.gaps.filter(item => item.symbol !== "SPX");
  f.raw.entries[0].magnitude += "盘中振幅为" + f.tradingData.entries[0].intradayRangeDisplay + "，这一测量并不能证明独立的新闻催化。";
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { tradingData: f.tradingData });
  assert.ok(recap.entries[0].sources.some(item => item.kind === "market_data" && item.label === "Yahoo Finance · SPX"));
  assert.ok(!JSON.stringify(recap).includes("payloadHash"));
  f.raw.entries[0].magnitude += "真实振幅为999%。";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social, { tradingData: f.tradingData }), /数字/);
});
