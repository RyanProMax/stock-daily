import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PBOC_DOCUMENT_VERSION, pbocDocumentIdentity, pbocDocumentRecord } from "../scripts/pboc-document.mjs";
import { readExternalSource, sourcePublishedAtCandidates, sourcePublishedDateCandidates, normalizedEvidenceText } from "../scripts/daily-source-audit.mjs";
import { auditLedgerSourceSnapshots, openedSourceFromSnapshot, snapshotFromOpenedSource, SOURCE_SNAPSHOT_VERSION } from "../scripts/evidence-source-snapshots.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";
import { recapTargets } from "../scripts/complete-recap.mjs";
import { recapAttributionCandidates, validateRecapAttribution } from "../scripts/recap-attribution.mjs";

const url = "https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026082017474922559/index.html";
const title = "中国人民银行调整完善若干货币政策工具";
const excerpt = "一是下调抵押补充贷款（PSL）利率0.25个百分点。一年期抵押补充贷款利率从1.75%降至1.5%，更好激励政策性银行支持实体经济、服务国家战略。三是增加科技创新和技术改造再贷款额度2000亿元，并将该项再贷款支持比例统一从60%提高至100%。调增后，科技创新和技术改造再贷款额度从1.2万亿元增至1.4万亿元，且支持比例更高，有助于引导银行加大对中小科技型企业贷款投放。";
function html() {
  return `<head><meta name="createDate" content="2026-08-20 17:53:02"><meta name="SiteName" content="沟通交流"><meta name="SiteIDCode" content="goutongjiaoliu"><meta name="ColumnName" content="新闻"><meta name="ColumnType" content="工作动态"><meta name="ContentSource" content=""><meta name="Url" content="${new URL(url).pathname}"><meta name="ArticleTitle" content="${title}"><meta name="PubDate" content="2026-08-20"><title>${title}</title></head><body><nav>推荐另一篇政策2026-08-21 23:59:00</nav><table><tr><td><table><tr><td><table><tr><td><h2>${title}</h2><h2></h2></td></tr></table></td></tr></table><script>throw Error('Do not execute');</script><table><tr><td>字号</td><td>文章来源：<span id="laiyuan"></span></td><td align="right"><!--2026年08月21日-->2026-08-20 17:52:48</td></tr></table><table><tr><td class="content"><div id="zoom" class="zoom1"><p>${excerpt}</p><p>将水网、新型电网、算力网、新一代通信网、城市地下管网、物流网等六张网建设纳入抵押补充贷款支持领域。</p><p>增加支农支小再贷款额度5000亿元，其中民营企业再贷款额度增加3000亿元。将进一步激励地方法人银行加大对涉农、小微企业的信贷支持。</p><p>中国人民银行将继续根据宏观经济运行情况、物价走势和宏观调控需要，综合运用多种货币政策工具。</p></div></td></tr></table></td></tr></table><footer>网站标识码：bm25000001 网站主办单位：中国人民银行办公厅</footer></body>`;
}
const opened = (body = html()) => readExternalSource(url, { includeRaw: true, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async () => ({ status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(body) }) });
function candidate(f) {
  const anomaly = f.plan.anomalies[0];
  return { anomalyId: anomaly.id, role: "facts", originalUrl: url, sourceLabel: "中国人民银行", title: "未核验的生成标题不应覆盖正式原文标题", publishedAt: "2026-08-20", kind: "official", supportingExcerpt: excerpt, facts: excerpt, scope: "event_only", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[0].id], causalConnection: false, comparisons: [] };
}

