import assert from "node:assert/strict";
import test from "node:test";
import { buildPrivateRecapDraft } from "../scripts/recap-private-draft.mjs";
import { recapObservations, recapTargets } from "../scripts/complete-recap.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

function fixture(market = "US") {
  const f = recapFixture(market);
  return { envelope: f.envelope, observations: recapObservations(f.envelope), verifiedLedger: { market, marketAsOf: f.envelope.marketAsOf, sources: [] } };
}

const source = (target, overrides = {}) => ({ id: "trusted", scope: "sector", targets: [target], role: "facts", kind: "official", url: "https://www.sec.gov/example", sourceLabel: "SEC", facts: "公司确认订单恢复，仍需检验其对本次价格变化的影响。", publishedAt: "2026-08-21T19:00:00Z", ...overrides });

test("both markets retain every target and stay incomplete despite an eligible coverage record", () => {
  for (const market of ["US", "CN"]) {
    const input = fixture(market);
    input.coverage = { eligibleCount: 20, requiredCount: 20, entries: recapTargets(input.envelope).map(target => ({ target: target.symbol, status: "eligible_for_review", gaps: [] })) };
    const result = buildPrivateRecapDraft(input);
    assert.equal(result.entries.length, 20);
    assert.equal(new Set(result.entries.map(entry => entry.target)).size, 20);
    assert.equal(result.entries.filter(entry => entry.kind === "ai_layer").length, 8);
    assert.equal(result.status, "incomplete"); assert.equal(result.approved, false);
    assert.ok(result.entries.every(entry => entry.status === "unresolved" && entry.approved === false));
    assert.match(result.markdown, /2026年8月21日/u);
    assert.doesNotMatch(result.markdown, /2026-08-21/u);
    assert.doesNotMatch(result.markdown, /^## .*AI-(?:US|CN)-/gmu);
    assert.equal((result.markdown.match(/^## /gmu) ?? []).length, 20);
  }
});

test("stale observations, malformed dates and duplicated targets cannot enter a reading draft", () => {
  for (const mutate of [
    input => input.envelope.marketAsOf = "2026-02-30",
    input => input.observations[0].asOf = "2026-08-20",
    input => input.envelope.sectorPerformance[0].asOf = "2026-08-20",
    input => input.envelope.sectorPerformance[0].symbol = input.envelope.sectorPerformance[1].symbol,
    input => input.observations[0].target = input.observations[1].target,
    input => input.verifiedLedger.marketAsOf = "2026-08-20",
    input => input.observations[0].closingReturn = "+99.00%",
    input => input.envelope.sectorPerformance[0].change = `${"9".repeat(400)}%`,
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => buildPrivateRecapDraft(input), /交易日|重复|观测|净变|目标/u);
  }
});

test("rejected leads, failed output and unverified alternatives never become market facts", () => {
  const input = fixture(), target = input.envelope.sectorPerformance[0].symbol;
  input.verifiedLedger.sources = [source(target), source(target, { id: "invalid", status: "invalid", facts: "假事件导致暴涨" })];
  input.verifiedLedger.rejected = [source(target, { id: "rejected", facts: "假新闻确认重大政策" })];
  input.verifiedLedger.alternatives = [{ claim: "未打开文章证明诉讼导致股价下跌" }];
  input.roleStates = { invalid: { target, role: "facts", status: "failed", output: { facts: "失效输出称原因已确定" }, error: "内部原始错误" } };
  const result = buildPrivateRecapDraft(input);
  assert.match(result.markdown, /公司确认订单恢复/u);
  assert.doesNotMatch(JSON.stringify(result), /假事件|假新闻|未打开文章|失效输出|内部原始错误/u);
  const entry = result.entries.find(item => item.target === target);
  assert.deepEqual(entry.sources.map(item => item.id), ["trusted"]);
  assert.equal(entry.status, "unresolved");
  assert.ok(entry.gaps.some(gap => gap.includes("研究尚未全部完成")));
});

test("market-wide evidence cannot spread to sectors or baskets, and company facts stay with actual constituents", () => {
  const input = fixture(), targets = recapTargets(input.envelope), benchmark = targets[0], sector = targets[1], basket = targets.find(target => target.kind === "ai_layer");
  const company = basket.constituents[0].symbol;
  input.verifiedLedger.sources = [
    source(benchmark.symbol, { id: "market", scope: "market", targets: [benchmark.symbol, sector.symbol, basket.symbol], facts: "大盘报道中的就业预期变化" }),
    source(basket.symbol, { id: "company", scope: "company", targets: [company], facts: "真实成分公司确认订单变化" }),
    source(basket.symbol, { id: "other-company", scope: "company", targets: ["NO_SUCH_COMPANY"], facts: "别的公司发生收购" }),
    source(sector.symbol, { id: "background", kind: "background", facts: "此前披露的行业融资风险", publishedAt: "2026-01-28" }),
  ];
  const result = buildPrivateRecapDraft(input), byTarget = new Map(result.entries.map(entry => [entry.target, entry]));
  assert.deepEqual(byTarget.get(benchmark.symbol).sources.map(item => item.id), ["market"]);
  assert.deepEqual(byTarget.get(sector.symbol).sources.map(item => item.id), ["background"]);
  assert.ok(!byTarget.get(basket.symbol).sources.some(item => item.id === "market" || item.id === "other-company"));
  assert.ok(byTarget.get(basket.symbol).sources.some(item => item.id === "company"));
  assert.match(result.markdown, /历史敞口（不能单独解释当日涨跌）/u);
  assert.match(result.markdown, new RegExp(`公司层面（${company}）`, "u"));
  assert.deepEqual(Object.keys(byTarget.get(sector.symbol).sources[0]).sort(), ["facts", "id", "kind", "sourceLabel", "url"]);
});

test("a flat basket preserves opposing arithmetic without manufacturing an economic cause or intraday range", () => {
  const input = fixture(), basket = input.envelope.aiChainPerformance[0];
  basket.constituents.forEach((company, index) => company.change = ["+4.00%", "-3.00%", "+1.00%", "-2.00%"][index]);
  basket.change = "0.00%";
  input.observations = recapObservations(input.envelope);
  const basketObservation = input.observations.find(item => item.target === basket.symbol);
  // Even a supplied sum of individual extremes must not masquerade as a
  // simultaneous portfolio range.
  basketObservation.trading = { symbol: basket.symbol, asOf: input.envelope.marketAsOf, intradayRange: 9.99 };
  const indexObservation = input.observations[0];
  indexObservation.trading = { symbol: indexObservation.target, asOf: indexObservation.asOf, intradayRange: 0.91 };
  const result = buildPrivateRecapDraft(input), entry = result.entries.find(item => item.target === basket.symbol);
  assert.equal(entry.intradayRange, null);
  assert.match(entry.equalWeightCopy, /正贡献合计\+1.25个百分点，负贡献合计-1.25个百分点/u);
  assert.match(entry.observation, /日内波幅尚未观测/u);
  assert.match(entry.equalWeightCopy, /不能证明成分股为什么涨跌/u);
  assert.doesNotMatch(result.markdown, /9\.99/u);
  assert.equal(result.entries[0].intradayRange, 0.91);
  assert.match(result.entries[0].observation, /日内波幅为0\.91%/u);
});

test("validated prose is preserved verbatim without granting independent approval", () => {
  const input = fixture(), f = recapFixture();
  input.validatedRecap = f.raw;
  const before = structuredClone(input), result = buildPrivateRecapDraft(input);
  assert.deepEqual(input, before, "a reading projection must not mutate evidence or prior prose");
  for (const entry of result.entries) {
    const original = f.raw.entries.find(item => item.target === entry.target);
    assert.equal(entry.why, original.why); assert.equal(entry.magnitude, original.magnitude);
    assert.equal(entry.status, "pending_review"); assert.equal(entry.approved, false);
    assert.ok(entry.gaps.some(gap => gap.includes("同一版本独立审查")));
  }
  assert.equal(result.status, "incomplete");
  for (const mutate of [recap => recap.market = "CN", recap => recap.marketAsOf = "2026-08-20", recap => recap.entries[0].target = recap.entries[1].target]) {
    const altered = structuredClone(input); mutate(altered.validatedRecap);
    assert.throws(() => buildPrivateRecapDraft(altered), /成稿|目标/u);
  }
});

test("replay is deterministic, including when evidence order changes, and no raw excerpt is copied", () => {
  const input = fixture(), target = input.envelope.sectorPerformance[0].symbol;
  input.verifiedLedger.sources = [source(target, { id: "b", supportingExcerpt: "FULL_ORIGINAL_BODY_SHOULD_STAY_PRIVATE" }), source(target, { id: "a", facts: "另一条核实事实", kind: "market_wrap", role: "causal" })];
  const first = buildPrivateRecapDraft(input);
  assert.deepEqual(buildPrivateRecapDraft(input), first);
  input.verifiedLedger.sources.reverse();
  assert.deepEqual(buildPrivateRecapDraft(input), first);
  assert.doesNotMatch(JSON.stringify(first), /FULL_ORIGINAL_BODY/u);
  assert.match(first.markdown, /价格联系（本项归因尚待审查）/u);
});

test("publication dates use each market's local day rather than the UTC date", () => {
  const us = fixture(), target = us.envelope.sectorPerformance[0].symbol;
  us.verifiedLedger.sources = [source(target, { id: "previous-local-day", publishedAt: "2026-08-21T01:00:00Z" }), source(target, { id: "current-local-day", publishedAt: "2026-08-22T01:00:00Z" })];
  const entry = buildPrivateRecapDraft(us).entries.find(item => item.target === target);
  assert.deepEqual(entry.sourceGroups.earlier, ["previous-local-day"]);
  assert.deepEqual(entry.sourceGroups.current, ["current-local-day"]);
  const cn = fixture("CN"), cnTarget = cn.envelope.sectorPerformance[0].symbol;
  cn.verifiedLedger.sources = [source(cnTarget, { publishedAt: "2026-08-20T17:00:00Z" })];
  assert.deepEqual(buildPrivateRecapDraft(cn).entries.find(item => item.target === cnTarget).sourceGroups.current, ["trusted"]);
});

test("a resumed partial ledger retains prior reading material separately and respects new rejection", () => {
  const input = fixture(), target = input.envelope.sectorPerformance[0].symbol;
  input.verifiedLedger.sources = [source(target, { facts: "上一批已核订单事实" })];
  const previous = buildPrivateRecapDraft(input);
  input.verifiedLedger = { sources: [] };
  input.preservedDraft = previous;
  const resumed = buildPrivateRecapDraft(input), entry = resumed.entries.find(item => item.target === target);
  assert.match(resumed.markdown, /上一批已核订单事实/u);
  assert.deepEqual(entry.sourceGroups.preserved, ["trusted"]);
  assert.deepEqual(entry.sourceGroups.current, []);
  assert.match(resumed.markdown, /本次尚待重新核准，不作为新核事实/u);
  assert.equal(resumed.approved, false);
  input.verifiedLedger.rejected = [{ url: "https://www.sec.gov/example" }];
  assert.doesNotMatch(buildPrivateRecapDraft(input).markdown, /上一批已核订单事实/u);
  input.verifiedLedger = { sources: [source(target, { facts: "本次核准修正后的事实" })] };
  const updated = buildPrivateRecapDraft(input);
  assert.match(updated.markdown, /本次核准修正后的事实/u);
  assert.doesNotMatch(updated.markdown, /上一批已核订单事实/u);
});

test("a rejection of an original redirected URL excludes its prior canonical material", () => {
  const input = fixture(), target = input.envelope.sectorPerformance[0].symbol;
  input.verifiedLedger.sources = [source(target, { originalUrl: "https://www.sec.gov/original-release", url: "https://www.sec.gov/canonical-release", facts: "重定向原件中的旧事实" })];
  input.preservedDraft = buildPrivateRecapDraft(input);
  input.verifiedLedger = { sources: [], rejected: [{ url: "https://WWW.SEC.GOV:443/original-release" }] };
  assert.doesNotMatch(buildPrivateRecapDraft(input).markdown, /重定向原件中的旧事实/u);
  input.verifiedLedger.rejected = [{ url: "https://www.sec.gov/canonical-release" }];
  assert.doesNotMatch(buildPrivateRecapDraft(input).markdown, /重定向原件中的旧事实/u);
});

test("reading dates are localized while complete qualifications and original replay facts remain intact", () => {
  const input = fixture(), target = input.envelope.sectorPerformance[0].symbol;
  const facts = `2026-08-21公告确认此前订单变化。${"仍应继续核对订单兑现情况。".repeat(65)}重要反证：2026-08-20仍存在客户推迟交付，不能证明本日涨跌原因。`;
  input.verifiedLedger.sources = [source(target, { facts })];
  const result = buildPrivateRecapDraft(input), entry = result.entries.find(item => item.target === target);
  assert.equal(entry.sources[0].facts, facts);
  assert.match(result.markdown, /2026年8月21日公告/u);
  assert.match(result.markdown, /重要反证：2026年8月20日仍存在客户推迟交付，不能证明本日涨跌原因/u);
  assert.doesNotMatch(result.markdown, /2026-08-(?:20|21)|完整核实摘要见对应来源/u);
});
