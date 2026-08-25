import assert from "node:assert/strict";
import test from "node:test";
import {
  assessAttributionCoverage,
  buildActiveRetrievalPlan,
  evidenceCoversMetric,
  extractArticlePublishedAt,
  includeLocalWrapAnchors,
  parseActiveSearchResults,
  relevanceScore,
  retrieveActiveAttribution,
} from "../scripts/daily-collect.mjs";

const sessions = [
  {
    market: "CN",
    asOf: "2026-08-24",
    previousAsOf: "2026-08-21",
    windowStart: "2026-08-21T07:00:00.000Z",
    windowEnd: "2026-08-24T07:00:00.000Z",
    wrapDeadline: "2026-08-24T09:00:00.000Z",
  },
  {
    market: "US",
    asOf: "2026-08-24",
    previousAsOf: "2026-08-21",
    windowStart: "2026-08-21T20:00:00.000Z",
    windowEnd: "2026-08-24T20:00:00.000Z",
    wrapDeadline: "2026-08-24T22:00:00.000Z",
  },
];

const sectorPerformance = [
  {
    market: "CN",
    symbol: "932078",
    name: "原材料",
    nameEn: "Materials",
    change: "+2.40%",
    direction: "up",
    constituents: [
      { symbol: "600547", name: "山东黄金", nameEn: "Shandong Gold", change: "+4.2%" },
    ],
  },
  {
    market: "US",
    symbol: "XLK",
    name: "信息技术",
    nameEn: "Information Technology",
    change: "-1.30%",
    direction: "down",
    constituents: [
      { symbol: "NVDA", name: "英伟达", nameEn: "NVIDIA", change: "-2.8%" },
    ],
  },
];

const aiChainPerformance = [
  {
    market: "CN",
    layer: "interconnect",
    symbol: "CPO",
    name: "CPO / 光互连",
    nameEn: "CPO / optical interconnects",
    change: "+1.80%",
    direction: "up",
    constituents: [],
  },
  {
    market: "US",
    layer: "chips",
    symbol: "SOXX",
    name: "芯片与设备",
    nameEn: "Chips & equipment",
    change: "-2.10%",
    direction: "down",
    constituents: [
      { symbol: "NVDA", name: "英伟达", nameEn: "NVIDIA", change: "-2.8%" },
    ],
  },
];

function evidence({ market, kind = "event", title, facts, publishedAt }) {
  return {
    title,
    facts,
    url: `https://example.com/${market.toLowerCase()}-${kind}`,
    source: "Fixture",
    publishedAt,
    regions: [market],
    kind,
  };
}

const completeEvidence = [
  evidence({
    market: "CN",
    kind: "market_wrap",
    title: "A股收评：原材料与CPO概念领涨",
    facts: "上证指数收涨，原材料板块上涨，CPO / 光互连走强并带动成长方向。",
    publishedAt: "2026-08-24T07:30:00.000Z",
  }),
  evidence({
    market: "US",
    kind: "market_wrap",
    title: "Wall Street stocks fell as technology and chip shares slid",
    facts: "The S&P 500 and Nasdaq closed lower as Information Technology fell and NVIDIA dropped with Chips & equipment shares.",
    publishedAt: "2026-08-24T20:30:00.000Z",
  }),
];

test("gap assessment skips active retrieval when local wraps and extremes are covered", () => {
  assert.equal(
    buildActiveRetrievalPlan({
      evidence: completeEvidence,
      marketSessions: sessions,
      sectorPerformance,
      aiChainPerformance,
    }).length,
    0,
  );
});

test("gap assessment derives bounded wrap, sector and AI intents", () => {
  const plan = buildActiveRetrievalPlan({
    evidence: completeEvidence.filter((item) => item.regions.includes("US")),
    marketSessions: sessions,
    sectorPerformance,
    aiChainPerformance,
  });
  assert.deepEqual(
    plan.filter((intent) => intent.market === "CN").map((intent) => intent.kind),
    ["market_wrap", "sector_extremes", "ai_extremes"],
  );
  assert.equal(plan.filter((intent) => intent.market === "US").length, 0);
  assert.ok(plan.every((intent) => intent.queryTerms.length <= 12));
});

test("metric coverage requires both the observed name and matching direction", () => {
  assert.equal(evidenceCoversMetric(completeEvidence, sectorPerformance[0]), true);
  assert.equal(
    evidenceCoversMetric(
      [{
        ...completeEvidence[0],
        title: "A股收评：原材料板块领跌",
        facts: "原材料板块下跌并领跌两市。",
      }],
      sectorPerformance[0],
    ),
    false,
  );
});

