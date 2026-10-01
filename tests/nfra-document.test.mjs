import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { nfraDocumentIdentity, nfraDocumentRecord } from "../scripts/nfra-document.mjs";
import { readExternalSource } from "../scripts/daily-source-audit.mjs";
import { openedSourceFromSnapshot, snapshotFromOpenedSource } from "../scripts/evidence-source-snapshots.mjs";
import { validateResearchOutput, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

const url = "https://www.nfra.gov.cn/cn/view/pages/ItemDetail.html?docId=1273762&itemId=915";
const title = "财政部、中国人民银行、金融监管总局有关负责人就实施居民购房贷款贴息政策答记者问";
const excerpt = "使用新发放的商业性个人住房贷款购买首套住房，不包括存量贷款置换。所购住房建筑面积不超过120平方米，价格不超过150万元。可享受贴息的贷款规模最多100万元，财政部门给予年化1个百分点的贴息，贴息期限最长5年。政策起始日为今年10月1日，政策实施期暂定1年。";
const shell = Buffer.from('<script src="/cn/js/common/Script.js?v=20200108"></script><script src="/cn/js/common/ItemDetail.js?v=20200108"></script><div ng-controller="itemDetailCtrl"><span>发布时间：{{data.publishDate|dateFormat2}}</span><div ng-bind-html="data.docTitle|addBr"></div><div ng-bind-html="data.docClob|trustHtml"></div></div><footer>网站底部与推荐文章均不是本次公告正文。</footer>');
function record() {
  return { rptCode: 200, data: { docId: 1273762, docTitle: title.replace("负责人就", "负责人\n就"), docSubtitle: title, publishDate: "2026-08-20 18:16:53", docEditdate: "2026-08-20T10:16:53.000+00:00", docSource: "办公厅", documentType: "0", listTwoItem: [{ ItemID: 915 }], docClob: `<html><head><title>Unrelated Office metadata 99%</title><style>.hidden{display:none;}</style></head><body><p>${excerpt}</p><p>居民家庭享受的具体贴息金额，视贷款规模、期限、还款方式等情况而异。</p></body></html>` } };
}
function receipt(value = record()) {
  return { finalUrl: nfraDocumentIdentity(url).recordUrl, status: 200, contentType: "application/json", rawBody: Buffer.from(JSON.stringify(value)) };
}
async function opened(value = record()) {
  return readExternalSource(url, { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async request => request === url ? { status: 200, contentType: "text/html; charset=utf-8", body: shell } : { status: 200, contentType: "application/json", body: receipt(value).rawBody } });
}

test("a native authority record binds exact document, department, body and Beijing publication time", async () => {
  const r = nfraDocumentRecord(shell.toString(), receipt(), url);
  assert.deepEqual(r.publishedAtCandidates, ["2026-08-20T10:16:53.000Z"]);
  assert.deepEqual(r.publishedDateCandidates, ["2026-08-20"]);
  assert.equal(r.articleProvenance.origin.key, "authority:nfra.gov.cn");
  assert.equal(r.articleProvenance.publication.timeBasis, "first_publication");
  assert.ok(r.text.includes(excerpt));
  assert.match(r.text, /具体贴息金额，视贷款规模、期限、还款方式/);
  assert.doesNotMatch(r.text, /99%|网站底部|\{\{/);
  const original = await opened();
  assert.equal(original.text, r.text);
  assert.equal(original.metadataReceipts.length, 1);
  const snapshot = snapshotFromOpenedSource(url, original);
  assert.deepEqual(openedSourceFromSnapshot(snapshot), { ...original, fetchedAt: snapshot.fetchedAt });
});

test("an unrelated ID, repost, redirected article or ambiguous authority record cannot supply primary evidence", () => {
  for (const mutate of [
    v => v.rptCode = 404, v => v.data.docId++, v => v.data.documentType = "1",
    v => v.data.docSource = "新华社", v => v.data.docSubtitle = "Another unrelated article",
    v => v.data.listTwoItem = [{ ItemID: 999 }], v => v.data.listTwoItem.push({ ItemID: 915 }),
    v => v.data.titleLink = "https://other.example/repost", v => v.data.docClob = "{{data.docClob}}",
    v => v.data.publishDate = "2026-02-30 18:16:53", v => v.data.publishDate = "2026-13-20 18:16:53",
    v => v.data.publishDate = "2026-08-20", v => v.data.publishDate = "2026-08-20 25:16:53",
  ]) { const v = record(); mutate(v); assert.equal(nfraDocumentRecord(shell.toString(), receipt(v), url), null); }
  for (const change of [
    { finalUrl: receipt().finalUrl.replace("1273762", "1273763") }, { status: 302 }, { contentType: "text/html" },
  ]) assert.equal(nfraDocumentRecord(shell.toString(), { ...receipt(), ...change }, url), null);
  const userInfoUrl = new URL(url); userInfoUrl.username = "example";
  for (const value of [url.replace("www.nfra.gov.cn", "nfra.gov.cn.evil.example"), url.replace("https:", "http:"), url + "&docId=1273763", url + "&unbound=1", userInfoUrl.href]) assert.equal(nfraDocumentIdentity(value), null);
  for (const value of [shell.toString().replace("itemDetailCtrl", "otherCtrl"), shell.toString().replace("data.docClob", "related.docClob"), shell.toString().replace("/cn/js/common/ItemDetail.js", "https://other.example/ItemDetail.js")]) assert.equal(nfraDocumentRecord(value, receipt(), url), null);
});

test("later or invalid CMS edits leave the current public version unverified", async () => {
  for (const edit of ["2026-08-20T10:29:15.000+00:00", "2026-08-20T10:00:00Z", null, "2026-13-20T10:16:53Z"]) {
    const value = record(); value.data.docEditdate = edit;
    const original = await opened(value);
    assert.deepEqual(original.publishedAtCandidates, []);
    assert.equal(original.articleProvenance.publication.status, "unverified_update");
    assert.equal(openedSourceFromSnapshot(snapshotFromOpenedSource(url, original)).articleProvenance.publication.status, "unverified_update");
  }
});

test("frozen authority replay refuses substituted records, forged clocks and template-only sources", async () => {
  const original = await opened(), snapshot = snapshotFromOpenedSource(url, original);
  for (const mutate of [
    s => s.metadataReceipts = [], s => s.publishedAtCandidates = ["2026-08-20T18:16:53Z"],
    s => s.metadataReceipts[0].finalUrl = s.metadataReceipts[0].finalUrl.replace("1273762", "1273763"),
    s => { const v = record(); v.data.docClob = v.data.docClob.replace("100万元", "200万元"); const b = receipt(v).rawBody; s.metadataReceipts[0].bodyBase64 = b.toString("base64"); s.metadataReceipts[0].bodyHash = createHash("sha256").update(b).digest("hex"); },
  ]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => openedSourceFromSnapshot(copy)); }
  await assert.rejects(readExternalSource(url, { lookupPublicationMetadata: false, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async () => ({ status: 200, contentType: "text/html", body: shell }) }), /原始正文记录/);
  await assert.rejects(readExternalSource(url, { resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async request => request === url ? { status: 200, contentType: "text/html", body: shell } : { status: 502, contentType: "text/html", body: Buffer.from("Bad gateway") } }), /无法绑定/);
});

test("verified policy facts retain their conditions without approving a sector price cause or a later edit", async () => {
  const f = recapFixture("CN"), anomaly = f.plan.anomalies[0];
  const output = validateResearchOutput({ contractVersion: "stock-daily-evidence-worker-v1", role: "facts", market: "CN", anomalyId: anomaly.id, outcome: "found", queries: [anomaly.factQueries[0], `${f.envelope.marketAsOf} CN 金融监管总局 居民购房贷款贴息 政策 答记者问 原文`], sources: [{ url, sourceLabel: "国家金融监督管理总局", title, publishedAt: "2026-08-20T10:16:53Z", kind: "official", supportingExcerpt: excerpt, facts: excerpt, scope: "event_only", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] }], alternatives: [] }, "facts", anomaly, f.envelope);
  const ledger = await verifyResearchSources([output], f.envelope, { reader: () => opened() });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.equal(ledger.sources[0].sourceType, "first_party");
  assert.equal(ledger.sources[0].scope, "event_only");
  assert.equal(ledger.sources[0].causalConnection, false);
  const edited = record(); edited.data.docEditdate = "2026-08-20T10:29:15Z";
  const rejected = await verifyResearchSources([output], f.envelope, { reader: () => opened(edited) });
  assert.equal(rejected.sources.length, 0);
  assert.match(JSON.stringify(rejected.rejected), /当前版本更新时间无法核验/);
});
