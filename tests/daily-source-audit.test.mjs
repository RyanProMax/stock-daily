import assert from "node:assert/strict";
import test from "node:test";
import {
  auditReportSources,
  fedSpeechPublishedAtCandidates,
  isPublicAddress,
  openExternalSource,
  normalizedEvidenceText,
  readExternalSource,
  sourceBodyText,
  sourcePublishedAtCandidates,
} from "../scripts/daily-source-audit.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

test("Fed speech timing binds the article date and exact official RSS identity", async () => {
  const source = "https://www.federalreserve.gov/newsevents/speech/warsh20260828a.htm";
  const article = `<div id="article"><div class="heading col-xs-12"><p class="article__time">August 28, 2026</p><h3 class="title">In Our Time</h3></div><p>A speech about the policy outlook, economic activity and the current balance of risks.</p></div>`;
  const feed = `<rss><channel><item><title>Warsh, In Our Time</title><link><![CDATA[${source}]]></link><guid><![CDATA[${source}]]></guid><category>Speech</category><pubDate>Fri, 28 Aug 2026 14:00:00 GMT</pubDate></item></channel></rss>`;
  assert.deepEqual(fedSpeechPublishedAtCandidates(article, feed, source), ["2026-08-28T14:00:00.000Z"]);
  for (const badFeed of [feed.replaceAll("warsh20260828a", "warsh20260827a"), feed.replace("14:00:00 GMT", "14:00:00"), feed.replace("28 Aug", "29 Aug"), feed.replace("<category>Speech", "<category>Testimony")]) {
    assert.deepEqual(fedSpeechPublishedAtCandidates(article, badFeed, source), []);
  }
  assert.deepEqual(fedSpeechPublishedAtCandidates(article.replace("August 28", "August 27"), feed, source), []);
  assert.deepEqual(fedSpeechPublishedAtCandidates(article, feed, source.replace("www.federalreserve.gov", "unrelated.example")), []);
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(article), "text/html", source), []);
  const requests = [];
  const result = await readExternalSource(source, {
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    requester: async (url) => { requests.push(url); return { status: 200, contentType: "text/html", body: Buffer.from(url === source ? article : feed) }; },
  });
  assert.deepEqual(requests, [source, "https://www.federalreserve.gov/feeds/speeches.xml"]);
  assert.deepEqual(result.publishedAtCandidates, ["2026-08-28T14:00:00.000Z"]);
});

test("Sina flash publication metadata is recognized without using its update time", () => {
  const html = Buffer.from(`<meta property="bytedance:published_time" content="2026-09-11T19:17:38+08:00" />
    <meta property="bytedance:updated_time" content="2026-09-14T19:38:20+08:00" />`);
  assert.deepEqual(sourcePublishedAtCandidates(html, "text/html", "https://finance.sina.com.cn/7x24/2026-09-11/doc-test.shtml"), ["2026-09-11T11:17:38.000Z"]);
});

test("source body decodes named punctuation entities like the rendered article", () => {
  const body = Buffer.from('<article>Stocks rose &mdash; oil eased. Investors&rsquo; estimates &ldquo;matched&rdquo; forecasts &ndash; a relief.</article>');
  assert.equal(sourceBodyText(body), 'Stocks rose — oil eased. Investors’ estimates “matched” forecasts – a relief.');
});

test("source body removes whole style and script blocks containing other closing tags", () => {
  const html = Buffer.from(`<style>.icon{background:url('data:image/svg+xml,<svg></svg>')} hidden styles must not become evidence </style>
    <script>const misleading = '</style> Stocks rose because of a fabricated event';</script>
    <article><h1>Verified article</h1><p>Oil eased and stocks rose.</p></article>`);
  assert.equal(sourceBodyText(html), "Verified article\nOil eased and stocks rose.");
});

