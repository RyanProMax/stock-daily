import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { fixturePdf } from "./pdf-fixture.mjs";
import { collectRecapCompanyBackgroundData, validateRecapCompanyBackgroundData, companyBackgroundSourceReader } from "../scripts/recap-company-background-data.mjs";
import { CNINFO_REGISTRY_URL, CNINFO_HISTORY_URL, cninfoHistoryBody, cninfoLatestPeriodic, validateCninfoHistoryBody } from "../scripts/cninfo-history-request.mjs";
import { companyExposureExcerpts } from "../scripts/company-exposure-excerpts.mjs";
import { readExternalSource } from "../scripts/daily-source-audit.mjs";
import { auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { verifyResearchSources } from "../scripts/daily-workflow-core.mjs";

const digest = body => createHash("sha256").update(body).digest("hex");
const date = "2026-07-01";
function fixture() {
  const f = recapFixture("CN"), anomaly = f.plan.anomalies.find(item => item.kind === "ai_layer");
  for (const [index, item] of anomaly.observation.constituents.entries()) Object.assign(item, { symbol: ["688981.SS", "002371.SZ", "688041.SS", "688256.SS"][index], name: ["样例芯片", "样例设备", "样例计算", "样例智能"][index] });
  f.smallPlan = { ...f.plan, anomalies: [anomaly] };
  f.entities = anomaly.observation.constituents.map((item, index) => ({ symbol: item.symbol, code: item.symbol.slice(0, 6), name: item.name, orgId: `fixture${index}`, id: String(1225586480 + index) }));
  f.registry = { stockList: f.entities.map(e => ({ code: e.code, orgId: e.orgId, zwjc: e.name, category: "A股" })) };
  f.histories = new Map(); f.pdfs = new Map(); f.metadata = new Map(); f.requests = [];
  for (const e of f.entities) {
    const a = { secCode: e.code, secName: e.name, orgId: e.orgId, announcementId: e.id, announcementTitle: "2026年半年度报告", announcementTime: Date.parse(date + "T00:00:00+08:00"), adjunctType: "PDF", adjunctUrl: `finalpage/${date}/${e.id}.PDF` };
    const summary = { ...a, announcementId: String(Number(e.id) + 100), announcementTitle: "2026年半年度报告摘要", adjunctUrl: `finalpage/${date}/${Number(e.id) + 100}.PDF` };
    f.histories.set(e.symbol, { announcements: [summary, a], hasMore: false, totalAnnouncement: 2, totalRecordNum: 2 });
    const source = "https://static.cninfo.com.cn/" + a.adjunctUrl;
    f.pdfs.set(source, fixturePdf([[`证券代码：${e.code} 证券简称：${e.name}`, `${e.name}股份有限公司`, a.announcementTitle, "本公司董事会及全体董事保证本报告内容不存在虚假记载、误导性陈述。"], ["本公司的客户需求及经营成本受到宏观经济和供应链变化的影响，融资条件可能影响客户的投资计划与订单兑现。", "但是，本公司主要债务采用固定利率，市场利率变化对这部分债务的利息支出没有直接影响，订单的实际变化仍具有不确定性。"]]));
    f.metadata.set(e.id, { announcement: a, fileUrl: source });
  }
  f.reader = (url, options) => readExternalSource(url, { ...options, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async (value, destination, request) => {
    assert.equal(destination.address, "8.8.8.8");
    f.requests.push({ url: value, method: request.method ?? "GET", body: request.requestBody });
    let result, contentType = "application/json;charset=UTF-8";
    if (value === CNINFO_REGISTRY_URL) result = f.registry;
    else if (value === CNINFO_HISTORY_URL) {
      assert.equal(request.method, "POST");
      const stock = new URLSearchParams(validateCninfoHistoryBody(request.requestBody)).get("stock");
      const e = f.entities.find(entity => stock === `${entity.code},${entity.orgId}`);
      assert.ok(e); result = f.histories.get(e.symbol);
    } else if (f.pdfs.has(value)) { result = f.pdfs.get(value); contentType = "application/pdf"; }
    else { assert.equal(request.method, "POST"); result = f.metadata.get(new URL(value).searchParams.get("announceId")); assert.ok(result, value); }
    return { status: 200, contentType, body: Buffer.isBuffer(result) ? result : Buffer.from(JSON.stringify(result)) };
  } });
  return f;
}

test("native form queries, registry identities, latest complete reports and PDF publication records produce replayable narrow Chinese exposures", async () => {
  const f = fixture(), book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  assert.equal(book.profiles.length, 4); assert.equal(book.filings.length, 4); assert.equal(book.sources.length, 4); assert.deepEqual(book.gaps, []);
  assert.ok(book.profiles.every(p => p.receipt.requestMethod === "POST" && p.receipt.requestBodyHash === digest(p.receipt.requestBody)));
  assert.ok(book.sources.every(s => s.targets.length === 1 && s.kind === "background" && s.publishedAt === date && !s.causalConnection && s.supportingExcerpt.includes("没有直接影响")));
  const historyIndex = f.requests.findIndex(r => r.url === CNINFO_HISTORY_URL), lastHistoryIndex = f.requests.findLastIndex(r => r.url === CNINFO_HISTORY_URL);
  assert.ok(historyIndex >= 0 && lastHistoryIndex < f.requests.findIndex(r => f.pdfs.has(r.url)));
  const ledger = await verifyResearchSources([{ sources: book.sources, alternatives: [] }], f.envelope, { reader: companyBackgroundSourceReader(book) });
  assert.equal(ledger.sources.length, 4, JSON.stringify(ledger.rejected));
  assert.deepEqual(ledger.sources.flatMap(s => s.backgroundSubjects).sort(), f.entities.map(e => e.symbol).sort());
  assert.doesNotThrow(() => auditLedgerSourceSnapshots(ledger, { version: SOURCE_SNAPSHOT_VERSION, snapshots: book.filings.map(f => f.snapshot) }, { envelope: f.envelope }));
  const resumed = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { resumeBook: book, reader: () => { throw new Error("no network on frozen replay"); } });
  assert.deepEqual(resumed, book);
});

