import assert from "node:assert/strict";
import test from "node:test";
import { assertFactsNumbersInExcerpt, assertNumbersGrounded, bodySupportsDeterministicTarget, marketEnvelope, stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";

test("the actual climbing intraday high cannot borrow the later yield retreat's direction", () => {
  const supportingExcerpt = "The S&P 500 (^GSPC) gained 0.2% while the tech-heavy Nasdaq Composite (^IXIC) eked out a gain. The 10-year Treasury yield (^TNX) eased to 5.24% after climbing earlier Thursday to 5.3%, a new multidecade high. The bond market just suffered its worst quarter in decades.";
  for (const facts of [
    "标普500上涨0.2%；10年期美国国债收益率在盘中升至5.3%后回落至5.24%。",
    "The 10-year Treasury yield eased to 5.24% after climbing earlier Thursday to 5.3%.",
    "10年期美国国债收益率升至5.3%。",
    "10年期美国国债收益率回落至5.24%。",
    "10年期美国国债收益率从当日早些时候的5.30%回落至5.24%。",
  ]) assert.doesNotThrow(() => assertFactsNumbersInExcerpt({facts, supportingExcerpt}));
  for (const facts of [
    "10年期美国国债收益率回落至5.3%。",
    "The 10-year Treasury yield fell to 5.3%.",
    "10年期美国国债收益率上升至5.24%。",
    "The 10-year Treasury yield rose to 5.24%.",
    "10年期美国国债收益率升至5.3个基点。",
  ]) assert.throws(() => assertFactsNumbersInExcerpt({facts, supportingExcerpt}), /数字/);
});

test("a neutral earlier intraday level cannot inherit the later retreat across its historical clause", () => {
  // Genuine rejected SPX worker copy from the frozen October 1 session.
  const supportingExcerpt = [
    "US stocks kicked off October in a volatile fashion, recovering from the morning's losses as bond yields retreated and the AI trade bounced back.",
    "The Dow Jones Industrial Average (^DJI) rose above the flat line. The S&P 500 (^GSPC) gained 0.2% while the tech-heavy Nasdaq Composite (^IXIC) eked out a gain.",
    "The 10-year Treasury yield (^TNX) eased to 5.24% after climbing earlier Thursday to 5.3%, a new multidecade high. The bond market just suffered its worst quarter in decades.",
  ].join("\n");
  const facts = "US stocks recovered from morning losses as bond yields retreated and the AI trade rebounded; the S&P 500 gained 0.2%. The 10-year Treasury yield eased to 5.24% after reaching 5.3% earlier Thursday.";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: facts.replace("reaching 5.3%", "reaching +5.3%"), supportingExcerpt }));
  for (const changed of [
    facts.replace("eased to 5.24%", "rose to 5.24%"),
    facts.replace("reaching 5.3%", "falling to 5.3%"),
    facts.replace("reaching 5.3%", "reaching -5.3%"),
    facts.replace("eased to 5.24%", "eased to -5.24%"),
    facts.replace("reaching 5.3%", "reaching 5.3 basis points"),
    facts.replace("earlier Thursday", "later Thursday"),
    facts.replace(" earlier Thursday", ""),
  ]) assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt }), /数字/, changed);
});

test("a cached pre-fix climbing claim is reopened and its reversed direction is rejected", async () => {
  const f = recapFixture("US"), anomaly = f.plan.anomalies[0];
  const source = {originalUrl: "https://www.reuters.com/markets/us/example-close", title: "US market closing report", role: "facts", kind: "market_wrap", scope: "market", targets: [anomaly.target], anomalyId: anomaly.id, hypothesisIds: [anomaly.hypotheses[0].id], publishedAt: f.envelope.session.windowEnd, supportingExcerpt: "The S&P 500 recovered as Treasury yields eased to 5.24% after climbing earlier Friday to 5.3%, with competing pressures limiting the advance.", facts: "报道指出，10年期美国国债收益率回落至5.3%。", causalConnection: false, comparisons: []};
  const candidateHash = stableHash(source);
  const verifiedCache = new Map([[candidateHash, {...source, candidateHash, timingChecked: true, provenanceChecked: true, comparisonNotesChecked: true, numericEvidenceVersion: "verified-number-direction-v7"}]]);
  let reads = 0;
  const result = await verifyResearchSources([{sources: [source], alternatives: []}], f.envelope, {verifiedCache, reader: async () => {reads++; return {finalUrl: source.originalUrl, status: 200, contentType: "text/html", text: source.supportingExcerpt, publishedAtCandidates: [source.publishedAt]};}});
  assert.equal(reads, 1);
  assert.equal(result.sources.length, 0);
  assert.match(result.rejected[0].reason, /5\.3%/);
});

