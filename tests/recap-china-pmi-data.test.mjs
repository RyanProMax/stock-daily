import assert from "node:assert/strict";
import test from "node:test";
import { chinaPmiDocument, deriveChinaPmiContext } from "../scripts/china-pmi-release.mjs";
import { CHINA_PMI_INDEX, CHINA_PMI_INTERPRETATION_INDEX, chinaPmiResearchSources, chinaPmiSourceReader, collectRecapChinaPmiData, validateRecapChinaPmiData } from "../scripts/recap-china-pmi-data.mjs";
import { sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { completeRecapPlan } from "../scripts/complete-recap.mjs";
import { assertFactsNumbersInExcerpt, stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { indexHtml, interpretationUrl, openedHtml, pmiEnvelope, pmiHtml, pmiReader, releaseTitle, releaseUrl } from "./china-pmi-fixture.mjs";

test("PMI collection binds native directories, article identity, clocks and all four tables", async () => {
  const envelope = pmiEnvelope(), reader = pmiReader(), requests = [];
  const book = await collectRecapChinaPmiData(envelope, { reader: async (...args) => { requests.push(args[0]); return reader(...args); } });
  assert.deepEqual(requests, [CHINA_PMI_INDEX, releaseUrl, CHINA_PMI_INTERPRETATION_INDEX, interpretationUrl]);
  assert.deepEqual(book.gaps, []);
  assert.equal(book.context.publishedAt, "2026-09-30T01:30:00.000Z");
  assert.equal(book.context.period, "2026-09");
  assert.equal(book.context.previousPeriod, "2026-08");
  assert.equal(book.context.groups.manufacturing.newOrders.changePercentagePoints, -0.1);
  assert.equal(book.context.groups.manufacturing.newOrders.relativeTo50, "above");
  assert.equal(book.context.groups.nonManufacturing.newOrders.changePercentagePoints, 2.4);
  assert.equal(book.context.groups.nonManufacturing.newOrders.relativeTo50, "below");
  assert.equal(book.context.groups.manufacturingOther.inputPrices.changePercentagePoints, 4.2);
  assert.equal(book.context.groups.manufacturingOther.outputPrices.changePercentagePoints, 3.6);
  assert.equal(book.context.groups.manufacturingOther.newExportOrders.relativeTo50, "at");
  assert.equal(book.context.groups.manufacturing.supplierDeliveryTime.changePercentagePoints, 0);
  assert.equal(book.context.compositeOutput.previous, 49.5);
  assert.equal(book.context.compositeOutput.baselineBasis, "derived_from_narrated_monthly_change");
  assert.ok(book.context.limitations.some(value => value.includes("inverted")));
  assert.ok(book.context.limitations.some(value => value.includes("not CSI")));
  assert.equal(validateRecapChinaPmiData(book, envelope), book);
  book.context.groups.manufacturing.pmi.actual = 60.1;
  assert.throws(() => validateRecapChinaPmiData(book, envelope), /重建/);
});

test("native publication time survives immutable snapshot readback and has one authority origin", () => {
  const opened = openedHtml(releaseUrl, pmiHtml());
  assert.deepEqual(opened.publishedAtCandidates, ["2026-09-30T01:30:00.000Z"]);
  assert.deepEqual(opened.publishedDateCandidates, ["2026-09-30"]);
  const recovered = openedSourceFromSnapshot(snapshotFromOpenedSource(releaseUrl, opened));
  assert.deepEqual(recovered.articleProvenance, opened.articleProvenance);
  assert.equal(recovered.articleProvenance.origin.key, "authority:stats.gov.cn");
  const interpretation = openedHtml(interpretationUrl, pmiHtml({ interpretation: true }));
  assert.equal(interpretation.articleProvenance.origin.key, recovered.articleProvenance.origin.key);
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(pmiHtml()), "text/html", "https://unrelated.example/article"), []);
});