test("source reader retries a transport failure only on prevalidated public addresses", async () => {
  const addresses = [{address:"93.184.216.34",family:4},{address:"93.184.216.35",family:4}];
  const visited=[];
  const result=await readExternalSource("https://publisher.example.com/story",{
    resolver:async()=>addresses,
    requester:async(_url,destination)=>{
      visited.push(destination.address);
      if(visited.length===1)throw Object.assign(new Error("TLS transport failed"),{code:35});
      return {status:200,body:Buffer.from(`<article>${"Verified market event. ".repeat(8)}</article>`)};
    },
  });
  assert.equal(result.status,200);
  assert.deepEqual(visited,addresses.map(item=>item.address));
  for(const failure of [429,403,"ERR_TLS_CERT_ALTNAME_INVALID","oversized"]){
    let calls=0;
    await assert.rejects(readExternalSource("https://publisher.example.com/story",{
      resolver:async()=>addresses,
      requester:async()=>{calls++;if(typeof failure==='number')return {status:failure};throw Object.assign(new Error(failure),{code:failure});},
    }));
    assert.equal(calls,1,String(failure));
  }
  let calls=0;
  await assert.rejects(readExternalSource("https://publisher.example.com/story",{
    resolver:async()=>[...addresses,{address:"127.0.0.1",family:4}],
    requester:async()=>{calls++;},
  }),/内网/);
  assert.equal(calls,0);
});

test("21jingji date belongs to the article heading, not body or recommendations", () => {
  const html = Buffer.from(`<div class="titleHead"><h1>市场收盘报道</h1>
    <div class="newsInfo">记者<br /></div><div class="newsDate">2026-09-14 10:24</div></div>
    <div class="txtContent">2026-09-12 08:30</div><aside><div class="newsDate">2026-09-15 10:24</div></aside>`);
  assert.deepEqual(sourcePublishedAtCandidates(html, "text/html", "https://m.21jingji.com/article/20260914/herald/report.html"), ["2026-09-14T02:24:00.000Z"]);
  assert.deepEqual(sourcePublishedAtCandidates(html, "text/html", "https://unregistered.example/report"), []);
});

test("21jingji author-line time is scoped to the current article header", () => {
  const source = "https://m.21jingji.com/article/20260828/herald/report.html";
  const header = `<div class="titleHead"><h1>软件业绩报道</h1><div class="newsAuthor"><div class="author-avatar"></div><div class="author-infos"><a>投资情报</a><span>唐铮玮 2026-08-28 10:52</span></div></div></div>`;
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(header), "text/html", source), ["2026-08-28T02:52:00.000Z"]);
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(header.replace('class="titleHead"', 'class="recommendation"')), "text/html", source), []);
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from(header), "text/html", "https://example.com/article"), []);
});

test("NBD publication metadata binds its Cambrian article identity and ignores update time", () => {
  const source = "https://m.nbd.com.cn/articles/2026-08-28/4563439.html";
  const article = { "@context": "https://ziyuan.baidu.com/contexts/cambrian.jsonld", "@id": source, title: "收盘报道", pubDate: "2026-08-28T15:47:59", upDate: "2026-09-14T10:00:00" };
  const read = (value, url = source) => sourcePublishedAtCandidates(Buffer.from(`<script type="application/ld+json">${JSON.stringify(value)}</script>`), "text/html", url);
  assert.deepEqual(read(article), ["2026-08-28T07:47:59.000Z"]);
  assert.deepEqual(read({ ...article, "@id": source.replace("4563439", "4563441") }), []);
  assert.deepEqual(read({ ...article, pubDate: undefined }), []);
  assert.deepEqual(read({ ...article, "@context": "https://example.com/other" }), []);
  assert.deepEqual(read(article, "https://example.com/article"), []);
});

