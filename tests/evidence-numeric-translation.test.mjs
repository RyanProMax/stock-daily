import assert from "node:assert/strict";
import test from "node:test";
import { assertFactsNumbersInExcerpt, bodySupportsDeterministicTarget, marketEnvelope } from "../scripts/daily-workflow-core.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";

test("translated calendar months and ordinal periods preserve the actual reported values", () => {
  const supportingExcerpt = "The Consumer Confidence Index declined for a third straight month to its lowest level since April 2014. A print of 81.9 for September was well below a consensus forecast for an increase to 89.0 from a revised 88.6 in August.";
  const facts = "9月消费者信心指数实际值为81.9，市场共识预测为89.0，8月修正值为88.6；该指数连续第3个月下降，并降至2014年4月以来最低水平。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  for (const changed of [facts.replace("9月", "10月"), facts.replace("第3个月", "第4个月"), facts.replace("89.0", "89.2"), facts.replace("2014年", "2015年")]) assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "价格下降9美元。", supportingExcerpt: "Prices declined in September." }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "5月库存增加。", supportingExcerpt: "May inventory increase if demand falls?" }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "第3个月需求下降。", supportingExcerpt: "One-third of consumers expected demand to fall." }), /数字/);
});

test("explicitly bound fractional durations and maturities are arithmetic, never calendar or price aliases", () => {
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "消费者信心降至12.5年低点。", supportingExcerpt: "Consumer confidence fell to a 12-1/2-year low." }));
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "2年期国债收益率下行。", supportingExcerpt: "The 2-year Treasury yield fell." }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "消费者信心降至12.5年低点。", supportingExcerpt: "The ratio was 12-1/2." }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "收益率跌至12.5%。", supportingExcerpt: "Yields fell to their 12-1/2-year low." }), /数字/);
});

test("percentage-point and basis-point translations respect signs, dimensions and their exact conversion", () => {
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "预计利率提高的消费者占比上升5.2个百分点至68.4%。", supportingExcerpt: "The share anticipating higher interest rates jumped by 5.2 ppts to 68.4%." }));
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "收益率下降3.5基点。", supportingExcerpt: "The yield change was -3.5 bps." }));
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "收益率上升112基点。", supportingExcerpt: "The yield increased by 1.12 percentage points." }));
  for (const facts of ["收益率上升3.5基点。", "收益率下降3.5个百分点。", "收益率下降3.5%。"]) assert.throws(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt: "The yield change was -3.5 bps." }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "预计提高利率的比例上升5.2%至68.4%。", supportingExcerpt: "The share jumped by 5.2 ppts to 68.4%." }), /数字/);
});

test("explicit money scales translate without changing signed EPS levels or laundering large amounts", () => {
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "营收达到120亿美元。", supportingExcerpt: "Revenue reached $12B." }));
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "营收达到1.2亿美元。", supportingExcerpt: "Revenue reached 120 million US dollars." }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "营收达到120亿美元。", supportingExcerpt: "Revenue reached $120M." }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "每股收益下跌至$0.25。", supportingExcerpt: "EPS declined to -$0.25." }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "营收达到120亿美元。", supportingExcerpt: "Revenue reached 12 billion." }), /数字/);
});

test("wire quote directions bind to each yield pair and the closing move rather than a prior gain", () => {
  const supportingExcerpt = "Front-month Brent dipped 1.9% to $95.95. The 2-year Treasury yield (-3.5 bps, 4.889%) and the 10-year Treasury yield (+0.9 bps, 5.251%) reached new highs. Nvidia gave up an early gain and closed 0.7% lower.";
  const facts = "布伦特下跌1.9%至95.95美元；2年期收益率下降3.5基点至4.889%，10年期上升0.9基点至5.251%。英伟达收跌0.7%。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  for (const changed of [facts.replace("布伦特下跌", "布伦特上涨"), facts.replace("下降3.5", "上升3.5"), facts.replace("英伟达收跌", "英伟达上涨")]) assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt }), /数字/);
});

test("valid ISO dates translate at calendar precision and currency ranges never erase a standalone loss", () => {
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "发布于2026年9月29日。", supportingExcerpt: "Release date: 2026-09-29." }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "发布于2026年9月30日。", supportingExcerpt: "Release date: 2026-09-29." }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "价格下降29美元。", supportingExcerpt: "Release date: 2026-09-29." }), /数字/);
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "EPS range: $1.22-$1.28.", supportingExcerpt: "EPS range: $1.22 to $1.28." }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "EPS: $0.25.", supportingExcerpt: "EPS: -$0.25." }), /数字/);
});

test("original long-form S&P 500 names identify only the benchmark, never an AI server basket", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  for (const name of ["S&P 500", "Standard & Poor’s 500", "Standard & Poor's 500", "Standard and Poor's 500"]) {
    const text = `${name} slipped as long-term Treasury yields weighed on the market.`;
    assert.equal(bodySupportsDeterministicTarget(text, envelope, "SPX"), true);
    assert.equal(bodySupportsDeterministicTarget(text, envelope, "AI-US-servers"), false);
  }
});