test("the actual GDPNow post's compact quarter and signed baseline support faithful bilingual paraphrases", () => {
  const original = "Big drop in latest 3Q2026 real GDP estimate from @AtlantaFed GDPNow model … +3.7%, down from prior September 25 read of +5.0% https://t.co/nTCgjFirQH";
  const official = "The GDPNow model estimate for real GDP growth (seasonally adjusted annual rate) in the third quarter of 2026 is 3.7 percent on September 30, down from 5.0 percent on September 25.";
  const chinese = "GDPNow对2026年第三季度实际GDP增长的模型估计为3.7%，低于9月25日的5.0%。";
  const english = "The GDPNow model estimate for real GDP growth in the third quarter of 2026 was 3.7 percent, down from 5.0 percent on September 25.";
  for (const facts of [chinese, english]) for (const supportingExcerpt of [original, official]) {
    assert.doesNotThrow(() => assertNumbersGrounded(facts, supportingExcerpt, "original"));
    assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  }
  for (const facts of [chinese.replace("第三", "第四"), chinese.replace("2026", "2025"), chinese.replace("9月25日", "10月25日"), chinese.replace("9月25日", "9月26日"), chinese.replace("3.7%", "-3.7%"), chinese.replace("5.0%", "-5.0%"), chinese.replace("5.0%", "5.0个百分点"), english.replace("third", "second")]) {
    assert.throws(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt: original }), /数字/);
  }
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "2026年第三季度估计为3.7%。", supportingExcerpt: "Product A3Q2026 has a reading of 3.7%." }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "GDP增长下跌5.0%。", supportingExcerpt: original }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "股价上涨5.0%。", supportingExcerpt: "Shares fell by 5.0%." }), /数字/);
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "加息概率由71%升至86%。", supportingExcerpt: "The probability rose to 86% from 71%." }));
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "The rate change rose to +0.9 bps from -3.5 bps.", supportingExcerpt: "The rate change rose to +0.9 bps from -3.5 bps." }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "The rate change rose to +0.9 bps from +3.5 bps.", supportingExcerpt: "The rate change rose to +0.9 bps from -3.5 bps." }), /数字/);
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "Second-quarter 2026 real GDP increased at a 2.2 percent annual rate.", supportingExcerpt: "Real GDP increased at an annual rate of 2.2 percent in the second quarter of 2026." }));
});

test("translated calendar grounding cannot lend an unquoted value to a price in the same copy", () => {
  assert.doesNotThrow(() => assertNumbersGrounded("9月25日的观察。", "An observation on September 25.", "original"));
  for (const copy of ["价格为9美元。", "9月25日，价格为9美元。", "10月25日的观察。"]) {
    assert.throws(() => assertNumbersGrounded(copy, "An observation on September 25.", "original"), /数字/);
  }
});

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

test("Chinese close shorthand and volume changes preserve signs without losing units", () => {
  const supportingExcerpt = "9月30日A股收盘，沪指涨0.31%，深证成指跌0.11%，创业板指跌0.23%，科创综指跌1.81%。沪深两市成交额合计1.44万亿元，较上一交易日放量约288.21亿元。";
  const facts = "9月30日收盘，沪指上涨0.31%，深证成指下跌0.11%，创业板指下跌0.23%，科创综指下跌1.81%；成交额较上一交易日增加约288.21亿元。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  for (const changed of [facts.replace("上涨0.31", "下跌0.31"), facts.replace("下跌0.11", "上涨0.11"), facts.replace("下跌1.81", "上涨1.81"), facts.replace("增加约288.21", "减少约288.21"), facts.replace("288.21亿元", "288.21万美元")]) assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt }), /数字/);
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "成交额减少15.2亿元。", supportingExcerpt: "成交额较上一交易日缩量15.2亿元。" }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "成交额增加15.2亿元。", supportingExcerpt: "成交额较上一交易日缩量15.2亿元。" }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "价格上涨5元。", supportingExcerpt: "涨价预期仍在讨论，收盘报5元。" }), /数字/);
});

