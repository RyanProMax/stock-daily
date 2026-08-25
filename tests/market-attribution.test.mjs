import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReportContent,
  validateInput,
  validateReport,
} from "../scripts/daily-publish.mjs";
import { buildMarketBriefs } from "../scripts/daily-collect.mjs";
import {
  buildMarketSessions,
  driverDirectionMatches,
  zonedDateTimeIso,
} from "../scripts/market-attribution.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

test("V10 accepts deterministic market input without a preselected news pool", () => {
  const input = validateInput(fixtureInput());
  assert.equal(input.contractVersion, "codex-market-research-v10");
  assert.equal(Object.hasOwn(input, "news"), false);
  assert.equal(input.markets.length, 10);
  assert.equal(input.sectorPerformance.length, 22);
  assert.equal(input.aiChainPerformance.length, 16);
  assert.deepEqual(input.marketBriefs, fixtureInput().marketBriefs);
});

test("market sessions use the completed close of each venue", () => {
  assert.equal(
    zonedDateTimeIso("2026-08-21", 15, "Asia/Shanghai"),
    "2026-08-21T07:00:00.000Z",
  );
  assert.equal(
    zonedDateTimeIso("2026-08-21", 16, "America/New_York"),
    "2026-08-21T20:00:00.000Z",
  );
  assert.deepEqual(
    buildMarketSessions(fixtureInput().markets),
    fixtureInput().marketSessions,
  );
});

test("mixed driver direction requires both rising and falling sectors", () => {
  const performance = fixtureInput().sectorPerformance;
  assert.equal(
    driverDirectionMatches("mixed", ["932077"], performance),
    false,
  );
  assert.equal(
    driverDirectionMatches("mixed", ["932077", "932086"], performance),
    true,
  );
});

test("V10 accepts evidence-backed event drivers plus structural fallback", () => {
  const input = validateInput(fixtureInput());
  const report = validateReport(fixtureReport(input), input);
  assert.equal(report.drivers.length, 4);
  for (const market of ["CN", "US"]) {
    const drivers = report.drivers.filter((driver) => driver.market === market);
    assert.equal(drivers.filter((driver) => driver.role === "primary").length, 1);
    assert.ok(drivers.some((driver) => driver.basis === "structural"));
  }
  const stored = JSON.parse(buildReportContent(input, report));
  assert.equal(stored.contractVersion, "codex-market-research-v10");
  assert.equal(Object.hasOwn(stored, "researchAudit"), false);
  assert.equal(stored.stories.length, 0);
  assert.equal(stored.drivers[0].basis, "event");
  assert.equal(stored.drivers[0].evidence[0].kind, "market_data");
});

test("V10 requires one primary and one structural driver per market", () => {
  const input = validateInput(fixtureInput());
  const missingStructural = fixtureReport(input);
  missingStructural.drivers = missingStructural.drivers.filter(
    (driver) => !(driver.market === "CN" && driver.basis === "structural"),
  );
  missingStructural.translations.en.drivers.splice(1, 1);
  assert.throws(
    () => validateReport(missingStructural, input),
    /CN 缺少结构性盘面解释/,
  );

  const duplicatePrimary = fixtureReport(input);
  duplicatePrimary.drivers[1].role = "primary";
  assert.throws(
    () => validateReport(duplicatePrimary, input),
    /CN 必须恰好包含一条主驱动/,
  );
});

test("structural drivers cannot smuggle in external stories", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.drivers[1].evidence.push(report.drivers[0].evidence[1]);
  assert.throws(
    () => validateReport(report, input),
    /structural 证据组合不充分/,
  );
});

test("event and macro drivers require non-expert external evidence", () => {
  const input = validateInput(fixtureInput());
  const missingExternal = fixtureReport(input);
  missingExternal.drivers[0].evidence = missingExternal.drivers[0].evidence.slice(
    0,
    1,
  );
  assert.throws(
    () => validateReport(missingExternal, input),
    /event 证据组合不充分/,
  );

  const expertOnly = fixtureReport(input);
  expertOnly.drivers[0].evidence[1].sourceType = "expert";
  assert.throws(
    () => validateReport(expertOnly, input),
    /来源层级与 URL 不一致/,
  );
});