test("PBOC native heading, owned body, source and visible clock bind its publication without using CMS creation or URL time", async () => {
  const record = pbocDocumentRecord(html(), url);
  assert.deepEqual(record.publishedAtCandidates, ["2026-08-20T09:52:48.000Z"]);
  assert.deepEqual(record.publishedDateCandidates, ["2026-08-20"]);
  assert.match(record.text, /支持比例统一从60%提高至100%/);
  assert.match(record.text, /其中民营企业再贷款额度增加3000亿元/);
  assert.doesNotMatch(record.text, /17:53|17:47|推荐|2026-08-21|Do not execute|网站标识码/);
  const result = await opened();
  assert.equal(result.text, record.text);
  assert.equal(result.articleProvenance.origin.key, "authority:pbc.gov.cn");
  assert.equal(result.articleProvenance.origin.identified, true);
  const snapshot = snapshotFromOpenedSource(url, result);
  assert.deepEqual(openedSourceFromSnapshot(snapshot), { ...result, fetchedAt: snapshot.fetchedAt });
});

test("an unknown or contradictory PBOC identity, reprint, body, header, clock or modification cannot borrow a generic timestamp", async () => {
  const mutations = [
    s => s.replace('content="goutongjiaoliu"', 'content="other"'),
    s => s.replace('content="新闻"', 'content="其他栏目"'),
    s => s.replace('name="ContentSource" content=""', 'name="ContentSource" content="新华社"'),
    s => s.replace('<span id="laiyuan"></span>', '<span id="laiyuan">新华社</span>'),
    s => s.replace('name="ArticleTitle" content="', 'name="ArticleTitle" content="无关标题'),
    s => s.replace('<title>', '<title>无关标题'),
    s => s.replace('name="PubDate" content="2026-08-20"', 'name="PubDate" content="2026-08-21"'),
    s => s.replace(new URL(url).pathname, '/goutongjiaoliu/other/index.html'),
    s => s.replace('17:52:48', '25:52:48'),
    s => s.replace('2026-08-20 17:52:48', '2026-08-21 17:52:48'),
    s => s.replace('2026-08-20 17:52:48', ''),
    s => s.replace('class="content"', 'class="recommendation"'),
    s => s.replace('id="zoom"', 'id="otherbody"'),
    s => s.replace('bm25000001', 'other-authority'),
    s => s.replace('中国人民银行办公厅', '其他主办机构'),
    s => s.replace('</head>', '<meta name="PubDate" content="2026-08-20"></head>'),
    s => s.replace('</head>', '<meta property="article:modified_time" content="2026-08-21T08:00:00Z"></head>'),
    s => s.replace('</head>', '<link rel="canonical" href="https://www.pbc.gov.cn/unrelated"></head>'),
  ];
  for (const mutate of mutations) {
    const body = mutate(html());
    assert.equal(pbocDocumentRecord(body, url), null);
    assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(body), "text/html", url), []);
    assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(body), "text/html", url), []);
    assert.equal(sourceArticleProvenance(body, url).publication.status, "unverified_update");
    await assert.rejects(opened(body), /无法绑定原文/);
  }
  for (const source of [url.replace('https:', 'http:'), url.replace('www.pbc.gov.cn', 'www.pbc.gov.cn.evil.example'), url + '?other=1', url + '#unbound', url.replace('113469', 'other'), url.replace('20260820', '20260230'), url.replace('22559', '2255')]) assert.equal(pbocDocumentIdentity(source), null);
  assert.deepEqual(pbocDocumentRecord(html().replace('17:53:02', '18:53:02'), url).publishedAtCandidates, ['2026-08-20T09:52:48.000Z']);
});

test("PBOC source verification derives the native title, precise clock and authority version from raw original bytes", async () => {
  const f = recapFixture(), source = candidate(f);
  const ledger = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: () => opened() });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  const verified = ledger.sources[0];
  assert.equal(verified.title, title);
  assert.equal(verified.publishedAt, '2026-08-20T09:52:48.000Z');
  assert.equal(verified.initialPublishedAt, verified.publishedAt);
  assert.equal(verified.timePrecision, 'instant');
  assert.equal(verified.authorityDocumentVersion, PBOC_DOCUMENT_VERSION);
  assert.equal(verified.scope, 'event_only');
  const book = { version: SOURCE_SNAPSHOT_VERSION, snapshots: [snapshotFromOpenedSource(url, await opened())] };
  auditLedgerSourceSnapshots(ledger, book, { envelope: f.envelope });
  for (const mutate of [s => delete s.authorityDocumentVersion, s => s.authorityDocumentVersion = 'older', s => s.publishedAt = '2026-08-20', s => s.reportingOrigin.key = 'authority:other.gov.cn', s => s.title = '未核验的生成标题']) {
    const copy = structuredClone(ledger); mutate(copy.sources[0]);
    assert.throws(() => auditLedgerSourceSnapshots(copy, book, { envelope: f.envelope }));
  }
});

