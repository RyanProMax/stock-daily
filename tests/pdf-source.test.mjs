import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { pdfSourceRecord } from "../scripts/pdf-source.mjs";
import { verifiedPdfListMarker } from "../scripts/pdf-source-glyphs.mjs";
import { cninfoPdfIdentity, cninfoPdfPublication } from "../scripts/cninfo-pdf-publication.mjs";
import { readExternalSource, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { verifyResearchSources, stableHash, validateResearchOutput } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { cninfoCashDividendSchedule, verifiedCurrentCorporateAction } from "../scripts/recap-corporate-actions.mjs";
import { ATTRIBUTION_VERSION, recapAttributionCandidates, validateRecapAttribution } from "../scripts/recap-attribution.mjs";
import { recapTargets } from "../scripts/complete-recap.mjs";

const url = "https://static.cninfo.com.cn/finalpage/2026-08-20/1225586487.PDF";
const lines = ["证券代码：600123 证券简称：样例医药 公告编号：临2026-154", "样例医药股份有限公司", "关于签署授权许可协议的公告", "本公司董事会及全体董事保证本公告内容不存在虚假记载、误导性陈述。", "样例医药股份有限公司的潜在许可交易最高可达26亿美元，包括3亿美元首付款及符合条件的里程碑付款。", "该协议需获得监管批准并满足其他交割条件，海外批准及里程碑付款具有不确定性。"];
function fixturePdf(pages = [lines], imagePages = []) {
  const unicode = text => [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>", "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /FontDescriptor 6 0 R /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>"];
  const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const chars = [...new Set(pages.flat().join(""))];
  const cmap = [];
  for (let i = 0; i < chars.length; i += 100) { const group = chars.slice(i, i + 100); cmap.push(`${group.length} beginbfchar\n` + group.map(char => `<${unicode(char)}> <${unicode(char)}>`).join("\n") + "\nendbfchar"); }
  objects.push(stream("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" + cmap.join("\n") + "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end"));
  objects.push("<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>");
  const kids = [];
  for (const [index, page] of pages.entries()) {
    const imageId = imagePages.includes(index) ? objects.length + 1 : null;
    if (imageId) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\n00>\nendstream");
    const id = objects.length + 1; kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${imageId ? `/XObject << /Im0 ${imageId} 0 R >>` : ""} >> /Contents ${id + 1} 0 R >>`);
    objects.push(stream("BT /F1 10 Tf 40 760 Td\n" + page.map(text => `<${unicode(text)}> Tj 0 -18 Td`).join("\n") + "\nET" + (imageId ? "\nq 100 0 0 100 100 100 cm /Im0 Do Q" : "")));
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  let body = "%PDF-1.7\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(body + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const pdf = fixturePdf([lines, ["授权区域为约定的海外市场。本公司可能无法实现相关里程碑，收入规模和确认时间仍有不确定性。"]]);
function metadata() { return { announcement: { secCode: "600123", secName: "样例医药", orgId: "example123", announcementId: "1225586487", announcementTitle: "样例医药关于签署授权许可协议的公告", announcementTime: Date.parse("2026-08-20T00:00:00+08:00"), storageTime: Date.parse("2026-08-20T18:34:26+08:00"), adjunctUrl: "finalpage/2026-08-20/1225586487.PDF", adjunctType: "PDF" }, fileUrl: "http://static.cninfo.com.cn/finalpage/2026-08-20/1225586487.PDF" }; }
function receipt(value = metadata()) { return { finalUrl: cninfoPdfIdentity(pdf, url).recordUrl, requestMethod: "POST", status: 200, contentType: "application/json", rawBody: Buffer.from(JSON.stringify(value)) }; }
async function opened(value = metadata(), options = {}) {
  return readExternalSource(url, { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async (request, _destination, requestOptions) => { if (request === url) { assert.equal(requestOptions.method, undefined); return { status: 200, contentType: "application/pdf", body: pdf }; } assert.equal(requestOptions.method, "POST"); assert.equal(request, receipt().finalUrl); return { status: 200, contentType: "application/json", body: receipt(value).rawBody }; }, ...options });
}

async function dividendFixture() {
  const actionUrl = url.replace("2026-08-20", "2026-08-01"), f = recapFixture("CN");
  const company = f.envelope.sectorPerformance.find(s => s.symbol === "932082").constituents[0];
  company.symbol = "600123.SS"; company.name = "样例医药";
  const table = ["股份类别 股权登记日 最后交易日 除权（息）日 现金红利发放日", "Ａ股 2026/8/20 － 2026/8/21 2026/8/21"];
  const first = [lines[0], "样例医药有限公司", "2026年中期利润分派 A 股实施公告", lines[3], "重要内容提示：", "A 股中期每股现金红利人民币2.51元（含税）", ...table];
  const body = fixturePdf([first, ["本次 A 股利润分配以公司 A 股股数1000股为基数，每股派发现金红利人民币2.51元（含税）。", ...table, "根据不同持股期限，股东最终实际所得和税款处理可能不同。"]]);
  const value = metadata(); value.announcement.announcementTitle = "样例医药：2026年中期利润分派A股实施公告"; value.announcement.announcementTime = Date.parse("2026-08-01T00:00:00+08:00"); value.announcement.adjunctUrl = "finalpage/2026-08-01/1225586487.PDF"; value.fileUrl = "http://static.cninfo.com.cn/" + value.announcement.adjunctUrl;
  const identity = cninfoPdfIdentity(body, actionUrl);
  const original = await readExternalSource(actionUrl, { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async (request, _destination, options) => {
    if (request === actionUrl) return { status: 200, contentType: "application/pdf", body };
    assert.equal(request, identity.recordUrl); assert.equal(options.method, "POST"); return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(value)) };
  } });
  const source = { anomalyId: f.plan.anomalies.find(a => a.target === "932082").id, role: "facts", originalUrl: actionUrl, sourceLabel: "巨潮资讯网", title: value.announcement.announcementTitle, publishedAt: "2026-08-01", kind: "corporate_action", supportingExcerpt: first.join("\n"), facts: "公告安排 A 股中期每股现金红利人民币2.51元（含税），相关股权登记日、除息日和现金发放日由对应A股日期表载明。", scope: "company", targets: [company.symbol], hypothesisIds: [f.plan.anomalies.find(a => a.target === "932082").hypotheses[0].id], causalConnection: false, comparisons: [] };
  return { f, original, source };
}

test("complete Unicode PDF pages and qualifications are derived again from original bytes", () => {
  const r = pdfSourceRecord(pdf);
  assert.equal(r.pageCount, 2); assert.equal(r.bodyHash, createHash("sha256").update(pdf).digest("hex"));
  for (const line of lines) assert.ok(r.text.includes(line));
  assert.match(r.pages[1].text, /可能无法实现相关里程碑/);
  assert.equal(sourceBodyText(pdf, "application/pdf"), r.text);
  r.pages[0].text = "changed caller copy";
  assert.ok(pdfSourceRecord(pdf).text.includes(lines[0]));
});

test("truncated, corrupted, empty or image-only PDF pages cannot masquerade as a complete text read", () => {
  for (const body of [Buffer.from("fake PDF"), pdf.subarray(0, -10), Buffer.from(pdf.toString().replace("startxref\n", "startxref\n999999\n")), fixturePdf([lines, []]), fixturePdf([lines], [0]), fixturePdf([lines.concat("\uF06C 每股分配比例")])]) assert.throws(() => pdfSourceRecord(body));
});

test("only an isolated embedded Wingdings list marker may retain its original private-use character", () => {
  const item = { str: "\uF06C" }, font = { name: "QSZMTY+Wingdings-Regular", missingFile: false, isType3Font: false };
  assert.equal(verifiedPdfListMarker(item, font, "", " 每股分配比例"), true);
  for (const [glyph, face, prefix, following] of [
    [{ str: "\uF06C正文" }, font, "", "每股分配比例"],
    [{ str: "\uF06D" }, font, "", "每股分配比例"],
    [item, { ...font, name: "QSZMTY+SimSun" }, "", "每股分配比例"],
    [item, { ...font, missingFile: true }, "", "每股分配比例"],
    [item, { ...font, isType3Font: true }, "", "每股分配比例"],
    [item, font, "下降", "每股分配比例"],
    [item, font, "", "\uF06C 每股分配比例"],
    [item, font, "", " "],
  ]) assert.equal(verifiedPdfListMarker(glyph, face, prefix, following), false);
});

test("a limited-company issuer still needs the sole native code, name and exact official announcement title", () => {
  const body = fixturePdf([lines.map(line => line.replaceAll("股份有限公司", "有限公司"))]);
  const r = receipt();
  const p = cninfoPdfPublication(body, r, url);
  assert.equal(p?.issuer.issuerName, "样例医药有限公司");
  assert.equal(p.issuer.symbol, "600123.SS");
  const separator = metadata(); separator.announcement.announcementTitle = "样例医药：" + cninfoPdfIdentity(body, url).title;
  assert.equal(cninfoPdfPublication(body, receipt(separator), url)?.issuer.symbol, "600123.SS");
  separator.announcement.announcementTitle = separator.announcement.announcementTitle.replace("：", "：：");
  assert.equal(cninfoPdfPublication(body, receipt(separator), url), null);
  const conflicting = metadata(); conflicting.announcement.secName = "其他公司";
  assert.equal(cninfoPdfPublication(body, receipt(conflicting), url), null);
  const duplicate = fixturePdf([[lines[0] + " 证券代码：600999", ...lines.slice(1).map(line => line.replaceAll("股份有限公司", "有限公司"))]]);
  assert.equal(cninfoPdfIdentity(duplicate, url), null);
});

test("an original CNINFO record binds securities identity and retains only calendar publication precision", async () => {
  const p = cninfoPdfPublication(pdf, receipt(), url);
  assert.equal(p.issuer.symbol, "600123.SS");
  assert.deepEqual(p.publishedAtCandidates, []); assert.deepEqual(p.publishedDateCandidates, ["2026-08-20"]);
  const hiddenMetadata = Buffer.from('<meta property="article:published_time" content="2026-08-20T14:00:00Z"><meta name="pubdate" content="2026-08-20">ACCEPTANCE-DATETIME>20260820100000');
  assert.deepEqual(sourcePublishedAtCandidates(hiddenMetadata, "application/pdf", url), []);
  assert.deepEqual(sourcePublishedDateCandidates(hiddenMetadata, "application/pdf", url), []);
  const original = await opened();
  assert.deepEqual(original.publishedAtCandidates, []); assert.deepEqual(original.publishedDateCandidates, ["2026-08-20"]);
  assert.equal(original.pdfDocument.issuer.symbol, "600123.SS");
  assert.equal(original.metadataReceipts[0].requestMethod, "POST");
  const snapshot = snapshotFromOpenedSource(url, original);
  assert.deepEqual(openedSourceFromSnapshot(snapshot), { ...original, fetchedAt: snapshot.fetchedAt });
  const unavailable = await opened(metadata(), { lookupPublicationMetadata: false });
  assert.deepEqual(unavailable.publishedDateCandidates, []); assert.equal(unavailable.pdfDocument.issuer, undefined);
});

test("native quarterly titles without an issuer prefix still require exact PDF and record issuer binding", async () => {
  const quarterly = fixturePdf([["样例医药股份有限公司2026 年第一季度报告", "1 / 2", "证券代码：600123 证券简称：样例医药", "样例医药股份有限公司", "2026 年第一季度报告", "本公司董事会及全体董事保证本公告内容不存在任何虚假记载、误导性陈述或者", "重大遗漏，并对其内容的真实性、准确性和完整性承担法律责任。"], ["本公司面对全球研发需求变化及监管风险，需要持续投入研发能力。"]]);
  const value = metadata(); value.announcement.announcementTitle = "2026年第一季度报告";
  const record = receipt(value);
  assert.equal(cninfoPdfPublication(quarterly, record, url)?.issuer.symbol, "600123.SS");
  assert.equal(cninfoPdfPublication(quarterly, record, url)?.timePrecision, "date");
  for (const mutate of [v => v.announcement.secCode = "600999", v => v.announcement.secName = "其他医药", v => v.announcement.announcementTitle = "2026年第二季度报告", v => v.announcement.announcementTitle += "摘要", v => v.announcement.announcementId = "1225200544", v => v.announcement.adjunctUrl = "finalpage/2026-08-20/1225200544.PDF"]) {
    const changed = structuredClone(value); mutate(changed);
    assert.equal(cninfoPdfPublication(quarterly, receipt(changed), url), null);
  }
  const original = await readExternalSource(url, { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async source => ({ status: 200, contentType: source === url ? "application/pdf" : "application/json", body: source === url ? quarterly : record.rawBody }) });
  assert.equal(openedSourceFromSnapshot(snapshotFromOpenedSource(url, original)).pdfDocument.issuer.symbol, "600123.SS");
});

test("another issuer, changed title, unrelated document and upload time cannot bind the announcement", () => {
  for (const mutate of [v => v.announcement.secCode = "600999", v => v.announcement.secName = "Other issuer", v => v.announcement.announcementId = "1225586488", v => v.announcement.announcementTitle += "另一个公告", v => v.announcement.adjunctUrl = "finalpage/2026-08-20/1225586488.PDF", v => v.announcement.announcementTime = Date.parse("2026-08-21T00:00:00+08:00"), v => v.fileUrl = "https://other.example/document.PDF", v => v.announcement.adjunctType = "HTML"]) { const v = metadata(); mutate(v); assert.equal(cninfoPdfPublication(pdf, receipt(v), url), null); }
  for (const mutate of [r => r.requestMethod = "GET", r => r.status = 502, r => r.contentType = "text/html", r => r.finalUrl += "&unbound=1"]) { const r = receipt(); mutate(r); assert.equal(cninfoPdfPublication(pdf, r, url), null); }
  const v = metadata(); v.announcement.storageTime = Date.parse("2026-08-21T14:00:00Z");
  assert.deepEqual(cninfoPdfPublication(pdf, receipt(v), url).publishedAtCandidates, []);
});

test("PDF snapshot replay rejects rewritten pages, substituted identity receipts and fabricated public clocks", async () => {
  const snapshot = snapshotFromOpenedSource(url, await opened());
  for (const mutate of [s => s.publishedAtCandidates = ["2026-08-20T10:34:26Z"], s => s.publishedDateCandidates = ["2026-08-21"], s => s.metadataReceipts = [], s => s.metadataReceipts[0].requestMethod = "GET", s => { const changed = fixturePdf([lines.map(line => line.replace("26亿美元", "36亿美元")), ["协议仍存在重大不确定性，全部里程碑可能不会实现。"]]); s.bodyBase64 = changed.toString("base64"); s.bodyHash = createHash("sha256").update(changed).digest("hex"); }]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => openedSourceFromSnapshot(copy)); }
});

test("company evidence derives the issuer ticker and cannot be expanded to a mentioned counterparty or sector", async () => {
  const f = recapFixture("CN"), anomaly = f.plan.anomalies.find(a => a.target === "932082");
  const company = f.envelope.sectorPerformance.find(s => s.symbol === "932082").constituents[0];
  company.symbol = "600123.SS"; company.name = "样例医药";
  const original = await opened();
  const source = { anomalyId: anomaly.id, role: "facts", originalUrl: url, sourceLabel: "巨潮资讯网", title: metadata().announcement.announcementTitle, publishedAt: "2026-08-20", kind: "official", supportingExcerpt: lines.slice(1).join("\n"), facts: lines[4] + lines[5], scope: "company", targets: [company.symbol], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] };
  const ledger = await verifyResearchSources([{sources:[source],alternatives:[]}], f.envelope, {reader: async () => original});
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.deepEqual(ledger.sources[0].companySubjects, ["600123.SS"]); assert.equal(ledger.sources[0].timePrecision, "date");
  auditLedgerSourceSnapshots(ledger, {version:SOURCE_SNAPSHOT_VERSION,snapshots:[snapshotFromOpenedSource(url,original)]}, {envelope:f.envelope});
  const forged = structuredClone(original); forged.pdfDocument.issuer.symbol = "600999.SS";
  assert.equal((await verifyResearchSources([{sources:[source],alternatives:[]}], f.envelope, {reader: async () => forged})).sources.length, 0);
  const oldCache = structuredClone(ledger.sources[0]); delete oldCache.pdfIssuerEvidenceVersion;
  let calls = 0;
  const rechecked = await verifyResearchSources([{sources:[source],alternatives:[]}], f.envelope, {verifiedCache:new Map([[oldCache.candidateHash,oldCache]]), reader: async () => { calls++; return forged; }});
  assert.equal(calls, 1); assert.equal(rechecked.sources.length, 0);
  const expanded = {...source,scope:"sector",targets:["932082"]};
  const expansion = await verifyResearchSources([{sources:[expanded],alternatives:[]}], f.envelope, {reader:async()=>original});
  assert.equal(expansion.sources.length, 0); assert.match(JSON.stringify(expansion.rejected), /不能改写为整个板块/);
  const expandedCache = {...ledger.sources[0],...expanded,candidateHash:stableHash(expanded)};
  calls = 0;
  const cachedExpansion = await verifyResearchSources([{sources:[expanded],alternatives:[]}], f.envelope, {verifiedCache:new Map([[expandedCache.candidateHash,expandedCache]]),reader:async()=>{calls++;return original;}});
  assert.equal(calls, 1); assert.equal(cachedExpansion.sources.length, 0);
  const rewrittenLedger = structuredClone(ledger);
  Object.assign(rewrittenLedger.sources[0], {scope:"sector",targets:["932082"]});
  delete rewrittenLedger.sources[0].companySubjects; delete rewrittenLedger.sources[0].companySubjectChecked;
  assert.throws(()=>auditLedgerSourceSnapshots(rewrittenLedger,{version:SOURCE_SNAPSHOT_VERSION,snapshots:[snapshotFromOpenedSource(url,original)]},{envelope:f.envelope}),/不能改写为整个板块/);
  const hour = {...source,publishedAt:"2026-08-20T10:34:26Z"};
  assert.equal((await verifyResearchSources([{sources:[hour],alternatives:[]}], f.envelope, {reader: async () => original})).sources.length, 0);
});

test("an earlier cash schedule is admitted only for its independently derived current effective date", async () => {
  const { f, original, source } = await dividendFixture();
  const action = cninfoCashDividendSchedule(original.text);
  assert.equal(action.perShareCash, 2.51); assert.equal(action.effectiveDate, f.envelope.marketAsOf);
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: async () => original, checkSessionIntegrity: true });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  const accepted = ledger.sources[0];
  assert.equal(accepted.publishedAt, "2026-08-01"); assert.equal(accepted.timePrecision, "date");
  assert.equal(accepted.corporateAction.status, "announced_schedule");
  assert.deepEqual(accepted.companySubjects, ["600123.SS"]);
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(source.originalUrl, original)] };
  auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope });
  const ordinary = await verifyResearchSources([{ sources: [{ ...source, kind: "official" }], alternatives: [] }], f.envelope, { reader: async () => original });
  assert.equal(ordinary.sources.length, 0); assert.match(JSON.stringify(ordinary.rejected), /日期不在交易窗口/);
  const fakeDate = await verifyResearchSources([{ sources: [{ ...source, publishedAt: "2026-08-21" }], alternatives: [] }], f.envelope, { reader: async () => original });
  assert.equal(fakeDate.sources.length, 0);
  for (const mutate of [s => s.corporateAction.perShareCash = 9, s => s.corporateAction.effectiveDate = "2026-08-20", s => s.corporateAction.status = "realized", s => { delete s.corporateActionChecked; }, s => { s.kind = "official"; }]) {
    const changed = structuredClone(ledger); mutate(changed.sources[0]);
    assert.throws(() => auditLedgerSourceSnapshots(changed, book, { envelope: f.envelope }), /公司行动/);
  }
});

test("worker normalization retains the boundaries of exact separated PDF title and table fragments", async () => {
  const { f, original, source } = await dividendFixture();
  const anomaly = f.plan.anomalies.find(a => a.id === source.anomalyId);
  const excerpt = source.supportingExcerpt.split("\n").filter(line => !line.startsWith("本公司董事会") && !line.startsWith("重要内容提示")).join("\r\n");
  const result = { contractVersion: "stock-daily-evidence-worker-v1", role: "facts", market: "CN", anomalyId: anomaly.id, outcome: "found", queries: [anomaly.factQueries[0], `2026-08-21 A股 ${anomaly.title} 样例医药 中期现金分派 实施公告`], sources: [{ ...source, url: source.originalUrl, supportingExcerpt: excerpt }], alternatives: [] };
  const normalized = validateResearchOutput(result, "facts", anomaly, f.envelope);
  assert.equal(normalized.sources.length, 1, JSON.stringify(normalized.rejectedSources));
  assert.ok(normalized.sources[0].supportingExcerpt.includes("\n"));
  assert.ok(!normalized.sources[0].supportingExcerpt.includes("\r"));
  const accepted = await verifyResearchSources([normalized], f.envelope, { reader: async () => original });
  assert.equal(accepted.sources.length, 1, JSON.stringify(accepted.rejected));
  const reordered = structuredClone(normalized);
  reordered.sources[0].supportingExcerpt = reordered.sources[0].supportingExcerpt.split("\n").reverse().join("\n");
  assert.equal((await verifyResearchSources([reordered], f.envelope, { reader: async () => original })).sources.length, 0);
  const changed = structuredClone(normalized);
  changed.sources[0].supportingExcerpt = changed.sources[0].supportingExcerpt.replace("2.51", "2.59");
  assert.equal((await verifyResearchSources([changed], f.envelope, { reader: async () => original })).sources.length, 0);
});

test("conflicting cash terms, missing/reversed dates and H-share-only quotes cannot establish an A-share schedule", async () => {
  const { f, original, source } = await dividendFixture();
  for (const body of [original.text.replace(/每股派发现金红利人民币\s*2\.51/u, "每股派发现金红利人民币2.59"), original.text.replace(/2026\/8\/21/u, "2026/8/22"), original.text.replaceAll("2026/8/20", "2026/8/22"), original.text.replaceAll("2026/8/21", "2026/2/30"), original.text.replaceAll("Ａ股", "H股"), original.text.replace(/人民币\s*2\.51/u, "港元2.51")]) assert.equal(cninfoCashDividendSchedule(body), null);
  for (const changed of [{ ...source, scope: "sector", targets: ["932082"] }, { ...source, targets: ["600999.SS"] }, { ...source, comparisons: [{}] }, { ...source, role: "causal", causalConnection: true }, { ...source, supportingExcerpt: "样例医药有限公司港股股东可选择每股2.9003港元（含税），有关红利安排根据适用条件实施。" }]) assert.throws(() => verifiedCurrentCorporateAction(changed, original, f.envelope));
  assert.throws(() => verifiedCurrentCorporateAction(source, original, { ...f.envelope, marketAsOf: "2026-08-24" }), /本期生效日/);
  const noIdentity = structuredClone(original); delete noIdentity.pdfDocument.issuer;
  assert.throws(() => verifiedCurrentCorporateAction(source, noIdentity, f.envelope), /发行人/);
});

test("a current company schedule never supplies a sector cause or a prior-day prediction as the price reaction", async () => {
  const { f, original, source } = await dividendFixture();
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: async () => original });
  const root = ledger.sources[0];
  const report = { ...root, id: "independent-price-reaction", kind: "market_wrap", sourceType: "publisher", url: "https://www.stcn.com/article/detail/1234567.html", publishedAt: "2026-08-21T08:00:00Z", role: "causal", causalConnection: true, supportingExcerpt: "样例医药今日A股每股现金红利人民币2.51元的除息安排导致开盘价格产生缺口，此后价格出现反弹。" };
  delete report.corporateAction; delete report.corporateActionChecked;
  ledger.sources.push(report);
  const target = recapTargets(f.envelope).find(t => t.symbol === "932082");
  const candidate = recapAttributionCandidates(f.envelope, [target], ledger)[0];
  assert.equal(candidate.reportedEligible, false); assert.equal(candidate.inferredIngredientsPresent, false);
  assert.equal(candidate.constituents.find(c => c.symbol === "600123.SS").reportedPairs.length, 1);
  const targets = recapTargets(f.envelope);
  const assessment = { contractVersion: ATTRIBUTION_VERSION, market: "CN", marketAsOf: f.envelope.marketAsOf, entries: targets.map(t => ({ target: t.symbol, observedReturn: t.change, basis: "unresolved", chains: [], counterEvidenceIds: [], counterAssessment: "完整行业敞口和权重并未由公司现金分派公告确认；一家公司可能存在的价格机制不能代替整个行业的归因。" })) };
  const entry = assessment.entries.find(e => e.target === "932082");
  entry.basis = "inferred"; entry.chains = [{ rootEvidenceId: root.id, reactionEvidenceId: report.id, timingEvidenceId: null, subjectTargets: [], basis: "inferred", eventAnchors: ["每股现金红利人民币", "2.51元"], expectedDirection: "positive", mechanismEvidenceIds: [], transmission: "公司分派现金的安排只涉及本公司的股东和价格口径。该现金安排不能建立整个行业所有成分的经营、融资或估值变化。", limitations: "缺少完整行业成分敞口和对应权重，公告安排也没有确认现金已经到账。" }];
  assert.throws(() => validateRecapAttribution(assessment, f.envelope, targets, ledger), /不能扩大为行业/);
  report.scope = "sector"; report.targets = ["932082"];
  assert.equal(recapAttributionCandidates(f.envelope, [target], ledger)[0].candidatePairs.length, 0);
  report.scope = "company"; report.targets = ["600123.SS"];
  report.publishedAt = "2026-08-20T08:00:00Z";
  assert.equal(recapAttributionCandidates(f.envelope, [target], ledger)[0].candidatePairs.length, 0);
  report.publishedAt = "2026-08-21T08:00:00Z"; root.corporateActionChecked = false;
  assert.equal(recapAttributionCandidates(f.envelope, [target], ledger)[0].rootEvidenceIds.includes(root.id), false);
});