test("title, native header, metadata, clock, date and desktop/mobile mismatches cannot establish publication", () => {
  for (const html of [
    pmiHtml().replace(`<title>${releaseTitle}`, "<title>2025年9月中国采购经理指数运行情况"),
    pmiHtml().replace('name="ArticleTitle"', 'name="RecommendedTitle"'),
    pmiHtml().replace('name="PubDate"', 'name="ModifiedDate"'),
    pmiHtml().replace('content="2026/09/30 09:30"', 'content="2026/09/30 19:30"'),
    pmiHtml({ clock: "25:30" }),
    pmiHtml().replaceAll("2026/09/30", "2026/02/30"),
    pmiHtml().replaceAll("2026/09/30", "2026/09/29"),
    pmiHtml().replace("</head>", '<meta name="dateModified" content="2026-09-30T08:00:00Z"></head>'),
    pmiHtml().replace('<div class="mobile-news-content">', '<div class="mobile-news-content"><p>网页另一个版本有不同的订单数据。</p>'),
    pmiHtml().replace('var title1 =', 'var recommendedTitle ='),
  ]) {
    assert.equal(chinaPmiDocument(html, releaseUrl), null);
    assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(html), "text/html", releaseUrl), []);
    assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(html), "text/html", releaseUrl), []);
  }
});

test("changed tables, mismatched monthly narration, missing definitions and invalid cells reject rather than fill", () => {
  for (const html of [
    pmiHtml({ duplicate: false }).replace("<td>51.7</td>", "<td>52.7</td>"),
    pmiHtml({ duplicate: false }).replace("<td>49.8</td>", "<td>48.8</td>"),
    pmiHtml({ duplicate: false }).replaceAll("2026年8月", "2026年7月"),
    pmiHtml({ duplicate: false }).replaceAll("2026年8月", "2026年9月"),
    pmiHtml({ duplicate: false }).replaceAll("<td>50.1</td>", "<td>100.1</td>"),
    pmiHtml({ duplicate: false }).replace("<td>50.1</td>", "<td>—</td>"),
    pmiHtml({ duplicate: false }).replace("<td>新订单</td>", "<td>旧订单</td>"),
    pmiHtml({ duplicate: false }).replace("供应商配送时间指数为逆指数", "供应商配送时间指数为正指数"),
  ]) assert.throws(() => deriveChinaPmiContext(chinaPmiDocument(html, releaseUrl)));
});

test("unavailable, stale, future or directory-inconsistent releases stay explicit gaps", async () => {
  for (const overrides of [
    new Map([[CHINA_PMI_INDEX, new Error("HTTP 503")]]),
    new Map([[releaseUrl, new Error("HTTP 403")]]),
    new Map([[releaseUrl, pmiHtml({ clock: "16:30" })]]),
    new Map([[CHINA_PMI_INDEX, indexHtml({ date: "2026-09-29" })]]),
    new Map([[CHINA_PMI_INDEX, indexHtml({ date: "2026-10-01" })]]),
    new Map([[CHINA_PMI_INDEX, indexHtml({ date: "2026-07-31" })]]),
    new Map([[CHINA_PMI_INDEX, indexHtml({ listedUrl: "https://unrelated.example/release.html" })]]),
  ]) {
    const book = await collectRecapChinaPmiData(pmiEnvelope(), { reader: pmiReader(overrides) });
    assert.equal(book.context, null);
    assert.ok(book.gaps.length > 0);
    assert.equal(book.release, null);
    validateRecapChinaPmiData(book, pmiEnvelope());
  }
  const book = await collectRecapChinaPmiData(pmiEnvelope(), { reader: pmiReader(new Map([[interpretationUrl, new Error("HTTP 503")]])) });
  assert.ok(book.context);
  assert.deepEqual(book.context.interpretationPassages, []);
  assert.equal(book.gaps[0].stage, "interpretation");
  book.gaps = [];
  assert.throws(() => validateRecapChinaPmiData(book, pmiEnvelope()), /缺口/);
});

