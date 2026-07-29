import assert from "node:assert/strict";
import test from "node:test";
import {
  assignSignalMetadata,
  checkpointDueAt,
  classifySourceTier,
  enrichNewsItem,
  resolveListedEntities,
} from "../scripts/signal-intelligence.mjs";

const procter = {
  title: "宝洁第四财季销售净额212.0亿美元，预估213.4亿美元。",
  facts:
    "宝洁第四财季销售净额212.0亿美元，预估213.4亿美元。第四财季内生性收入增长0％，预估增长1.85％。第四财季核心每股收益1.43美元，预估1.41美元。宝洁预计2027年内生性收入增长1％至3％，预估增长2.44％。宝洁预计2027年核心每股收益6.89美元至7.11美元，市场预估7.02美元。宝洁美股盘前跌2.5%。",
  url: "https://wallstreetcn.com/livenews/example",
  source: "华尔街见闻",
  publishedAt: "2026-07-29T11:01:04.000Z",
  regions: ["US"],
};

test("signal enrichment calculates expectation gaps and resolves listed entities", () => {
  const enriched = enrichNewsItem(procter);
  assert.equal(enriched.evidenceSource.tier, "secondary");
  assert.deepEqual(enriched.entities[0], {
    name: "宝洁",
    nameEn: "Procter & Gamble",
    ticker: "PG",
    exchange: "NYSE",
  });
  assert.equal(enriched.baselineKind, "guidance");
  assert.deepEqual(
    enriched.metrics.map(({ id, actual, expected, surprise, surpriseUnit }) => ({
      id,
      actual,
      expected,
      surprise,
      surpriseUnit,
    })),
    [
      {
        id: "revenue",
        actual: 212,
        expected: 213.4,
        surprise: -1.4,
        surpriseUnit: "亿美元",
      },
      {
        id: "organic-growth",
        actual: 0,
        expected: 1.85,
        surprise: -1.85,
        surpriseUnit: "pp",
      },
      {
        id: "core-eps",
        actual: 1.43,
        expected: 1.41,
        surprise: 0.02,
        surpriseUnit: "美元",
      },
      {
        id: "2027-organic-guidance",
        actual: 2,
        expected: 2.44,
        surprise: -0.44,
        surpriseUnit: "pp",
      },
      {
        id: "2027-eps-guidance",
        actual: 7,
        expected: 7.02,
        surprise: -0.02,
        surpriseUnit: "美元",
      },
    ],
  );
  assert.equal(enriched.reactions[0].instrument, "PG");
  assert.equal(enriched.reactions[0].change, "-2.5%");
});

test("source tier and Chinese exchange ticker resolution are deterministic", () => {
  assert.equal(
    classifySourceTier({
      url: "https://www.stats.gov.cn/sj/zxfb/example.html",
      source: "国家统计局",
    }),
    "first_party",
  );
  assert.equal(
    classifySourceTier({
      url: "https://www.reuters.com/markets/example",
      source: "Reuters",
    }),
    "wire",
  );
  assert.deepEqual(
    resolveListedEntities(
      "海亮股份(002203.SZ)公告称将实施增持，永鼎股份(600105.SH)获得订单，格罗方德获得研发资金，新东方公布季度业绩。",
    ).map(({ name, ticker, exchange }) => ({ name, ticker, exchange })),
    [
      { name: "海亮股份", ticker: "002203", exchange: "SZSE" },
      { name: "永鼎股份", ticker: "600105", exchange: "SSE" },
      { name: "格罗方德", ticker: "GFS", exchange: "NASDAQ" },
      { name: "新东方", ticker: "EDU", exchange: "NYSE" },
    ],
  );
});

test("signal ranking excludes low-importance items and caps display roles", () => {
  const news = [
    {
      ...procter,
      title: "宝洁销售与内生增长低于预期",
    },
    {
      title: "美国三大指数同步下挫",
      facts:
        "The S&P 500 lost 0.8%, Nasdaq Composite dropped 1%, and the Dow Jones Industrial Average fell 1.6%.",
      url: "https://finance.yahoo.com/example",
      source: "Yahoo Finance",
      publishedAt: "2026-07-29T12:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "联邦公开市场委员会公布政策决定",
      facts:
        "The Federal Reserve issued its monetary policy decision and statement.",
      url: "https://www.federalreserve.gov/newsevents/pressreleases/example.htm",
      source: "Federal Reserve",
      publishedAt: "2026-07-29T18:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "美国能源信息署公布原油库存",
      facts:
        "The U.S. Energy Information Administration published weekly petroleum data.",
      url: "https://www.eia.gov/petroleum/example",
      source: "U.S. Energy Information Administration",
      publishedAt: "2026-07-29T17:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "美国证券监管机构发布例行论坛报告",
      facts:
        "The SEC published an annual forum report containing non-binding recommendations.",
      url: "https://www.sec.gov/newsroom/example",
      source: "U.S. Securities and Exchange Commission",
      publishedAt: "2026-07-29T16:00:00.000Z",
      regions: ["US"],
    },
    {
      title: "美国例行公告没有改变现行规则",
      facts:
        "The agency republished an administrative notice without changing current rules.",
      url: "https://www.sec.gov/newsroom/low",
      source: "U.S. Securities and Exchange Commission",
      publishedAt: "2026-07-29T15:00:00.000Z",
      regions: ["US"],
    },
  ];
  const stories = [
    { importance: 5 },
    { importance: 5 },
    { importance: 5 },
    { importance: 4 },
    { importance: 3 },
    { importance: 1 },
  ];
  const ranked = assignSignalMetadata(news, stories);
  assert.equal(ranked[5].roleByMarket.US, "excluded");
  assert.equal(
    ranked.filter((item) => item.roleByMarket.US === "core").length,
    3,
  );
  assert.equal(
    ranked.filter((item) => item.roleByMarket.US === "supporting").length,
    2,
  );
  assert.equal(ranked[0].roleByMarket.US, "core");
});

test("checkpoint due dates obey the declared horizon", () => {
  assert.equal(
    checkpointDueAt("2026-07-29", "1-5d", 3),
    "2026-08-01T13:00:00.000Z",
  );
  assert.throws(
    () => checkpointDueAt("2026-07-29", "intraday", 2),
    /时间范围不一致/,
  );
});
