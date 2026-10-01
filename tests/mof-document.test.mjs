import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mofDocumentIdentity, mofDocumentRecord } from "../scripts/mof-document.mjs";
import { readExternalSource, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { auditLedgerSourceSnapshots, openedSourceFromSnapshot, snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

const url = "https://jrs.mof.gov.cn/zhengcejiedu/202608/t20260820_3998314.htm";
const title = "财政部、中国人民银行、金融监管总局有关负责人就实施居民购房贷款贴息政策答记者问";
const excerpt = "使用新发放的商业性个人住房贷款购买首套住房，不包括存量贷款置换。其中，首套住房既包括新房也包括二手房。所购住房建筑面积不超过120平方米，价格不超过150万元，贷款规模最多100万元，给予年化1个百分点的贴息，贴息期限最长5年。";
function html() {
  return `<head><meta name="SiteName" content="中华人民共和国财政部"><meta name="SiteDomain" content="http://www.mof.gov.cn"><meta name="SiteIDCode" content="bm14000001"><meta name="ContentSource" content=""><meta name="ArticleTitle" content="${title}"><meta name="PubDate" content="2026-08-20 15:16:00"><title>${title}</title></head><body><script>throw new Error('Never execute source JS');</script><div class="mainboxerji"><div class="box_content"><h2 class="title_con">${title.replace("就实施", "就<br>实施")}</h2><!--<span>2099年1月1日 10:00:00</span>--><div class="my_conboxzw"><div class="my_doccontent"><div class="TRS_Editor"><style>.hidden{display:none;}</style><div class="TRS_Editor"><p>2026年8月20日 来源：金融司</p><p>${excerpt}</p><p>政策起始日为今年10月1日，政策实施期暂定1年。对于使用贷款购买保障性住房和使用公积金贷款购房的相关群体，此次不叠加享受政策支持。</p><p>具体贴息金额，视贷款规模、期限、还款方式等情况而异。</p></div></div></div></div><div class="gu-download">相关文章：另一个政策发布日期2026年8月21日 23:59:00</div></div><div class="conbottom"><div class="docreltime"><span>发布日期：2026年08月20日</span></div></div></div><footer>2017年11月21日 星期二</footer></body>`;
}
const options = body => ({ includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async () => ({ status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(body) }) });
const opened = (body = html()) => readExternalSource(url, options(body));

test("MOF native title, visible calendars, department and article path bind its Beijing publication clock", async () => {
  const record = mofDocumentRecord(html(), url);
  assert.deepEqual(record.publishedAtCandidates, ["2026-08-20T07:16:00.000Z"]);
  assert.deepEqual(record.publishedDateCandidates, ["2026-08-20"]);
  assert.match(record.text, /首套住房既包括新房也包括二手房/);
  assert.match(record.text, /公积金贷款购房.*不叠加享受/);
  assert.match(record.text, /视贷款规模、期限、还款方式/);
  assert.doesNotMatch(record.text, /2099|相关文章|2017|Never execute/);
  const result = await opened();
  assert.equal(result.text, record.text);
  assert.equal(result.articleProvenance.origin.key, "authority:mof.gov.cn");
  assert.equal(result.articleProvenance.publication.currentVersionAt, record.publishedAtCandidates[0]);
  assert.deepEqual(result.metadataReceipts, []);
  const snapshot = snapshotFromOpenedSource(url, result);
  assert.deepEqual(openedSourceFromSnapshot(snapshot), { ...result, fetchedAt: snapshot.fetchedAt });
});

test("a missing or conflicting native identity, title, date or update cannot borrow a footer or generic meta clock", async () => {
  const mutations = [
    body => body.replace('name="SiteName"', 'name="OtherName"'),
    body => body.replace('content="bm14000001"', 'content="other"'),
    body => body.replace('name="ContentSource" content=""', 'name="ContentSource" content="某新闻网站"'),
    body => body.replace('name="ArticleTitle" content="', 'name="ArticleTitle" content="无关标题'),
    body => body.replace('<title>', '<title>无关标题'),
    body => body.replace('15:16:00', '25:16:00'),
    body => body.replace('2026-08-20 15:16:00', '2026-08-21 15:16:00'),
    body => body.replace('2026年8月20日 来源：金融司', '2026年8月21日 来源：金融司'),
    body => body.replace('来源：金融司', '来源：其他部门'),
    body => body.replace('发布日期：2026年08月20日', '发布日期：2026年08月21日'),
    body => body.replace('class="my_doccontent"', 'class="recommended-content"'),
    body => body.replace('</head>', '<meta name="PubDate" content="2026-08-20 15:16:00"></head>'),
    body => body.replace('</head>', '<meta name="dateModified" content="2026-08-21T08:00:00Z"></head>'),
    body => body.replace('</head>', '<meta property="article:modified_time" content="2026-08-21T08:00:00Z"></head>'),
    body => body.replace('</head>', '<link rel="canonical" href="https://other.example/article"></head>'),
  ];
  for (const mutate of mutations) {
    const body = mutate(html());
    assert.equal(mofDocumentRecord(body, url), null);
    assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(body), "text/html", url), []);
    assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(body), "text/html", url), []);
    assert.equal(sourceArticleProvenance(body, url).publication.status, "unverified_update");
    await assert.rejects(opened(body), /无法绑定原文/);
  }
  for (const source of [url.replace('https:', 'http:'), url.replace('jrs.mof.gov.cn', 'jrs.mof.gov.cn.evil.example'), url + '?extra=1', url + '#unbound', url.replace('/202608/', '/202607/'), url.replace('t20260820', 't20260230')]) assert.equal(mofDocumentIdentity(source), null);
});

