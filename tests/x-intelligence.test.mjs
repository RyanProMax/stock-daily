import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalDomainAllowed,
  evidenceDescribesSameEvent,
  hydrateNewsEvidence,
  includeCanonicalPairs,
  pairCorroboratingXEvidence,
  xOutboundUrls,
} from "../scripts/news-pipeline.mjs";
import {
  collectXIntelligence,
  X_COLLECTOR_TIMEOUT_MS,
} from "../scripts/x-intelligence.mjs";

const xCandidate = {
  title: "@trendforce：HBM4 demand and pricing rise as customer orders expand",
  facts:
    "TrendForce reports HBM4 demand and pricing will rise 15% as customer orders expand and production capacity remains constrained. https://t.co/example",
  url: "https://x.com/trendforce/status/1234567890",
  source: "TrendForce",
  publishedAt: "2026-08-21T12:00:00.000Z",
  regions: ["CN", "US"],
  platform: "x",
  authority: "specialist",
  authorHandle: "trendforce",
  aiLayers: ["memory"],
  _outboundUrls: ["https://t.co/example"],
  _canonicalDomains: ["trendforce.com"],
  _sourceId: "x:trendforce",
  _tier: "publisher",
};

test("X bridge reserves the bounded cooldown recovery window", () => {
  assert.equal(X_COLLECTOR_TIMEOUT_MS, 110_000);
});

test("wrong system Python reports a configured-interpreter dependency error", async () => {
  const previous = process.env.STOCK_DAILY_X_PYTHON;
  process.env.STOCK_DAILY_X_PYTHON = "/usr/bin/python3";
  try {
    const result = await collectXIntelligence(Date.parse("2026-08-21T22:00:00Z"));
    assert.equal(result.diagnostics.status, "dependency_missing");
    assert.match(result.diagnostics.reason, /configured Python interpreter/u);
  } finally {
    if (previous === undefined) delete process.env.STOCK_DAILY_X_PYTHON;
    else process.env.STOCK_DAILY_X_PYTHON = previous;
  }
});

test("X outbound links are constrained to the verified publisher domain", () => {
  assert.deepEqual(xOutboundUrls(xCandidate), ["https://t.co/example"]);
  assert.equal(
    canonicalDomainAllowed(
      "https://press.trendforce.com/article/123",
      ["trendforce.com"],
    ),
    true,
  );
  assert.equal(
    canonicalDomainAllowed("https://unverified.example/article/123", ["trendforce.com"]),
    false,
  );
});

test("verified X post and canonical article remain paired evidence", async () => {
  const evidence = await hydrateNewsEvidence(xCandidate, async () => ({
    finalUrl: "https://www.trendforce.com/presscenter/news/20260821-1.html",
    body: `<!doctype html><html><head>
      <meta property="og:title" content="HBM4 pricing rises as customer orders expand">
      <meta name="description" content="TrendForce says HBM4 pricing will rise 15% as customer orders expand and production capacity remains constrained.">
    </head><body><main><p>TrendForce says HBM4 pricing will rise 15% as customer orders expand and production capacity remains constrained.</p></main></body></html>`,
  }));
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].platform, "x");
  assert.equal(evidence[1].platform, "web");
  assert.equal(evidence[0]._canonicalUrl, evidence[1].url);
  assert.equal(evidence[1]._xSourceUrl, evidence[0].url);

  const pairedFromX = includeCanonicalPairs([evidence[0]], evidence);
  const pairedFromArticle = includeCanonicalPairs([evidence[1]], evidence);
  assert.deepEqual(pairedFromX.map((item) => item.url), evidence.map((item) => item.url));
  assert.deepEqual(pairedFromArticle.map((item) => item.url), [evidence[1].url, evidence[0].url]);
});

test("an independently discovered canonical article merges with the matching X event", () => {
  const article = {
    title: "Samsung foundry pricing shifts as SF4 capacity tightens",
    facts:
      "TrendForce reports Samsung SF4 is at full capacity and customers accepted foundry price increases of up to 15%.",
    url: "https://www.trendforce.com/news/2026/08/21/samsung-sf4-pricing",
    source: "TrendForce（半导体产业追踪）",
    publishedAt: xCandidate.publishedAt,
    regions: ["US"],
    platform: "web",
  };
  const matchingX = {
    ...xCandidate,
    facts:
      "TrendForce says Samsung SF4 is running at full capacity and customers accepted price increases of as much as 15%.",
  };
  assert.equal(evidenceDescribesSameEvent(matchingX, article), true);
  const paired = pairCorroboratingXEvidence([matchingX, article]);
  assert.equal(paired[0]._canonicalUrl, article.url);
  assert.equal(paired[1]._xSourceUrl, matchingX.url);
});
