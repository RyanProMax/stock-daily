import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { pdfSourceRecord } from "../scripts/pdf-source.mjs";
import { cninfoPdfIdentity, cninfoPdfPublication } from "../scripts/cninfo-pdf-publication.mjs";
import { readExternalSource, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource, auditLedgerSourceSnapshots, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { verifyResearchSources, stableHash } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

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
  for (const body of [Buffer.from("fake PDF"), pdf.subarray(0, -10), Buffer.from(pdf.toString().replace("startxref\n", "startxref\n999999\n")), fixturePdf([lines, []]), fixturePdf([lines], [0])]) assert.throws(() => pdfSourceRecord(body));
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
