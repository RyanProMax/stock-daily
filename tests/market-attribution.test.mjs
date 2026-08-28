import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReportContent,
  numericClaims,
  validateInput,
  validateReport,
  verifiedExternalSourceType,
} from "../scripts/daily-publish.mjs";
import { buildMarketBriefs } from "../scripts/daily-collect.mjs";
import {
  buildMarketSessions,
  driverDirectionMatches,
  zonedDateTimeIso,
} from "../scripts/market-attribution.mjs";
import { metricAtCutoff } from "../scripts/sector-heat.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

test("V11 accepts deterministic market input without a preselected news pool", () => {
  const input = validateInput(fixtureInput());
  assert.equal(input.contractVersion, "codex-market-research-v11");
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

test("numeric grounding ignores localized calendar dates", () => {
  assert.deepEqual(numericClaims("On Aug. 24, the market rose 0.59%."), [
    {
      raw: "0.59",
      number: "0.59",
      unit: "percent",
      polarity: "positive",
    },
  ]);
  assert.deepEqual(numericClaims("8月24日，市场上涨0.59%。"), [
    {
      raw: "0.59",
      number: "0.59",
      unit: "percent",
      polarity: "positive",
    },
  ]);
  assert.deepEqual(numericClaims("商业活动升至五十二个月高位。"), [
    {
      raw: "52",
      number: "52",
      unit: "count",
      polarity: "neutral",
    },
  ]);
  assert.deepEqual(numericClaims("Activity reached a 52-month high."), [
    {
      raw: "52",
      number: "52",
      unit: "count",
      polarity: "neutral",
    },
  ]);
});

test("numeric grounding accepts the deterministic ten-year Treasury tenor", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  const treasury = input.markets.find((item) => item.symbol === "DGS10");
  report.drivers[2].evidence[0] = {
    title: "美国十年期国债收益率日行情",
    facts: `输入行情显示，美国十年期国债收益率当日${treasury.change}。`,
    source: treasury.source,
    sourceLabel: "美国联邦储备经济数据库",
    publishedAt: input.marketSessions.find((item) => item.market === "US").windowEnd,
    kind: "market_data",
    sourceType: "publisher",
    platform: "web",
    authorHandle: "",
  };
  assert.doesNotThrow(() => validateReport(report, input));
});

test("historical sector replay selects each venue's completed session", () => {
  const sector = { symbol: "sector", name: "行业", nameEn: "Sector" };
  const points = [
    { date: "2026-08-21", change: 1 },
    { date: "2026-08-24", change: 2 },
  ];
  const cutoff = Date.parse("2026-08-24T13:00:00.000Z");
  assert.equal(metricAtCutoff(sector, "CN", points, cutoff).asOf, "2026-08-24");
  assert.equal(metricAtCutoff(sector, "US", points, cutoff).asOf, "2026-08-21");
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

test("mixed macro direction may combine an index rise with a sector decline", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  const usDriver = report.drivers.find((driver) => driver.market === "US");
  const usIndex = input.markets.find(
    (market) => market.region === "US" && market.direction === "up",
  );
  const downSector = input.sectorPerformance.find(
    (sector) => sector.market === "US" && sector.direction === "down",
  );
  usDriver.direction = "mixed";
  usDriver.sectorSymbols = [downSector.symbol];
  usDriver.attributionTargets = [downSector.symbol];
  const hypothesis = report.researchAudit.US.hypotheses.find(
    (item) => item.publishedTitle === usDriver.title,
  );
  hypothesis.targets = [downSector.symbol];
  hypothesis.causalEvidence[0].targets = [downSector.symbol];
  usDriver.evidence[0] = {
    ...usDriver.evidence[0],
    title: "美国指数收盘表现",
    facts: `输入行情显示，美国指数当日${usIndex.change}。`,
    source: usIndex.source,
  };
  usDriver.evidence.splice(
    1,
    0,
    {
      ...usDriver.evidence[0],
      title: "美国行业收盘表现",
      facts: `输入行情显示，美国行业当日${downSector.change}。`,
      source: downSector.source,
    },
  );
  assert.equal(validateReport(report, input).drivers[2].direction, "mixed");
});

test("V11 accepts only evidence-backed event and macro drivers", () => {
  const input = validateInput(fixtureInput());
  const report = validateReport(fixtureReport(input), input);
  assert.equal(report.drivers.length, 4);
  for (const market of ["CN", "US"]) {
    const drivers = report.drivers.filter((driver) => driver.market === market);
    assert.equal(drivers.filter((driver) => driver.role === "primary").length, 1);
    assert.ok(
      drivers.every(
        (driver) => driver.basis === "event" || driver.basis === "macro",
      ),
    );
  }
  const stored = JSON.parse(buildReportContent(input, report));
  assert.equal(stored.contractVersion, "codex-market-research-v11");
  assert.equal(Object.hasOwn(stored, "researchAudit"), false);
  assert.equal(stored.stories.length, 0);
  assert.equal(stored.drivers[0].basis, "event");
  assert.equal(stored.drivers[0].evidence[0].kind, "market_data");
});

test("every published attribution must trace to one accepted causal hypothesis", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.researchAudit.CN.hypotheses[0].publishedTitle =
    "与报告不一致的候选标题";
  assert.throws(
    () => validateReport(report, input),
    /发布归因未唯一映射到接受的候选原因/,
  );
});

test("published attribution requires an exact causal claim and matching evidence scope", () => {
  const input = validateInput(fixtureInput());
  const mismatchedHypothesis = fixtureReport(input);
  mismatchedHypothesis.researchAudit.CN.hypotheses[0].claim =
    "供应变化大概有利于原材料行业。";
  assert.throws(
    () => validateReport(mismatchedHypothesis, input),
    /接受命题必须逐字等于最终发布机制/,
  );

  const wrongClaim = fixtureReport(input);
  wrongClaim.researchAudit.CN.hypotheses[0].publishedClaim += "额外推断。";
  assert.throws(
    () => validateReport(wrongClaim, input),
    /没有来源级证据完整支持 publishedClaim/,
  );

  const wrongScope = fixtureReport(input);
  wrongScope.researchAudit.CN.hypotheses[0].causalEvidence[0].targets = [
    "932086",
  ];
  assert.throws(
    () => validateReport(wrongScope, input),
    /缺少范围匹配的逐条因果证据/,
  );

  const partialSupport = fixtureReport(input);
  partialSupport.researchAudit.CN.hypotheses[0].causalEvidence[0].supports =
    "来源只证明事件存在，但没有完整支持最终发布机制。";
  assert.throws(
    () => validateReport(partialSupport, input),
    /没有来源级证据完整支持 publishedClaim/,
  );
});

test("subsector attribution stays attached to a parent sector without widening scope", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  const driver = report.drivers[0];
  const hypothesis = report.researchAudit.CN.hypotheses[0];
  driver.attributionScope = "subsector";
  driver.attributionTargets = ["工业金属"];
  hypothesis.targets = ["工业金属", driver.sectorSymbols[0]];
  hypothesis.causalEvidence[0].scope = "subsector";
  hypothesis.causalEvidence[0].targets = ["工业金属"];
  assert.equal(validateReport(report, input).drivers[0].attributionScope, "subsector");

  hypothesis.causalEvidence[0].targets = ["券商"];
  assert.throws(
    () => validateReport(report, input),
    /缺少范围匹配的逐条因果证据/,
  );
});