test("current registry renaming retains each historical record and PDF's own issuer name", async () => {
  const f = fixture(); f.registry.stockList[0].zwjc = "改名后的公司";
  const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  assert.equal(book.filings.length, 4); assert.deepEqual(book.gaps, []);
  assert.ok(book.sources[0].title.startsWith(f.entities[0].name + "："));
});

test("native full legal-name title prefixes bind to the same name printed in the PDF, and corrected-period labels remain eligible", async () => {
  const f = fixture(), e = f.entities[0], history = f.histories.get(e.symbol);
  history.announcements[1].announcementTitle = e.name + "股份有限公司2026年半年度报告";
  f.metadata.get(e.id).announcement.announcementTitle = history.announcements[1].announcementTitle;
  const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  assert.equal(book.filings.length, 4); assert.deepEqual(book.gaps, []);
  const corrected = structuredClone(history); corrected.announcements[1].announcementTitle = "2026年半年度报告（更正后）";
  assert.equal(cninfoLatestPeriodic(corrected, e, f.envelope).announcementId, e.id);
  const forged = structuredClone(history); forged.announcements[1].announcementTitle = "其他公司2026年半年度报告";
  assert.throws(() => cninfoLatestPeriodic(forged, e, f.envelope), /发行人前缀/);
  const wrong = structuredClone(f.metadata.get(e.id)); wrong.announcement.announcementTitle = "其他公司股份有限公司2026年半年度报告";
  f.metadata.set(e.id, wrong);
  const refused = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  assert.equal(refused.filings.length, 3); assert.ok(refused.gaps.some(g => g.symbol === e.symbol));
});

test("tampered native bodies, swapped form targets, another org and changed filing metadata fail independently frozen validation", async () => {
  const f = fixture(), book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader: f.reader });
  for (const mutate of [
    b => b.registry.bodyHash = "0".repeat(64),
    b => b.profiles[0].receipt.requestBody = b.profiles[1].receipt.requestBody,
    b => b.profiles[0].receipt.requestMethod = "GET",
    b => { const r = b.profiles[0].receipt, v = JSON.parse(Buffer.from(r.bodyBase64, "base64")); v.announcements[0].orgId = "otherOrg"; const body = Buffer.from(JSON.stringify(v)); r.bodyBase64 = body.toString("base64"); r.bodyHash = digest(body); },
    b => b.filings[0].snapshot.metadataReceipts[0] = structuredClone(b.filings[1].snapshot.metadataReceipts[0]),
    b => b.sources[0].targets = [f.entities[1].symbol],
    b => b.sources[0].causalConnection = true,
  ]) { const changed = structuredClone(book); mutate(changed); assert.throws(() => validateRecapCompanyBackgroundData(changed, f.envelope, f.smallPlan)); }
});

