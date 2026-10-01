import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readExternalSource } from "../scripts/daily-source-audit.mjs";
import { snapshotFromOpenedSource, openedSourceFromSnapshot } from "../scripts/evidence-source-snapshots.mjs";
import { stableHash, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { MarketWorkflow } from "../scripts/daily-workflow.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";
import { PBOC_NEWS_HOME, collectRecapPbocNewsData, validateRecapPbocNewsData, pbocNewsIndexEntries, pbocNewsResearchContext, pbocNewsResearchSources, pbocNewsSourceReader, auditRecapPbocNewsSources } from "../scripts/recap-pboc-news-data.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

const f = recapFixture("CN"), fetchedAt = "2026-08-21T09:00:00Z";
const escape = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const body = "中国人民银行调整政策工具，支持实体经济。新增额度用于符合条件的金融机构；实施仍需遵循市场化、法治化原则，并落实风险管理要求。下一步将根据经济运行情况继续观察政策效果，公告没有报告已实现的贷款投放或股价反应。";
function article(id = 1, { title = `中国人民银行调整第${id}项货币政策工具`, text = body, date = "2026-08-20", clock = "17:52:48" } = {}) {
  const url = `https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/${date.replaceAll("-", "")}174749${String(id).padStart(5, "0")}/index.html`;
  const html = `<head><meta name="createDate" content="${date} 19:53:02"><meta name="SiteName" content="沟通交流"><meta name="SiteIDCode" content="goutongjiaoliu"><meta name="ColumnName" content="新闻"><meta name="ColumnType" content="工作动态"><meta name="ContentSource" content=""><meta name="Url" content="${new URL(url).pathname}"><meta name="ArticleTitle" content="${escape(title)}"><meta name="PubDate" content="${date}"><title>${escape(title)}</title></head><body><table><tr><td><table><tr><td><table><tr><td><h2>${escape(title)}</h2></td></tr></table></td></tr></table><table><tr><td>文章来源：<span id="laiyuan"></span></td><td align="right">${date} ${clock}</td></tr></table><table><tr><td class="content"><div id="zoom" class="zoom1">${text.split("\n").map(p => `<p>${escape(p)}</p>`).join("")}</div></td></tr></table></td></tr></table><footer>网站标识码：bm25000001 网站主办单位：中国人民银行办公厅</footer></body>`;
  return { url, title, html };
}
function home(articles, extra = "") {
  return `<head><meta name="SiteName" content="中国人民银行"><meta name="SiteIDCode" content="rmyh"><meta name="ColumnName" content="首页"><meta name="ColumnType" content="工作动态"><meta name="createDate" content="2026-08-21 19:00:00"></head><body><header>中国人民银行首页提供新闻发布、政策信息、统计数据、金融服务与公众沟通入口。首页展示的是网站近期更新内容，读者须进入对应新闻原文查看正式标题、完整正文与实际发布时间。</header>${articles.map(a => `<a href="${a.url}" title="${escape(a.title)}">${escape(a.title)}</a><a href="${new URL(a.url).pathname}" title="${escape(a.title.slice(0, 8))}...">图片</a>`).join("")}${extra}<footer>网站标识码：bm25000001 网站主办单位：中国人民银行办公厅</footer></body>`;
}
async function open(url, html) {
  const opened = await readExternalSource(url, { includeRaw: true, lookupPublicationMetadata: false, resolver: async () => [{ address: "8.8.8.8", family: 4 }], requester: async () => ({ status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(html) }) });
  return { ...opened, fetchedAt };
}
function readerFor(articles, { homepage = home(articles), failures = [] } = {}) {
  const calls = [], documents = new Map([[PBOC_NEWS_HOME, homepage], ...articles.map(a => [a.url, a.html])]);
  return { calls, reader: async (url, options) => { calls.push(url); assert.equal(options.includeRaw, true); assert.equal(options.lookupPublicationMetadata, false); if (failures.includes(url)) throw new Error("Actual fixture HTTP refusal"); if (!documents.has(url)) throw new Error("Unknown original"); return open(url, documents.get(url)); } };
}
const collect = async (articles, options = {}) => {
  const r = readerFor(articles, options);
  return { ...(await collectRecapPbocNewsData(f.envelope, { reader: r.reader })), calls: r.calls };
};

test("native homepage deduplicates full titles and discovers only its recent own news paths", async () => {
  const a = article(), other = article(2), outside = article(3, { date: "2026-08-16" }), future = article(4, { date: "2026-08-22" });
  const r = readerFor([a, other], { homepage: home([a, other, outside, future], '<a href="https://evil.example/goutongjiaoliu/113456/113469/2026082017474900001/index.html">伪造链接</a><a href="/zhengcehuobisi/20260820/index.html">其他栏目</a>') });
  const book = await collectRecapPbocNewsData(f.envelope, { reader: r.reader });
  assert.equal(book.completed, true); assert.equal(book.articles.length, 2); assert.deepEqual(book.gaps, []);
  assert.deepEqual(r.calls, [PBOC_NEWS_HOME, a.url, other.url]);
  assert.deepEqual(pbocNewsIndexEntries(book.index, f.envelope).map(i => i.url), [a.url, other.url]);
  assert.equal(pbocNewsResearchSources(book, f.envelope, f.plan)[0].publishedAt, "2026-08-20T09:52:48.000Z");
});

test("spoofed homepage ownership, duplicate identity and conflicting complete anchor titles fail closed", async () => {
  const a = article();
  for (const homepage of [home([a]).replace('content="rmyh"', 'content="other"'), home([a]).replace("bm25000001", "other"), home([a]).replace("中国人民银行办公厅", "其他主办机构"), home([a]).replace("</head>", '<meta name="SiteIDCode" content="rmyh"></head>'), home([a], `<a href="${a.url}" title="另一份不同的完整货币政策文件">其他</a>`), home([a]).replaceAll(escape(a.title), `${escape(a.title.slice(0, 6))}...`)]) {
    const r = readerFor([a], { homepage }), book = await collectRecapPbocNewsData(f.envelope, { reader: r.reader });
    assert.equal(book.index, null); assert.equal(book.gaps[0].stage, "index"); assert.equal(book.articles.length, 0); assert.equal(r.calls.length, 1);
  }
});

test("an article's native clock excludes post-close and pre-window policies without using CMS or homepage update time", async () => {
  const a = article(), post = article(2, { date: "2026-08-21", clock: "16:00:00" }), old = article(3, { date: "2026-08-17", clock: "08:00:00" });
  const book = await collect([a, post, old]);
  assert.equal(book.articles.length, 3); assert.equal(book.gaps.length, 0);
  const context = pbocNewsResearchContext(book, f.envelope);
  assert.equal(context.articles.length, 1); assert.equal(context.articles[0].url, a.url);
});

test("full announcement synopsis seeds the announcement while retaining every attached condition separately", async () => {
  const synopsis = body, attachment = body.repeat(10), a = article(1, { text: `${synopsis}\n附件：\n金融支持服务业指导意见\n${attachment}` });
  const book = await collect([a]), context = pbocNewsResearchContext(book, f.envelope), sources = pbocNewsResearchSources(book, f.envelope, f.plan);
  assert.equal(context.articles[0].factScope, "complete_announcement_synopsis");
  assert.equal(sources[0].supportingExcerpt, synopsis); assert.equal(sources[0].facts, synopsis); assert.equal(sources[0].scope, "event_only"); assert.equal(sources[0].causalConnection, false);
  assert.equal(context.articles[0].fullOwnedBody, `${synopsis}\n附件：\n金融支持服务业指导意见\n${attachment}`);
  const ledger = await verifyResearchSources([{ sources, alternatives: [] }], f.envelope, { reader: pbocNewsSourceReader(book, () => { throw new Error("Replay must not reread the network"); }) });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  auditRecapPbocNewsSources(book, f.envelope, f.plan, ledger, { snapshots: book.articles });
  const altered = structuredClone(ledger); altered.sources[0].supportingExcerpt = body.replace("公告没有报告", "公告已经报告");
  assert.throws(() => auditRecapPbocNewsSources(book, f.envelope, f.plan, altered, { snapshots: book.articles }), /事实账本/);
  assert.throws(() => auditRecapPbocNewsSources(book, f.envelope, f.plan, ledger, { snapshots: [] }), /事实账本/);
});

test("a long or incomplete synopsis never becomes an arbitrarily shortened fact", async () => {
  for (const text of [body.repeat(8), `${body.slice(0, -1)}\n附件：\n${body.repeat(8)}`, `${body}\n附件：\n${body}\n附件：\n${body.repeat(8)}`]) {
    const book = await collect([article(1, { text })]);
    assert.deepEqual(pbocNewsResearchSources(book, f.envelope, f.plan), []);
    assert.equal(pbocNewsResearchContext(book, f.envelope).articles[0].fullOwnedBody, text);
  }
  const book = await collect([article(1, { text: body.repeat(250) })]);
  const context = pbocNewsResearchContext(book, f.envelope).articles[0];
  assert.equal(context.fullOwnedBody, null); assert.equal(context.bodyAvailability, "frozen_original_only_above_context_limit");
});

test("a non-policy meeting remains frozen discovery evidence and is not seeded as a policy", async () => {
  const book = await collect([article(1, { title: "中国人民银行行长会见驻华大使" })]);
  assert.equal(book.articles.length, 1); assert.equal(pbocNewsResearchContext(book, f.envelope).articles.length, 0); assert.deepEqual(pbocNewsResearchSources(book, f.envelope, f.plan), []);
});

test("the deterministic eight-article bound retains an explicit gap instead of claiming exhaustive discovery", async () => {
  const articles = Array.from({ length: 9 }, (_, i) => article(i + 1)), r = readerFor(articles), book = await collectRecapPbocNewsData(f.envelope, { reader: r.reader });
  assert.equal(r.calls.length, 9); assert.equal(book.articles.length, 8); assert.equal(book.gaps[0].stage, "capacity"); assert.match(book.gaps[0].reason, /未读取/);
  const changed = structuredClone(book); changed.gaps = [];
  assert.throws(() => validateRecapPbocNewsData(changed, f.envelope), /请求上限|目录顺序/);
  changed.gaps = book.gaps; changed.articles[7] = snapshotFromOpenedSource(articles[8].url, await open(articles[8].url, articles[8].html), fetchedAt);
  assert.throws(() => validateRecapPbocNewsData(changed, f.envelope), /请求上限|目录顺序/);
});

test("an interrupted collection resumes its frozen index and successful article without repeating requests", async () => {
  const a = article(), b = article(2), r = readerFor([a, b]), checkpoints = [];
  const controller = new AbortController();
  await assert.rejects(() => collectRecapPbocNewsData(f.envelope, { reader: r.reader, signal: controller.signal, onCheckpoint: async book => { checkpoints.push(book); if (book.articles.length === 1) controller.abort(new Error("Actual interrupted collection")); } }), /interrupted/);
  const partial = checkpoints.at(-1); assert.equal(partial.completed, false); assert.deepEqual(r.calls, [PBOC_NEWS_HOME, a.url]);
  assert.throws(() => validateRecapPbocNewsData(partial, f.envelope), /完成状态/);
  const resumed = await collectRecapPbocNewsData(f.envelope, { reader: r.reader, resumeBook: partial });
  assert.deepEqual(r.calls, [PBOC_NEWS_HOME, a.url, b.url]); assert.equal(resumed.completed, true);
  const frozen = await collectRecapPbocNewsData(f.envelope, { resumeBook: resumed, reader: () => { throw new Error("Unexpected network read"); } });
  assert.deepEqual(frozen, resumed);
});

test("HTTP failure, title mismatch and an unattempted link cannot be silently omitted or promoted", async () => {
  const a = article(), b = article(2), book = await collect([a, b], { failures: [b.url] });
  assert.equal(book.gaps[0].url, b.url); assert.equal(book.gaps[0].stage, "article");
  const changed = structuredClone(book); changed.gaps = [];
  assert.throws(() => validateRecapPbocNewsData(changed, f.envelope), /未读取/);
  const mismatch = await collect([a], { homepage: home([{ ...a, title: "央行发布另一份不同的完整货币政策" }]) });
  assert.equal(mismatch.articles.length, 0); assert.equal(mismatch.gaps[0].stage, "article");
});

test("independent replay rejects changed bytes, clock, title, fetch time and scope", async () => {
  const a = article(), book = await collect([a]);
  for (const mutate of [b => b.market = "US", b => b.marketAsOf = "2026-08-20", b => b.articles[0].fetchedAt = "2026-08-21T06:00:00Z", b => b.articles[0].publishedAtCandidates = ["2026-08-20T11:53:02Z"], b => b.articles[0].textHash = "wrong", b => { const s = b.articles[0], raw = Buffer.from(a.html.replaceAll(a.title, "央行不同的完整货币政策文件")); const altered = { ...s, bodyBase64: raw.toString("base64"), bodyHash: createHash("sha256").update(raw).digest("hex") }; b.articles[0] = altered; }, b => b.articles.push(b.articles[0])]) {
    const changed = structuredClone(book); mutate(changed); assert.throws(() => validateRecapPbocNewsData(changed, f.envelope));
  }
  assert.equal(openedSourceFromSnapshot(book.articles[0]).text.includes(body), true);
});

test("US collection performs no PBOC network operations and freezes a typed empty book", async () => {
  const us = recapFixture(), book = await collectRecapPbocNewsData(us.envelope, { reader: () => { throw new Error("Unexpected PBOC request for US"); } });
  assert.deepEqual(book, us.pbocNewsData); assert.deepEqual(pbocNewsResearchSources(book, us.envelope, us.plan), []);
});

test("the CN workflow seeds verified policy facts and complete conditions, then reuses them on resume without claiming causality", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-pboc-workflow-"));
  try {
    const a = article(), r = readerFor([a]), book = await collectRecapPbocNewsData(f.envelope, { reader: r.reader }); let collections = 0;
    const workflow = new MarketWorkflow({ input: fixtureInput(), market: "CN", completeRecap: true, workRoot, macroCollector: async () => f.macroData, transmissionCollector: async () => f.transmissionData, companyBackgroundCollector: async () => f.companyBackgroundData, pbocNewsCollector: async () => { collections++; return book; } });
    await workflow.initialize();
    workflow.manifest.socialHash = stableHash(f.social); workflow.manifest.tradingHash = stableHash(f.tradingData);
    await writeFile(resolve(workflow.runDir, "artifacts/social-ledger.json"), JSON.stringify(f.social));
    await writeFile(resolve(workflow.runDir, "artifacts/recap-trading-data.json"), JSON.stringify(f.tradingData));
    workflow.assertResearchCapacity = async () => {};
    const contexts = []; workflow.researchAnomaly = async anomaly => { contexts.push(workflow.researchPayload(anomaly)); return [{ anomalyId: anomaly.id, role: "facts", sources: [], alternatives: [] }]; };
    for (let i = 0; i < 2; i++) {
      contexts.length = 0;
      await assert.rejects(() => workflow.runCompleteRecap(), /0\/20/);
      assert.ok(contexts.length >= 20); assert.equal(new Set(contexts.slice(0, 20).map(item => item.anomaly.target)).size, 20); assert.equal(collections, 1);
      assert.equal(contexts[0].primaryPolicyContext.articles[0].fullOwnedBody, body);
      assert.equal(contexts[0].sharedEvidence.length, 1); assert.equal(contexts[0].sharedEvidence[0].scope, "event_only"); assert.equal(contexts[0].sharedEvidence[0].causalConnection, false);
      assert.equal(workflow.manifest.pbocNewsHash, stableHash(book));
      const stored = JSON.parse(await readFile(resolve(workflow.runDir, "artifacts/recap-pboc-news-data.json"), "utf8")); assert.deepEqual(stored, book);
    }
    assert.equal(r.calls.length, 2);
  } finally { await rm(workRoot, { recursive: true, force: true }); }
});