test("unresolved hypotheses may retain partial source evidence without publishing it", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.researchAudit.US.hypotheses[2].causalEvidence = [{
    source: "https://example.com/partial-company-event",
    supports: "The source confirms a company event but does not establish its same-day market impact.",
    scope: "company",
    targets: ["CRWV"],
  }];
  assert.doesNotThrow(() => validateReport(report, input));
});

test("rejected and unresolved hypotheses cannot leak into reader attribution", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.researchAudit.US.hypotheses[2].publishedAs = "market_driver";
  report.researchAudit.US.hypotheses[2].publishedTitle =
    report.drivers.find((driver) => driver.market === "US").title;
  assert.throws(
    () => validateReport(report, input),
    /未接受的候选原因不得进入读者报告/,
  );
});

test("research must record at least one rejected or unresolved alternative", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.researchAudit.US.hypotheses[2] = {
    ...report.researchAudit.US.hypotheses[1],
    id: "US-H3",
  };
  assert.throws(
    () => validateReport(report, input),
    /必须记录至少一个被拒绝或未决的替代原因/,
  );
});

test("V11 permits no driver when evidence is insufficient and requires one primary otherwise", () => {
  const input = validateInput(fixtureInput());
  const noCnDrivers = fixtureReport(input);
  noCnDrivers.drivers = noCnDrivers.drivers.filter(
    (driver) => driver.market !== "CN",
  );
  noCnDrivers.translations.en.drivers = noCnDrivers.translations.en.drivers.slice(
    2,
  );
  noCnDrivers.marketViews.CN.driverStatus = "insufficient";
  noCnDrivers.researchAudit.CN.hypotheses =
    noCnDrivers.researchAudit.CN.hypotheses.map((hypothesis) =>
      hypothesis.publishedAs === "market_driver"
        ? {
            ...hypothesis,
            verdict: "unresolved",
            verdictReason:
              "测试报告没有发布该候选原因，因此保留为未决线索而不是读者结论。",
            publishedAs: "none",
            publishedTitle: "",
            publishedClaim: "",
          }
        : hypothesis,
    );
  assert.equal(
    validateReport(noCnDrivers, input).drivers.filter(
      (driver) => driver.market === "CN",
    ).length,
    0,
  );

  const duplicatePrimary = fixtureReport(input);
  duplicatePrimary.drivers[1].role = "primary";
  assert.throws(
    () => validateReport(duplicatePrimary, input),
    /CN 有驱动时必须恰好包含一条主驱动/,
  );
});