test("external source authority is derived from the cited URL", () => {
  const input = validateInput(fixtureInput());
  const spoofedPublisher = fixtureReport(input);
  spoofedPublisher.drivers[0].evidence[1].source =
    "https://personal-commentary.example/market-take";
  spoofedPublisher.drivers[0].evidence[1].sourceType = "publisher";
  assert.throws(
    () => validateReport(spoofedPublisher, input),
    /来源层级与 URL 不一致/,
  );

  const userContentSubdomain = fixtureReport(input);
  userContentSubdomain.drivers[0].evidence[1].source =
    "https://blog.sina.com.cn/market-take";
  userContentSubdomain.drivers[0].evidence[1].sourceType = "publisher";
  assert.throws(
    () => validateReport(userContentSubdomain, input),
    /来源层级与 URL 不一致/,
  );

  const unknownExpert = fixtureReport(input);
  unknownExpert.drivers[0].evidence[1].source =
    "https://personal-commentary.example/market-take";
  unknownExpert.drivers[0].evidence[1].sourceType = "expert";
  assert.throws(
    () => validateReport(unknownExpert, input),
    /event 证据组合不充分/,
  );
});

test("external evidence must fall inside the relevant market window", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.drivers[2].evidence[1].publishedAt = "2026-08-21T22:00:01.000Z";
  assert.throws(
    () => validateReport(report, input),
    /外部证据不在本次市场窗口内/,
  );
});

test("event and official evidence cannot be published after the market close", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.drivers[0].evidence[1].publishedAt = "2026-08-21T07:00:01.000Z";
  assert.throws(
    () => validateReport(report, input),
    /外部证据不在本次市场窗口内/,
  );

  const dateOnly = fixtureReport(input);
  dateOnly.drivers[0].evidence[1].publishedAt = "2026-08-21";
  assert.throws(
    () => validateReport(dateOnly, input),
    /证据字段无效/,
  );
});

test("market evidence must copy an input URL and exact session close", () => {
  const input = validateInput(fixtureInput());
  const wrongUrl = fixtureReport(input);
  wrongUrl.drivers[0].evidence[0].source =
    "https://quotes.example.com/unverified";
  assert.throws(
    () => validateReport(wrongUrl, input),
    /行情证据必须逐字引用本次输入/,
  );

  const wrongTime = fixtureReport(input);
  wrongTime.drivers[0].evidence[0].publishedAt =
    "2026-08-21T07:00:01.000Z";
  assert.throws(
    () => validateReport(wrongTime, input),
    /行情证据必须逐字引用本次输入/,
  );

  const publisherFeed = fixtureReport(input);
  publisherFeed.drivers[0].evidence[0].sourceType = "publisher";
  assert.equal(validateReport(publisherFeed, input).drivers.length, 4);
});

test("market evidence facts and driver sectors must match the exact input source", () => {
  const input = validateInput(fixtureInput());
  const hallucinatedFact = fixtureReport(input);
  hallucinatedFact.drivers[0].evidence[0].facts =
    "原材料行业代表篮子上涨77.77%，并处于本次交易日表现前列。";
  assert.throws(
    () => validateReport(hallucinatedFact, input),
    /证据未提供的数字 77.77/,
  );

  const aiOnlySource = fixtureReport(input);
  const aiRow = input.aiChainPerformance.find(
    (item) => item.market === "CN" && item.layer === "interconnect",
  );
  aiOnlySource.drivers[0].evidence[0].source = aiRow.source;
  aiOnlySource.drivers[0].evidence[0].facts =
    "光互连代表篮子在本次交易日下跌，无法直接代表原材料行业。";
  assert.throws(
    () => validateReport(aiOnlySource, input),
    /行情证据与驱动行业不匹配/,
  );
});