test("PBOC replay refuses replaced bytes, text, dates and added publication receipts", async () => {
  const snapshot = snapshotFromOpenedSource(url, await opened());
  for (const mutate of [
    s => s.publishedAtCandidates = ['2026-08-20T09:53:02.000Z'],
    s => s.publishedDateCandidates = ['2026-08-21'],
    s => s.textHash = 'unverified',
    s => s.metadataReceipts = [{ ...s, metadataReceipts: undefined }],
    s => { const raw = Buffer.from(html().replace('2000亿元', '3000亿元')); s.bodyBase64 = raw.toString('base64'); s.bodyHash = createHash('sha256').update(raw).digest('hex'); },
  ]) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => openedSourceFromSnapshot(copy)); }
});

test("an older PBOC cache must reopen native bytes and cannot preserve an unknown authority version", async () => {
  const f = recapFixture(), source = candidate(f), output = [{ sources: [source], alternatives: [] }];
  const initial = await verifyResearchSources(output, f.envelope, { reader: () => opened() });
  for (const version of [undefined, 'older', PBOC_DOCUMENT_VERSION]) {
    const old = { ...initial.sources[0], authorityDocumentVersion: version, authorityTitleChecked: false, title: '旧缓存中的未核验标题' }; let reads = 0;
    const ledger = await verifyResearchSources(output, f.envelope, { verifiedCache: new Map([[stableHash(source), old]]), reader: async (_, options) => { reads++; assert.equal(options.includeRaw, true); return opened(); } });
    assert.equal(reads, 1); assert.equal(ledger.sources[0].authorityDocumentVersion, PBOC_DOCUMENT_VERSION); assert.equal(ledger.sources[0].title, title);
  }
  const noRaw = await verifyResearchSources(output, f.envelope, { reader: async () => { const o = await opened(); delete o.rawBody; return o; } });
  assert.equal(noRaw.sources.length, 0);
  assert.match(noRaw.rejected[0].reason, /原始正文记录/);
});

test("a bound PBOC event can support a separate explicit target reaction without becoming exposure or completing other targets", async () => {
  const f = recapFixture(), source = candidate(f), verified = await verifyResearchSources([{ sources: [source], alternatives: [] }], f.envelope, { reader: () => opened() });
  const root = verified.sources[0], target = recapTargets(f.envelope).find(t => t.symbol === 'XLF'), entry = f.attribution.entries.find(e => e.target === target.symbol);
  const report = { ...f.ledger.sources.find(s => s.id === '0-causal'), id: 'pboc-financial-reaction', targets: [target.symbol], supportingExcerpt: `XLF rose because ${excerpt} This supports credit expectations, while weaker demand remains an offset.` };
  report.excerptHash = stableHash(normalizedEvidenceText(report.supportingExcerpt));
  Object.assign(entry.chains[0], { rootEvidenceId: root.id, reactionEvidenceId: report.id, eventAnchors: ['抵押补充贷款', '0.25个百分点'] });
  entry.counterEvidenceIds = [report.id];
  const value = { ...f.attribution, entries: [entry] }, ledger = { sources: [root, report] };
  assert.doesNotThrow(() => validateRecapAttribution(value, f.envelope, [target], ledger));
  const candidates = recapAttributionCandidates(f.envelope, recapTargets(f.envelope), ledger);
  assert.equal(candidates.find(c => c.target === target.symbol).reportedEligible, true);
  assert.ok(candidates.filter(c => c.target !== target.symbol).every(c => !c.reportedEligible));
  root.authorityDocumentVersion = 'older';
  assert.throws(() => validateRecapAttribution(value, f.envelope, [target], ledger), /直接对应/);
});