test("active search parser keeps HTTPS in-session publisher results only", () => {
  const intents = buildActiveRetrievalPlan({
    evidence: [],
    marketSessions: sessions,
    sectorPerformance,
    aiChainPerformance,
  }).filter((intent) => intent.market === "US");
  const parsed = parseActiveSearchResults(
    JSON.stringify({
      articles: [
        {
          title: "S&P 500 and Nasdaq end down as technology stocks slide",
          url: "https://www.reuters.com/markets/us/example",
          seendate: "20260824T212601Z",
        },
        {
          title: "Old market story outside the completed session",
          url: "https://example.com/old",
          seendate: "20260820T212601Z",
        },
        {
          title: "Insecure result",
          url: "http://example.com/insecure",
          seendate: "20260824T212601Z",
        },
      ],
    }),
    intents,
    Date.parse("2026-08-25T01:00:00.000Z"),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]._tier, "publisher");
  assert.ok(relevanceScore({ ...parsed[0], facts: "Technology stocks fell as the Nasdaq and S&P 500 closed lower after chip shares dropped." }) >= 8);
});

test("active evidence publication time is derived from publisher metadata", () => {
  assert.equal(
    extractArticlePublishedAt(`
      <html><head>
        <script type="application/ld+json">
          {"@type":"NewsArticle","datePublished":"2026-08-24T16:26:01-04:00"}
        </script>
      </head></html>
    `),
    "2026-08-24T20:26:01.000Z",
  );
  assert.equal(extractArticlePublishedAt("<html><head></head></html>"), "");
});

test("a verified local wrap is retained when generic ranking fills the market cap", () => {
  const ranked = Array.from({ length: 2 }, (_, index) => ({
    title: `Federal Reserve policy update ${index}`,
    facts: "The Federal Reserve published a policy update with verified details about rates and financial conditions.",
    url: `https://example.com/policy-${index}`,
    source: "Fixture",
    publishedAt: `2026-08-24T19:0${index}:00.000Z`,
    regions: ["US"],
    kind: "event",
  }));
  const wrap = completeEvidence.find((item) => item.regions.includes("US"));
  const anchored = includeLocalWrapAnchors(
    ranked,
    [...ranked, wrap],
    sectorPerformance,
    2,
  );
  assert.equal(anchored.length, 2);
  assert.ok(anchored.some((item) => item.url === wrap.url));
});

test("provider failure degrades into diagnostics without throwing", async () => {
  const intents = buildActiveRetrievalPlan({
    evidence: [],
    marketSessions: sessions,
    sectorPerformance,
    aiChainPerformance,
  }).filter((intent) => intent.market === "CN");
  const result = await retrieveActiveAttribution(
    intents,
    Date.parse("2026-08-25T01:00:00.000Z"),
    {
      fetcher: async () => {
        throw new Error("HTTP 429");
      },
      wait: async () => {},
    },
  );
  assert.equal(result.candidates.length, 0);
  assert.equal(result.searches[0].status, "error");
});

test("coverage distinguishes completed inconclusive search from missing wrap", () => {
  const initialPlan = [{
    id: "US:sector-extremes",
    market: "US",
    kind: "sector_extremes",
    queryTerms: ["Nasdaq", "NVIDIA"],
    windowStart: sessions[1].windowStart,
    windowEnd: sessions[1].windowEnd,
  }];
  const adequate = assessAttributionCoverage({
    evidence: completeEvidence,
    initialPlan,
    searches: [{ market: "US", status: "ok", intentIds: [initialPlan[0].id], resultCount: 0 }],
    marketSessions: sessions,
    sectorPerformance,
    aiChainPerformance,
  });
  assert.equal(adequate.US.status, "adequate");

  const insufficient = assessAttributionCoverage({
    evidence: completeEvidence.filter((item) => item.regions.includes("US")),
    initialPlan: buildActiveRetrievalPlan({
      evidence: [], marketSessions: sessions, sectorPerformance, aiChainPerformance,
    }),
    searches: [{ market: "CN", status: "error", intentIds: [], resultCount: 0 }],
    marketSessions: sessions,
    sectorPerformance,
    aiChainPerformance,
  });
  assert.equal(insufficient.CN.status, "insufficient");
  assert.ok(insufficient.CN.missingIntentKinds.includes("market_wrap"));
});