test("numeric grounding ignores dates and enforces the reported direction", () => {
  const input = validateInput(fixtureInput());

  const dateLeak = fixtureReport(input);
  dateLeak.drivers[0].evidence[0].facts =
    "原材料行业在本次交易日上涨21%，但21只出现在行情日期中。";
  assert.throws(
    () => validateReport(dateLeak, input),
    /证据未提供的数字 21/,
  );

  const oppositeDirection = fixtureReport(input);
  oppositeDirection.drivers[0].evidence[0].facts =
    "原材料行业在本次交易日下跌1.95%，与输入行情方向相反。";
  assert.throws(
    () => validateReport(oppositeDirection, input),
    /数字 1.95.*涨跌方向与证据不一致/,
  );

  const exactDirection = fixtureReport(input);
  exactDirection.drivers[0].evidence[0].facts =
    "原材料行业在本次交易日上涨1.95%，与输入行情一致。";
  assert.equal(validateReport(exactDirection, input).drivers.length, 4);
});

test("AI updates require the matching layer data and direct external evidence", () => {
  const input = validateInput(fixtureInput());
  const wrongLayer = fixtureReport(input);
  wrongLayer.aiChainUpdates[0].evidence[0] =
    wrongLayer.drivers[0].evidence[0];
  assert.throws(
    () => validateReport(wrongLayer, input),
    /未引用对应 AI 环节的本地行情/,
  );

  const noExternal = fixtureReport(input);
  noExternal.aiChainUpdates[0].evidence =
    noExternal.aiChainUpdates[0].evidence.slice(0, 1);
  assert.throws(
    () => validateReport(noExternal, input),
    /evidence 数量必须为 2–4/,
  );
});

test("a generic AI overview URL cannot prove one exact layer", () => {
  const rawInput = fixtureInput();
  for (const row of rawInput.aiChainPerformance.filter(
    (item) => item.market === "CN",
  )) {
    row.source = "https://quotes.example.com/ai/CN/overview";
  }
  const input = validateInput(rawInput);
  const report = fixtureReport(input);
  assert.throws(
    () => validateReport(report, input),
    /未引用对应 AI 环节的本地行情/,
  );
});

test("AI view status must acknowledge accepted event evidence", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.aiChainViews.CN.driverStatus = "structural";
  assert.throws(
    () => validateReport(report, input),
    /有 AI 事件证据时不得标为纯结构性解释/,
  );
});

test("English AI translations may use numbers from AI-specific evidence", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.aiChainUpdates[0].evidence[1].facts +=
    " 公司同时披露相关订单同比增长17.24%。";
  report.aiChainUpdates[0].summary =
    "光互连代表篮子相对走弱，公司披露相关订单同比增长17.24%，但价格表现仍然承压。";
  report.translations.en.aiChainUpdates[0].summary =
    "The basket lagged even as disclosed orders rose 17.24%, so the event explained only part of the move.";
  assert.equal(validateReport(report, input).aiChainUpdates.length, 1);
});