test("21jingji desktop article timestamp and transport fallback retain source verification", async () => {
  const mobile = "https://m.21jingji.com/article/20260914/herald/b9de940f10c470d87f6d3fd8e02fa710.html";
  const desktop = mobile.replace("m.21jingji.com", "www.21jingji.com");
  const body = Buffer.from(`<div class="main"><h1>市场收盘报道</h1><h6>2026年09月14日 16:32 &nbsp;21世纪经济报道</h6>
    <div class="content">${"有来源支持的当日市场事件。".repeat(10)}</div></div>
    <aside><h6>2026年09月15日 17:00</h6></aside>`);
  assert.deepEqual(sourcePublishedAtCandidates(body, "text/html", desktop), ["2026-09-14T08:32:00.000Z"]);
  assert.deepEqual(sourcePublishedAtCandidates(body, "text/html", "https://example.com/report"), []);
  const resolved = [], requested = [];
  const result = await readExternalSource(mobile, {
    resolver: async hostname => { resolved.push(hostname); return [{address:"93.184.216.34",family:4}]; },
    requester: async url => {
      requested.push(url);
      if(url === mobile) throw Object.assign(new Error("TLS transport failed"), {code:35});
      return {status:200,body};
    },
  });
  assert.deepEqual(resolved, ["m.21jingji.com", "www.21jingji.com"]);
  assert.deepEqual(requested, [mobile, desktop]);
  assert.equal(result.source, mobile);
  assert.equal(result.finalUrl, desktop);
  assert.deepEqual(result.publishedAtCandidates, ["2026-09-14T08:32:00.000Z"]);
  let calls = 0;
  await assert.rejects(readExternalSource(mobile, {
    resolver: async hostname => [{address:hostname.startsWith("www.")?"127.0.0.1":"93.184.216.34",family:4}],
    requester: async () => { calls++; throw Object.assign(new Error("TLS transport failed"), {code:35}); },
  }), /内网/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(readExternalSource(mobile, {
    resolver: async () => [{address:"93.184.216.34",family:4}],
    requester: async () => { calls++; return {status:403}; },
  }), /HTTP 403/);
  assert.equal(calls, 1);
});

test("source audit opens every unique external evidence URL", async () => {
  const report = fixtureReport(fixtureInput());
  const visited = [];
  const result = await auditReportSources(report, {
    opener: async (source) => {
      visited.push(source);
      return { source, status: 200, finalUrl: source };
    },
  });
  assert.equal(result.status, "audited");
  assert.equal(result.sourceCount, 5);
  assert.equal(new Set(visited).size, 5);
  assert.ok(visited.every((source) => source.startsWith("https://")));
});

test("source audit rejects an external URL that cannot be opened", async () => {
  const report = fixtureReport(fixtureInput());
  await assert.rejects(
    () =>
      auditReportSources(report, {
        opener: async (source) => {
          throw new Error(`unreachable ${source}`);
        },
      }),
    /unreachable/,
  );
});

test("source opener validates and pins every HTTPS redirect destination", async () => {
  const requested = [];
  const resolved = [];
  const result = await openExternalSource(
    "https://publisher.example.com/article",
    {
      resolver: async (hostname) => {
        resolved.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      requester: async (url, destination) => {
        requested.push({ url, destination });
        return requested.length === 1
          ? { status: 302, location: "https://cdn.example.net/story" }
          : { status: 200 };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, "https://cdn.example.net/story");
  assert.deepEqual(resolved, ["publisher.example.com", "cdn.example.net"]);
  assert.equal(requested.length, 2);
  assert.ok(
    requested.every(
      ({ destination }) => destination.address === "93.184.216.34",
    ),
  );
});

test("default opener pins public DNS and the verified source address", async () => {
  const calls = [];
  const result = await openExternalSource(
    "https://publisher.example.com/article",
    {
      curlPath: "/mock/curl",
      runner: async (_binary, args) => {
        calls.push(args);
        if (args.includes("Accept: application/dns-json")) {
          return {
            stdout: JSON.stringify({
              Status: 0,
              Answer: [
                {
                  type: 1,
                  data: "93.184.216.34",
                },
              ],
            }),
          };
        }
        return { stdout: "200\t" };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.ok(
    calls[0].includes("cloudflare-dns.com:443:1.1.1.1:443"),
  );
  assert.ok(
    calls[1].includes("publisher.example.com:443:93.184.216.34:443"),
  );
  assert.ok(calls[1].includes("Host: publisher.example.com:443"));
  assert.equal(calls[1].includes("--location"), false);
});

test("source opener blocks private initial and DNS destinations", async () => {
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const address of [
    "127.0.0.1",
    "10.0.0.4",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }

  await assert.rejects(
    () => openExternalSource("https://127.0.0.1/private"),
    /禁止访问本机或内网地址/,
  );
  let requested = false;
  await assert.rejects(
    () =>
      openExternalSource("https://publisher.example.com/article", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.4", family: 4 },
        ],
        requester: async () => {
          requested = true;
          return { status: 200 };
        },
      }),
    /禁止访问本机或内网地址/,
  );
  assert.equal(requested, false);
});

test("source opener blocks redirects to metadata services", async () => {
  let requestCount = 0;
  await assert.rejects(
    () =>
      openExternalSource("https://publisher.example.com/article", {
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
        requester: async () => {
          requestCount += 1;
          return {
            status: 302,
            location: "https://169.254.169.254/latest/meta-data/",
          };
        },
      }),
    /禁止访问本机或内网地址/,
  );
  assert.equal(requestCount, 1);
});

test("full source reader extracts visible body and publication metadata", async () => {
  const html = Buffer.from(`
    <html><head>
      <meta property="article:published_time" content="2026-08-28T16:10:00-04:00">
      <meta property="article:modified_time" content="2026-08-28T17:05:00-04:00">
      <script>ignore this value 999</script>
    </head><body><article>Revenue was $68.1 billion &amp; consensus was $66.2 billion. The company also reported stronger adjusted earnings and supplied a detailed market update for investors.</article></body></html>
  `);
  assert.equal(
    sourcePublishedAtCandidates(html, "text/html; charset=utf-8")[0],
    "2026-08-28T20:10:00.000Z",
  );
  assert.doesNotMatch(sourceBodyText(html), /999/);
  assert.match(sourceBodyText(html), /\$68\.1 billion & consensus/);

  const result = await readExternalSource(
    "https://publisher.example.com/article",
    {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      requester: async () => ({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: html,
      }),
    },
  );
  assert.match(result.text, /Revenue was/);
  assert.deepEqual(result.publishedAtCandidates, [
    "2026-08-28T20:10:00.000Z",
  ]);
  assert.notEqual(
    normalizedEvidenceText("Revenue was 68.1 billion"),
    normalizedEvidenceText("Revenue was 681 billion"),
  );
});

test("source reader honors an HTML meta charset when the HTTP header omits it", async () => {
  const html = Buffer.concat([
    Buffer.from(
      '<html><head><meta charset="gb2312"><meta property="article:published_time" content="2026-08-28T16:10:00+08:00"></head><body><article>',
      "ascii",
    ),
    Buffer.from([0xd6, 0xd0, 0xb9, 0xfa]),
    Buffer.from(
      " market publisher report with enough verified article text to satisfy deterministic source validation and preserve the original Chinese headline.</article></body></html>",
      "ascii",
    ),
  ]);
  const result = await readExternalSource(
    "https://publisher.example.com/gb2312-article",
    {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      requester: async () => ({
        status: 200,
        contentType: "text/html",
        body: html,
      }),
    },
  );
  assert.match(result.text, /中国 market publisher report/u);
  assert.deepEqual(result.publishedAtCandidates, [
    "2026-08-28T08:10:00.000Z",
  ]);
});

test("non-China publication metadata requires an explicit timezone", () => {
  const timezoneFree = Buffer.from(
    '<html><head><meta property="article:published_time" content="2026-08-28 10:00"></head><body><article>Market report with a timezone-free publication value.</article></body></html>',
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      timezoneFree,
      "text/html",
      "https://apnews.com/article/example",
    ),
    [],
  );
  const explicitlyZoned = Buffer.from(
    '<html><head><meta property="article:published_time" content="2026-08-28T10:00:00-04:00"></head><body><article>Market report with an explicitly zoned publication value.</article></body></html>',
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      explicitlyZoned,
      "text/html",
      "https://apnews.com/article/example",
    ),
    ["2026-08-28T14:00:00.000Z"],
  );
});

test("modification metadata cannot substitute for publication time", () => {
  const html = Buffer.from(`
    <html><head>
      <meta property="article:modified_time" content="2026-08-28T17:05:00-04:00">
      <meta property="og:updated_time" content="2026-08-28T17:06:00-04:00">
      <script type="application/ld+json">{"dateModified":"2026-08-28T21:07:00Z"}</script>
    </head><body><article>An older report was edited without a new publication event.</article></body></html>
  `);
  assert.deepEqual(sourcePublishedAtCandidates(html, "text/html"), []);
  const visibleUpdate = Buffer.from(
    "<html><body><article>更新时间 2026年08月28日 16:37 正文仍是更早发布的旧事件。</article></body></html>",
  );
  assert.deepEqual(sourcePublishedAtCandidates(visibleUpdate, "text/html"), []);
});

test("related-article JSON-LD timestamps cannot verify the cited article", () => {
  const html = Buffer.from(`
    <html><head><script type="application/ld+json">
    {"@graph":[
      {"@type":"NewsArticle","url":"https://publisher.example.com/cited","datePublished":"2026-08-20T10:00:00Z"},
      {"@type":"NewsArticle","url":"https://publisher.example.com/related","datePublished":"2026-08-28T20:10:00Z"}
    ]}
    </script></head><body><article>The cited article has enough visible source text for deterministic evidence verification and contains no other publication timestamp.</article></body></html>
  `);
  assert.deepEqual(
    sourcePublishedAtCandidates(
      html,
      "text/html",
      "https://publisher.example.com/cited?tracking=1",
    ),
    ["2026-08-20T10:00:00.000Z"],
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      html,
      "text/html",
      "https://publisher.example.com/unknown",
    ),
    [],
  );
});

test("CLS publication metadata binds Unix time to the current routed article", () => {
  const data = {
    page: "/detail/[id]", query: { id: "2461050" },
    props: { pageProps: {
      articleDetail: { id: 2461050, ctime: 1787315618 },
      recommendations: [{ id: 999, ctime: 1788000000 }],
    } },
  };
  const html = (value) => Buffer.from(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(value)}</script>`);
  const url = "https://www.cls.cn/detail/2461050";
  assert.deepEqual(sourcePublishedAtCandidates(html(data), "text/html", url), ["2026-08-21T12:33:38.000Z"]);
  for (const changed of [
    { ...data, page: "/telegraph" },
    { ...data, query: { id: "999" } },
    { ...data, props: { pageProps: { articleDetail: { id: 999, ctime: 1787315618 } } } },
    { ...data, props: { pageProps: { articleDetail: { id: 2461050, ctime: 1787315618000 } } } },
  ]) assert.deepEqual(sourcePublishedAtCandidates(html(changed), "text/html", url), []);
  assert.deepEqual(sourcePublishedAtCandidates(html(data), "text/html", "https://not-cls.cn/detail/2461050"), []);
  assert.deepEqual(sourcePublishedAtCandidates(html(data), "text/html", "https://www.cls.cn/detail/999"), []);
  assert.deepEqual(sourcePublishedAtCandidates(Buffer.from('<script id="__NEXT_DATA__">invalid</script>'), "text/html", url), []);
});

test("publication metadata recognizes labeled visible Chinese article timestamps", () => {
  const html = Buffer.from(
    "<html><body><article><h1>市场收盘复盘</h1><p>发布时间：2026年08月28日 16:37</p><p>正文包含足够长度的市场事实与来源说明。</p></article></body></html>",
  );
  assert.deepEqual(sourcePublishedAtCandidates(html, "text/html"), [
    "2026-08-28T08:37:00.000Z",
  ]);
  const compact = Buffer.from(
    "<html><body><article><h1>A股市场复盘</h1><p>发布于 2026-08-28 10:26</p></article></body></html>",
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      compact,
      "text/html",
      "https://www.chnfund.com/article/example",
    ),
    ["2026-08-28T02:26:00.000Z"],
  );
  const semanticClass = Buffer.from(
    '<html><body><article><span class="publish-time">2026-08-28 10:26</span><p>正文。</p></article></body></html>',
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      semanticClass,
      "text/html",
      "https://www.chnfund.com/article/example",
    ),
    ["2026-08-28T02:26:00.000Z"],
  );
  const eastmoney = Buffer.from(
    '<!--published at 2026/8/30 14:36:52 by server--><div class="tipbox"><div class="infos"><div class=" item">2026年08月28日 10:09</div><div class="item">来源：上海证券报</div></div></div>',
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      eastmoney,
      "text/html",
      "https://finance.eastmoney.com/a/example.html",
    ),
    ["2026-08-28T02:09:00.000Z"],
  );
  const yicai = Buffer.from(
    "<script>[['atitle', '文章'], ['actime', '2026-08-28T13:59:26+08'], ['autime', '2026-08-28T14:03:11+08']]</script>",
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      yicai,
      "text/html",
      "https://www.yicai.com/video/example.html",
    ),
    ["2026-08-28T05:59:26.000Z"],
  );
  const stcn = Buffer.from(
    '<div class="info"><span>来源：证券时报网</span><span>作者：流云</span><span>2026-08-28 12:30</span></div>',
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      stcn,
      "text/html",
      "https://www.stcn.com/article/detail/example.html",
    ),
    ["2026-08-28T04:30:00.000Z"],
  );
  const metadataWithoutOffset = Buffer.from(
    '<html><head><meta property="article:published_time" content="2026-08-29 08:00"></head><body><article>中国市场来源正文。</article></body></html>',
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      metadataWithoutOffset,
      "text/html",
      "https://www.chnfund.com/article/metadata-time",
    ),
    ["2026-08-29T00:00:00.000Z"],
  );
});

test("an event timestamp in article prose cannot masquerade as publication time", () => {
  const html = Buffer.from(
    "<html><body><article><h1>旧闻回顾</h1><p>会议于2026年08月28日 16:37召开，随后市场出现波动。</p></article></body></html>",
  );
  assert.deepEqual(sourcePublishedAtCandidates(html, "text/html"), []);
  const semanticTime = Buffer.from(
    '<html><body><article><time itemprop="datePublished" datetime="2026-08-28T16:37:00+08:00">8月28日</time></article></body></html>',
  );
  assert.deepEqual(sourcePublishedAtCandidates(semanticTime, "text/html"), [
    "2026-08-28T08:37:00.000Z",
  ]);
});

test("publication metadata recognizes SEC acceptance timestamps in text filings", () => {
  const filing = Buffer.from(
    "<SEC-DOCUMENT>\n<ACCEPTANCE-DATETIME>20260826160353\nSalesforce results filing text.",
  );
  assert.deepEqual(
    sourcePublishedAtCandidates(
      filing,
      "text/plain; charset=utf-8",
      "https://www.sec.gov/Archives/edgar/data/1108524/example.txt",
    ),
    ["2026-08-26T20:03:53.000Z"],
  );
});

test("SEC exhibits obtain acceptance time from the accession submission", async () => {
  const exhibitUrl =
    "https://www.sec.gov/Archives/edgar/data/1108524/000110852426000187/crm-q2fy27xexhibit991.htm";
  const requested = [];
  const result = await readExternalSource(exhibitUrl, {
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    requester: async (url) => {
      requested.push(url);
      if (url.endsWith("0001108524-26-000187.txt")) {
        return {
          status: 200,
          contentType: "text/plain; charset=utf-8",
          body: Buffer.from(
            "<SEC-DOCUMENT>\n<ACCEPTANCE-DATETIME>20260826160353\nComplete submission text with enough additional filing content to pass the source length threshold.",
          ),
        };
      }
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: Buffer.from(
          "<html><body><article>Salesforce announced quarterly revenue and earnings results with enough official exhibit text for deterministic source verification.</article></body></html>",
        ),
      };
    },
  });
  assert.equal(requested.length, 2);
  assert.match(requested[1], /0001108524-26-000187\.txt$/u);
  assert.deepEqual(result.publishedAtCandidates, [
    "2026-08-26T20:03:53.000Z",
  ]);
});