test("native pagination, issuer ambiguity and out-of-query records cannot select an older convenient disclosure", () => {
  const f = fixture(), e = f.entities[0], value = f.histories.get(e.symbol);
  for (const mutate of [v => v.hasMore = true, v => v.totalRecordNum = 31, v => v.announcements[0].secCode = "600999", v => v.announcements[0].announcementTime = Date.parse("2026-08-30T00:00:00+08:00"), v => v.announcements.push(v.announcements[0]), v => v.announcements[1].announcementTitle = "2028年半年度报告", v => v.announcements[1].announcementTitle += "（未支持的新版格式）"]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => cninfoLatestPeriodic(changed, e, f.envelope));
  }
  const onlySummary = { ...value, announcements: [value.announcements[0]], totalAnnouncement: 1, totalRecordNum: 1 };
  assert.equal(cninfoLatestPeriodic(onlySummary, e, f.envelope), null);
  assert.equal(cninfoLatestPeriodic({ ...value, announcements: [], totalAnnouncement: 0, totalRecordNum: 0 }, e, f.envelope), null);
});

test("summary-only lists and unreadable latest PDFs remain explicit issuer gaps with their valid native profiles retained", async () => {
  for (const mode of ["summary", "unreadable", "registry_missing", "ambiguous"]) {
    const f = fixture();
    if (mode === "summary") for (const v of f.histories.values()) { v.announcements = [v.announcements[0]]; v.totalAnnouncement = v.totalRecordNum = 1; }
    if (mode === "unreadable") for (const url of f.pdfs.keys()) f.pdfs.set(url, Buffer.from("not a PDF"));
    if (mode === "ambiguous") f.registry.stockList.push(f.registry.stockList[0]);
    const reader = mode === "registry_missing" ? async () => { throw new Error("HTTP 503"); } : f.reader;
    const book = await collectRecapCompanyBackgroundData(f.envelope, f.smallPlan, { reader });
    assert.ok(book.gaps.length >= (mode === "ambiguous" ? 1 : 4));
    assert.equal(book.profiles.length, mode === "summary" || mode === "unreadable" ? 4 : mode === "ambiguous" ? 3 : 0);
    assert.doesNotThrow(() => validateRecapCompanyBackgroundData(book, f.envelope, f.smallPlan));
    if (mode !== "ambiguous") assert.deepEqual(book.sources, []);
  }
});

test("read-only form transport refuses arbitrary URLs, altered fields, search bodies and redirects without forwarding the POST", async () => {
  const f = fixture(), body = cninfoHistoryBody(f.entities[0], f.envelope);
  for (const url of ["https://www.cninfo.com.cn/new/save", CNINFO_HISTORY_URL + "?unbound=1"]) await assert.rejects(readExternalSource(url, { structured: true, cninfoHistory: body }), /只读地址/);
  for (const changed of [body + "&operation=save", body.replace("searchkey=", "searchkey=unbound"), body.replace("pageSize=30", "pageSize=300"), body.replace("stock=", "stock=127.0.0.1")]) assert.throws(() => validateCninfoHistoryBody(changed));
  let calls = 0;
  await assert.rejects(readExternalSource(CNINFO_HISTORY_URL, { structured: true, cninfoHistory: body, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async () => { calls++; return { status: 307, location: "https://other.example", contentType: "text/html", body: Buffer.from("redirect") }; } }), /不得跳转/);
  assert.equal(calls, 1);
});

test("Chinese extraction preserves qualifications and refuses accounting, generic governance or unowned competitor paragraphs", () => {
  const text = "本公司的客户需求和经营成本受宏观经济变化影响，融资条件可能使部分客户推迟资本支出并影响订单实现。 但是，本公司主要债务采用固定利率，利率变化对该部分债务没有直接影响，实际订单仍具有不确定性。";
  assert.deepEqual(companyExposureExcerpts(text, { language: "zh", issuerName: "样例公司" }), [text]);
  for (const changed of [text.replaceAll("本公司", "其他企业"), "本公司董事会保证报告不存在虚假记载，对风险说明承担责任。", "本公司按会计准则对金融资产和融资租赁的公允价值计量，使用假设利率估计财务报表附注中的相关会计项目。", text + " 但是" + "风险".repeat(350) + "。"])
    assert.deepEqual(companyExposureExcerpts(changed, { language: "zh", issuerName: "样例公司" }), []);
});