test("an explicitly quoted price level cannot borrow a following percentage's movement verb", () => {
  const supportingExcerpt = "深物业A早盘低开，收盘报12.24元，涨9.97%。万科A盘中最低下探至3.67元，收盘报4.26元，涨4.41%。";
  const facts = "深物业A收于12.24元、上涨9.97%；万科A最低触及3.67元、收于4.26元并上涨4.41%。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  for (const changed of [facts.replace("上涨9.97", "下跌9.97"), facts.replace("上涨4.41", "下跌4.41"), facts.replace("12.24元", "12.24美元"), facts.replace("3.67元", "3.67%")]) assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "股价上涨12.24元。", supportingExcerpt: "收盘报12.24元，涨9.97%。" }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "股价上涨收于12.24元。", supportingExcerpt: "股价跌1.25%，收于12.24元。" }), /数字/);
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "股价下跌1.25%，收于12.24元。", supportingExcerpt: "股价跌1.25%，收盘报12.24元。" }));
  const indices = "上证指数报3842.19点，上涨0.31%；深证成指报12887.62点，下跌0.11%；科创50指数报1530.01点，下跌2.51%。";
  const equivalent = "上证指数报3842.19点、上涨0.31%；深证成指报12887.62点、下跌0.11%；科创50指数报1530.01点、下跌2.51%。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: equivalent, supportingExcerpt: indices }));
  for (const changed of [equivalent.replace("上涨0.31", "下跌0.31"), equivalent.replace("下跌2.51", "上涨2.51"), equivalent.replace("科创50", "科创500"), equivalent.replace("1530.01", "1530.02")]) assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt: indices }), /数字/);

});

test("bare intraday low/high quotations retain their levels without borrowing the following return", () => {
  const supportingExcerpt = "示例地产盘中最低下探至2.17元，收盘报2.48元，涨0.89%。另一只股票盘中最高触及8.35元，收盘报8.20元，跌0.18%。";
  const facts = "示例地产盘中最低2.17元、收报2.48元并上涨0.89%；另一只股票盘中最高8.35元、收报8.20元并下跌0.18%。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({facts,supportingExcerpt}));
  for (const changed of [facts.replace("上涨0.89", "下跌0.89"), facts.replace("下跌0.18", "上涨0.18"), facts.replace("最低2.17元", "最低2.18元"), facts.replace("最高8.35元", "最高8.35%")]) assert.throws(() => assertFactsNumbersInExcerpt({facts:changed,supportingExcerpt}), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({facts:"股价上涨2.17元。",supportingExcerpt}), /数字/);
});

test("directly bound incremental turnover retains its sign, amount and currency", () => {
  const supportingExcerpt = "全市场成交10400亿元，较上一日增量168亿元，全市场超2100只个股下跌。另一市场成交较上一日减量约27.3亿元。";
  const facts = "全市场成交10400亿元，较上一日增加168亿元，超2100只个股下跌；另一市场成交较上一日减少约27.3亿元。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({facts,supportingExcerpt}));
  for (const changed of [facts.replace("增加168", "减少168"), facts.replace("减少约27.3", "增加约27.3"), facts.replace("168亿元", "168万美元")]) assert.throws(() => assertFactsNumbersInExcerpt({facts:changed,supportingExcerpt}), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({facts:"股价上涨5元。",supportingExcerpt:"增量资金仍在等待，收盘报5元。"}), /数字/);
});

test("a directly bound profit-change magnitude does not lend an amount comparator a reversed sign", () => {
  const supportingExcerpt = "214只概念股中已有12股净利增幅超500%，另有8股净利减幅超20%。";
  const facts = "214只概念股中有12股净利增幅超过500%，另有8股净利减幅超过20%。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({facts,supportingExcerpt}));
  for (const changed of [facts.replace("12股", "13股"), facts.replace("增幅超过500", "减幅超过500"), facts.replace("减幅超过20", "增幅超过20"), facts.replace("500%", "500个百分点")]) assert.throws(() => assertFactsNumbersInExcerpt({facts:changed,supportingExcerpt}), /数字/);
  assert.doesNotThrow(()=>assertFactsNumbersInExcerpt({facts:"净利增长低于5%，另一公司净利下降高于3%。",supportingExcerpt:"净利增幅低于5%，另一公司净利减幅高于3%。"}));
  assert.throws(()=>assertFactsNumbersInExcerpt({facts:"净利下降低于5%。",supportingExcerpt:"净利增幅低于5%。"}),/数字/);
});