test("structural contributions are rejected as publishable attribution", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.drivers[1].basis = "structural";
  assert.throws(
    () => validateReport(report, input),
    /分类字段无效/,
  );
});

test("insufficient AI evidence forbids a reader-facing mechanism", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  report.aiChainViews.US.mechanism =
    "代表篮子的涨跌方向不同，但没有直接事件证据支持原因判断。";
  assert.throws(
    () => validateReport(report, input),
    /证据不足时不得输出 AI 归因机制/,
  );

  const translated = fixtureReport(input);
  translated.translations.en.aiChainViews.US.mechanism =
    "The baskets diverged, but no direct event evidence supports a cause.";
  assert.throws(
    () => validateReport(translated, input),
    /证据不足时不得输出归因机制/,
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
    /evidence 数量必须为 2–4/,
  );

  const expertOnly = fixtureReport(input);
  expertOnly.drivers[0].evidence[1].sourceType = "expert";
  assert.throws(
    () => validateReport(expertOnly, input),
    /来源层级与 URL 不一致/,
  );
});

test("external source authority is derived from the cited URL", () => {
  assert.equal(
    verifiedExternalSourceType(
      "https://www.latimes.com/business/story/2026-08-26/market-wrap",
    ),
    "publisher",
  );
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
  const equivalentTime = fixtureReport(input);
  equivalentTime.drivers[0].evidence[0].publishedAt =
    input.marketSessions.find((item) => item.market === "CN").windowEnd.replace(
      ".000Z",
      "Z",
    );
  assert.equal(validateReport(equivalentTime, input).drivers.length, 4);

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

test("market attribution accepts a reader-facing market target alias", () => {
  const input = validateInput(fixtureInput());
  const report = fixtureReport(input);
  const driver = report.drivers[2];
  const hypothesis = report.researchAudit.US.hypotheses[0];
  driver.attributionScope = "market";
  driver.attributionTargets = ["U.S. stocks"];
  hypothesis.targets = ["U.S. stocks"];
  hypothesis.causalEvidence[0].scope = "market";
  hypothesis.causalEvidence[0].targets = ["U.S. stocks"];
  assert.equal(validateReport(report, input).drivers[2].attributionScope, "market");
});

test("market evidence facts and driver sectors must match the exact input source", () => {
  const input = validateInput(fixtureInput());
  const hallucinatedFact = fixtureReport(input);
  hallucinatedFact.drivers[0].evidence[0].facts =
    "原材料行业代表篮子上涨77.77%，并处于本次交易日表现前列。";
  assert.throws(() => validateReport(hallucinatedFact, input), (error) => {
    assert.match(error.message, /证据未提供的数字 77.77/);
    assert.match(error.message, /请删除该数字或在对应 facts 中记录同值同单位/);
    assert.match(error.message, /原材料行业代表篮子上涨77.77%/);
    return true;
  });

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

test("sector evidence canonicalizes a model-invented Yahoo quote URL", () => {
  const rawInput = fixtureInput();
  const sector = rawInput.sectorPerformance.find(
    (item) => item.market === "CN" && item.symbol === "932078",
  );
  sector.source =
    "https://www.csindex.com.cn/#/indices/family/detail?indexCode=932078";
  const input = validateInput(rawInput);
  const report = fixtureReport(input);
  report.drivers[0].evidence[0].source =
    "https://finance.yahoo.com/quote/932078.SS/history";
  report.drivers[0].evidence[0].sourceLabel = "Yahoo Finance";
  report.drivers[0].evidence[0].sourceType = "publisher";
  const evidence = validateReport(report, input).drivers[0].evidence[0];
  assert.equal(evidence.source, sector.source);
  assert.equal(evidence.sourceLabel, "中证指数有限公司");
  assert.equal(evidence.sourceType, "first_party");
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
  report.aiChainViews.CN.driverStatus = "insufficient";
  assert.throws(
    () => validateReport(report, input),
    /有 AI 事件证据时不得标记为证据不足/,
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
  matchingHandle.researchAudit.CN.hypotheses[0].supportingSources = [
    "https://www.sse.com.cn/disclosure/interconnect-order",
  ];
  matchingHandle.researchAudit.CN.hypotheses[0].causalEvidence[0].source =
    "https://www.sse.com.cn/disclosure/interconnect-order";
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
    /daily-input 不符合 codex-market-research-v11/,
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