test("frozen MOF replay rederives exact original text and clock, and refuses substituted metadata", async () => {
  const snapshot = snapshotFromOpenedSource(url, await opened());
  for (const mutate of [
    s => s.publishedAtCandidates = ['2026-08-20T15:16:00Z'],
    s => s.publishedDateCandidates = ['2026-08-21'],
    s => s.textHash = 'fake',
    s => s.metadataReceipts = [{ ...s, metadataReceipts: undefined }],
    s => { const raw = Buffer.from(html().replace('100万元', '200万元')); s.bodyBase64 = raw.toString('base64'); s.bodyHash = createHash('sha256').update(raw).digest('hex'); },
  ]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => openedSourceFromSnapshot(copy)); }
});

test("a bound policy original verifies conditions at event scope without certifying sector direction", async () => {
  const f = recapFixture('CN'), anomaly = f.plan.anomalies[0];
  const source = { anomalyId: anomaly.id, role: 'facts', originalUrl: url, sourceLabel: '财政部', title, publishedAt: '2026-08-20', kind: 'official', supportingExcerpt: excerpt, facts: excerpt, scope: 'event_only', targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] };
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: () => opened() });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.equal(ledger.sources[0].publishedAt, '2026-08-20');
  assert.equal(ledger.sources[0].initialPublishedAt, '2026-08-20T07:16:00.000Z');
  assert.equal(ledger.sources[0].authorityDocumentVersion, 'verified-mof-finance-document-v1');
  assert.equal(ledger.sources[0].scope, 'event_only');
  assert.equal(ledger.sources[0].causalConnection, false);
  assert.equal(ledger.sources[0].sourceType, 'first_party');
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, await opened())] };
  auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope });
  for (const version of [undefined, 'verified-mof-finance-document-v0']) {
    const old = structuredClone(ledger); old.sources[0].authorityDocumentVersion = version;
    assert.throws(() => auditLedgerSourceSnapshots(old, book, { envelope: f.envelope }), /核验版本/);
  }
});

test("ordinary and legacy-cache verification request native raw bytes before accepting an exact policy clock", async () => {
  const f = recapFixture('CN'), anomaly = f.plan.anomalies[0];
  const source = { anomalyId: anomaly.id, role: 'facts', originalUrl: url, sourceLabel: '财政部', title, publishedAt: '2026-08-20T07:16:00Z', kind: 'official', supportingExcerpt: excerpt, facts: excerpt, scope: 'event_only', targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] };
  const original = await opened(), requests = [];
  const reader = (value, requestOptions) => {
    requests.push(requestOptions);
    assert.equal(requestOptions.includeRaw, true);
    const opts = options(html()); delete opts.includeRaw;
    return readExternalSource(value, { ...opts, ...requestOptions });
  };
  const first = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader });
  assert.equal(first.sources.length, 1, JSON.stringify(first.rejected));
  assert.equal(first.sources[0].publishedAt, '2026-08-20T07:16:00.000Z');
  const cached = structuredClone(first.sources[0]); delete cached.authorityDocumentVersion;
  const replay = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader, verifiedCache: new Map([[stableHash(source), cached]]) });
  assert.equal(replay.sources.length, 1); assert.equal(requests.length, 2);
  assert.equal(replay.sources[0].authorityDocumentVersion, 'verified-mof-finance-document-v1');
  const missing = structuredClone(original); delete missing.rawBody;
  assert.equal((await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: async () => missing })).sources.length, 0);
  for (const mutate of [
    o => o.publishedAtCandidates = ['2026-08-20T09:16:00Z'],
    o => o.publishedDateCandidates = ['2026-08-21'],
    o => o.articleProvenance.publication.currentVersionAt = '2026-08-20T09:16:00Z',
    o => o.articleProvenance.origin.key = 'authority:other.example',
  ]) {
    const changed = { ...structuredClone(original), rawBody: original.rawBody }; mutate(changed);
    const result = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: async () => changed });
    assert.equal(result.sources.length, 0); assert.match(result.rejected[0].reason, /原始正文记录不一致/);
  }
});