test("a literal abbreviated currency threshold denotes one unit without turning a unit label into a value", () => {
  const supportingExcerpt = "26股主力资金净流出超亿元，另有2项交易金额超过亿美元。";
  const facts = "26股主力资金净流出超过1亿元，另有2项交易金额超过1亿美元。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({facts,supportingExcerpt}));
  for (const changed of [facts.replace("1亿元", "2亿元"), facts.replace("超过1亿元", "低于1亿元")]) assert.throws(() => assertFactsNumbersInExcerpt({facts:changed,supportingExcerpt}), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({facts:"净流出超过1亿美元。",supportingExcerpt:"净流出超亿元。"}), /数字/);
  for (const excerpt of ["资金表格使用亿元作为单位。", "净流出超千亿元。", "净流出金额超过。金额单位：亿元。", "公司交易金额不足亿元。"]) assert.throws(() => assertFactsNumbersInExcerpt({facts:"资金净流出超过1亿元。",supportingExcerpt:excerpt}), /数字/);
});

test("a magnitude bound cannot override the immediately preceding movement verb", () => {
  assert.doesNotThrow(()=>assertFactsNumbersInExcerpt({facts:"股价上涨超过3.2%。",supportingExcerpt:"股价涨超3.2%。"}));
  assert.throws(()=>assertFactsNumbersInExcerpt({facts:"股价下跌超过3.2%。",supportingExcerpt:"股价涨超3.2%。"}),/数字/);
  assert.doesNotThrow(()=>assertFactsNumbersInExcerpt({facts:"成交金额减少超过3.2亿元。",supportingExcerpt:"成交金额下降超过3.2亿元。"}));
  assert.throws(()=>assertFactsNumbersInExcerpt({facts:"成交金额增加超过3.2亿元。",supportingExcerpt:"成交金额下降超过3.2亿元。"}),/数字/);
  assert.doesNotThrow(()=>assertFactsNumbersInExcerpt({facts:"股价下降不超过3.2%。",supportingExcerpt:"股价下跌不超过3.2%。"}));
  assert.throws(()=>assertFactsNumbersInExcerpt({facts:"股价上涨不超过3.2%。",supportingExcerpt:"股价下跌不超过3.2%。"}),/数字/);
});

test("a directly quoted share threshold permits its full comparator without inventing a change", () => {
  const supportingExcerpt = "新分子业务持续贡献增长，2026年第一季度收入占比超30%，新客户快速增长。另一项业务收入占比低于15%。";
  const facts = "2026年第一季度新分子业务收入占比超过30%，另一项业务收入占比低于15%。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts, supportingExcerpt }));
  for (const changed of [facts.replace("超过30", "低于30"), facts.replace("30%", "31%"), facts.replace("30%", "30个百分点"), facts.replace("低于15", "超过15")]) assert.throws(() => assertFactsNumbersInExcerpt({ facts: changed, supportingExcerpt }), /数字/);
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "股价下跌超过5%，超过3600只个股下跌。", supportingExcerpt: "股价跌超5%，超3600只个股下跌。" }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "股价上涨超过5%。", supportingExcerpt: "股价跌超5%。" }), /数字/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "价格超过30元。", supportingExcerpt: "超导材料价格报30元。" }), /数字/);
});

test("legacy numeric caches cannot retain a newly recognized reversed Chinese close", async () => {
  const f = recapFixture("CN"), anomaly = f.plan.anomalies[0];
  const source = { originalUrl: "https://www.reuters.com/markets/china/example-close", title: "China market closing report", role: "facts", kind: "market_wrap", scope: "market", targets: [anomaly.target], anomalyId: anomaly.id, hypothesisIds: [anomaly.hypotheses[0].id], publishedAt: f.envelope.session.windowEnd, supportingExcerpt: "沪指收涨0.31%，市场成交维持平稳，行业表现出现分化，投资者继续关注经济数据和政策变化。", facts: "沪指收跌0.31%，市场成交维持平稳，行业表现出现分化。", causalConnection: false, comparisons: [] };
  const candidateHash = stableHash(source);
  for (const marker of [undefined, "verified-number-direction-v0", "verified-number-direction-v1", "verified-number-direction-v2", "verified-number-direction-v3"]) {
    let reads = 0;
    const cache = new Map([[candidateHash, { ...source, candidateHash, timingChecked: true, provenanceChecked: true, comparisonNotesChecked: true, numericEvidenceVersion: marker }]]);
    const result = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { verifiedCache: cache, reader: async () => { reads++; return { finalUrl: source.originalUrl, status: 200, contentType: "text/html", text: source.supportingExcerpt, publishedAtCandidates: [source.publishedAt] }; } });
    assert.equal(reads, 1); assert.equal(result.sources.length, 0); assert.match(result.rejected[0].reason, /0\.31%/);
  }
});