test("a bounded second official directory page is used only when the native homepage supports pagination", async () => {
  const overrides = new Map([[CHINA_PMI_INDEX, indexHtml({ entries: false, paginated: true })], [`${CHINA_PMI_INDEX}index_1.html`, indexHtml()]]);
  const book = await collectRecapChinaPmiData(pmiEnvelope(), { reader: pmiReader(overrides) });
  assert.equal(book.indexes.length, 3);
  assert.equal(book.context.period, "2026-09");
  const changed = structuredClone(book);
  changed.indexes[0] = snapshotFromOpenedSource(CHINA_PMI_INDEX, openedHtml(CHINA_PMI_INDEX, indexHtml({ entries: false })));
  assert.throws(() => validateRecapChinaPmiData(changed, pmiEnvelope()), /分页/);
});

test("fresh PMI facts pass the normal verifier at event-only scope and cannot masquerade as CSI exposure", async () => {
  const envelope = pmiEnvelope(), book = await collectRecapChinaPmiData(envelope, { reader: pmiReader() });
  const sources = chinaPmiResearchSources(book, envelope, completeRecapPlan(envelope));
  assert.ok(sources.length > 10);
  assert.ok(sources.every(source => source.scope === "event_only" && source.causalConnection === false));
  const ledger = await verifyResearchSources([{ sources, alternatives: [] }], envelope, { reader: chinaPmiSourceReader(book, async () => { throw new Error("Frozen original must be reused"); }) });
  assert.equal(ledger.sources.length, sources.length);
  assert.equal(ledger.rejected.length, 0);
  assert.equal(new Set(ledger.sources.map(source => source.reportingOrigin.key)).size, 1);
  assert.ok(ledger.sources.every(source => source.surveyChecked === true && source.surveyDefinition.period === "2026-09"));
  const originals = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [book.release, book.interpretation] };
  auditLedgerSourceSnapshots(ledger, originals, { envelope, macroData: { chinaPmi: book } });
  const changedLedger = structuredClone(ledger); changedLedger.sources[0].surveyDefinition.measure = "realized_output_growth";
  assert.throws(() => auditLedgerSourceSnapshots(changedLedger, originals, { envelope, macroData: { chinaPmi: book } }), /调查口径/);
  const widened = await verifyResearchSources([{ sources: [{ ...sources[0], scope: "sector" }], alternatives: [] }], envelope, { reader: chinaPmiSourceReader(book) });
  assert.equal(widened.sources.length, 0);
  assert.match(widened.rejected[0].reason, /公共事件范围/);
  const tampered = structuredClone(book); tampered.release.bodyHash = stableHash("fake");
  assert.throws(() => chinaPmiResearchSources(tampered, envelope, completeRecapPlan(envelope)), /哈希/);
  const later = structuredClone(envelope); later.session.windowStart = "2026-10-08T07:00:00Z";
  assert.deepEqual(chinaPmiResearchSources(book, later, completeRecapPlan(later)), []);
});

test("an official interpretation contradicting the release is excluded with its reason retained", async () => {
  const book = await collectRecapChinaPmiData(pmiEnvelope(), { reader: pmiReader(new Map([[interpretationUrl, pmiHtml({ interpretation: true }).replaceAll("50.1%", "51.1%")]])) });
  assert.ok(book.context);
  assert.equal(book.interpretation, null);
  assert.equal(book.context.interpretationSource, null);
  assert.match(book.gaps[0].reason, /当值或环比不一致/);
});

test("slightly falling PMI component changes preserve their negative direction and unquoted months still fail", () => {
  const quote = "制造业生产指数为51.7%，比上月上升1.3个百分点，新订单指数为50.5%，比上月略降0.1个百分点，两个指数均高于临界点。";
  for (const verb of ["略降", "微降", "小幅降"]) {
    const supportingExcerpt = quote.replace("略降", verb);
    assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "生产指数为51.7%，比上月上升1.3个百分点；新订单指数为50.5%，比上月下降0.1个百分点。", supportingExcerpt }));
    assert.throws(() => assertFactsNumbersInExcerpt({ facts: "新订单指数比上月上升0.1个百分点。", supportingExcerpt }), /数字/);
    assert.throws(() => assertFactsNumbersInExcerpt({ facts: "9月份新订单指数比上月下降0.1个百分点。", supportingExcerpt }), /9/u);
  }
});
