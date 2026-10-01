import assert from "node:assert/strict";
import test from "node:test";
import { assertAccessibleOriginalArticle, assertSessionClosingClaims } from "../scripts/source-session-integrity.mjs";
import { assertFactsNumbersInExcerpt } from "../scripts/daily-workflow-core.mjs";
const envelope = { market: "US", marketAsOf: "2026-09-29", markets: [
  { symbol: "SPX", asOf: "2026-09-29", value: "7,670.84", change: "-0.17%" },
  { symbol: "IXIC", asOf: "2026-09-29", value: "26,797.54", change: "-0.09%" },
  { symbol: "DJI", asOf: "2026-09-29", value: "51,349.92", change: "-0.26%" },
] };
const time = "2026-09-29T20:48:23Z";

test("dated closing reports must reconcile exact prices and rounded daily returns with the actual session", () => {
  const correct = "At the closing bell, the Nasdaq Composite had slipped 0.09% to 26,798, the S&P 500 was down 0.2% at 7,671, and the Dow Jones Industrial Average had fallen 0.3% to 51,350.\nAll told, the S&P 500 fell 12.85 points to 7,670.84. The Dow dropped 131.59 points to 51,349.92, and Nasdaq gave up 22.84 points to close at 26,797.54.";
  assert.equal(assertSessionClosingClaims(correct, envelope, time).length, 9);
  for (const text of [correct.replace("down 0.2%", "down 0.8%"), correct.replace("7,670.84", "7,683.69"), correct.replace("51,349.92", "51,481.51"), correct.replace("slipped 0.09%", "rose 0.09%")]) assert.throws(() => assertSessionClosingClaims(text, envelope, time), /与已核验行情矛盾/);
});

test("clearly dated historical examples, intraday quotes and related index families are not current closing claims", () => {
  for (const text of ["On Monday at the closing bell, the S&P 500 was down 0.8% at 7,683.", "At the closing bell on 2026-09-28, the S&P 500 was down 0.8% at 7,683.", "S&P 500 was down 0.8% intraday.", "At the closing bell, the Nasdaq 100 fell 5% to 20,000.", "At the closing bell, Dow Inc fell 5% to 20."]) assert.deepEqual(assertSessionClosingClaims(text, envelope, time), []);
});

test("a public 200 subscription teaser cannot masquerade as a complete original article", () => {
  for (const host of ["finance.yahoo.com", "ca.finance.yahoo.com", "nz.finance.yahoo.com"]) assert.throws(() => assertAccessibleOriginalArticle({ finalUrl: `https://${host}/markets/articles/example.html`, text: "Broad Market Indicators. Upgrade to read this MT Newswires article and get so much more." }), /正文需订阅/);
  assert.doesNotThrow(() => assertAccessibleOriginalArticle({ finalUrl: "https://finance.yahoo.com/markets/articles/example.html", text: "Full public article. Subscribe to our newsletter or explore Yahoo Finance Premium." }));
});

test("a benchmark's number identifies the index and cannot reverse its actual closing direction", () => {
  const supportingExcerpt = "The Standard & Poor’s 500 slipped 0.2% after wavering between modest gains and losses for much of the day.";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "标普500下跌0.2%。", supportingExcerpt }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "标普500上涨0.2%。", supportingExcerpt }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "价格跌至500美元。", supportingExcerpt }), /数字/);
});