test("reader copy rejects internal terms, raw timestamps and ungrounded numbers", () => {
  const input = validateInput(fixtureInput());
  const internal = fixtureReport(input);
  internal.summary = "本报告由 Codex pipeline stage 生成，因此行业轮动与材料方向获得支持。";
  assert.throws(() => validateReport(internal, input), /暴露了内部实现术语/);

  const rawTime = fixtureReport(input);
  rawTime.marketViews.CN.summary =
    "供应变化在 2026-08-21T05:10 出现，原材料走强而公用事业落后。";
  assert.throws(() => validateReport(rawTime, input), /未本地化的时间戳/);

  for (const term of ["Agent", "provider", "schema", "pipeline"]) {
    const exposed = fixtureReport(input);
    exposed.marketViews.CN.headline = `${term} 完成盘面归因`;
    assert.throws(
      () => validateReport(exposed, input),
      /暴露了内部实现术语/,
      term,
    );
  }

  const rawDate = fixtureReport(input);
  rawDate.marketViews.CN.headline = "2026-08-21 原材料行业走强";
  assert.throws(
    () => validateReport(rawDate, input),
    /未本地化的时间戳或日期/,
  );

  const internalSource = fixtureReport(input);
  internalSource.drivers[0].evidence[0].sourceLabel = "Codex API Skill";
  assert.throws(
    () => validateReport(internalSource, input),
    /暴露了内部实现术语/,
  );

  const rawEvidenceTime = fixtureReport(input);
  rawEvidenceTime.drivers[0].evidence[0].facts =
    "原材料行业在 2026-08-21T07:00 出现上涨，并与本地市场的收盘方向一致。";
  assert.throws(
    () => validateReport(rawEvidenceTime, input),
    /未本地化的时间戳/,
  );

  const hallucinated = fixtureReport(input);
  hallucinated.drivers[0].summary =
    "官方供应变化与原材料上涨99%的幅度一致，并为行业表现提供直接支撑。";
  assert.throws(
    () => validateReport(hallucinated, input),
    /证据未提供的数字 99/,
  );

  const localizedDate = fixtureReport(input);
  localizedDate.drivers[0].evidence[0].title =
    "原材料行业2026年8月21日收盘表现";
  assert.equal(validateReport(localizedDate, input).drivers.length, 4);

  const hallucinatedAiView = fixtureReport(input);
  hallucinatedAiView.aiChainViews.CN.summary =
    "光互连代表篮子下跌77.77%，而其他人工智能产业链环节表现分化。";
  assert.throws(
    () => validateReport(hallucinatedAiView, input),
    /证据未提供的数字 77.77/,
  );
});

test("numeric grounding cannot borrow a value from another market", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  const usMemory = input.aiChainPerformance.find(
    (item) => item.market === "US" && item.layer === "memory",
  );
  usMemory.change = "-6.01%";
  input.marketBriefs = buildMarketBriefs(input);

  const crossMarketDriver = fixtureReport(input);
  crossMarketDriver.drivers[0].summary =
    "供应变化与原材料行业下跌6.01%的方向一致，并为当天表现提供直接支撑。";
  assert.throws(
    () => validateReport(crossMarketDriver, input),
    /证据未提供的数字 6.01/,
  );

  report.marketViews.CN.summary =
    "原材料行业下跌6.01%，但这个数字只存在于美国市场的智能产业链行情。";
  assert.throws(
    () => validateReport(report, input),
    /证据未提供的数字 6.01/,
  );
});

test("X evidence handle must match the cited account", () => {
  const input = validateInput(fixtureInput());
  const wrongHandle = fixtureReport(input);
  wrongHandle.drivers[0].evidence[1].source =
    "https://x.com/materials_authority/status/123456789";
  wrongHandle.drivers[0].evidence[1].platform = "x";
  wrongHandle.drivers[0].evidence[1].authorHandle = "another_account";
  assert.throws(
    () => validateReport(wrongHandle, input),
    /平台与作者字段不一致/,
  );

  const matchingHandle = fixtureReport(input);
  matchingHandle.drivers[0].evidence[1].source =
    "https://x.com/materials_authority/status/123456789";
  matchingHandle.drivers[0].evidence[1].platform = "x";
  matchingHandle.drivers[0].evidence[1].authorHandle = "MATERIALS_AUTHORITY";
  matchingHandle.drivers[0].evidence[1].sourceType = "expert";
  matchingHandle.drivers[0].evidence.push(
    structuredClone(fixtureReport(input).aiChainUpdates[0].evidence[1]),
  );
  assert.equal(
    validateReport(matchingHandle, input).drivers[0].evidence[1].authorHandle,
    "materials_authority",
  );
});

test("input rejects legacy news fields and recomputed brief mismatches", () => {
  const legacy = fixtureInput();
  legacy.news = [];
  assert.throws(
    () => validateInput(legacy),
    /daily-input 不符合 codex-market-research-v10/,
  );

  const altered = fixtureInput();
  altered.marketBriefs.CN.sectorBreadth.advancing += 1;
  assert.throws(
    () => validateInput(altered),
    /marketBriefs 必须由本次确定性行情生成/,
  );

  const alteredHeat = fixtureInput();
  alteredHeat.sectorHeat.reverse();
  assert.throws(
    () => validateInput(alteredHeat),
    /sectorHeat 必须由完整一级行业确定性选出/,
  );
});
