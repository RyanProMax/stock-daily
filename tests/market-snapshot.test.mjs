import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 24679 } },
  });
});

after(async () => {
  await vite?.close();
});

const evidence = {
  title: "收盘归因：原材料走强",
  facts: "收盘报道将原材料上涨与同交易时段的供给变化联系起来，并列出对应行业表现。",
  source: "https://example.com/market-wrap",
  sourceLabel: "市场收评",
  publishedAt: "2026-08-21T20:20:00.000Z",
  kind: "market_wrap",
};

const xEvidence = {
  title: "行业研究机构更新供给判断",
  facts: "研究机构确认同交易时段的供给变化，并给出对应产品与行业范围。",
  source: "https://x.com/example/status/123",
  sourceLabel: "行业研究机构",
  publishedAt: "2026-08-21T18:05:00.000Z",
  kind: "event",
  platform: "x",
  authorHandle: "example_research",
  authority: "specialist",
};

function constituents(prefix) {
  return Array.from({ length: 4 }, (_, index) => ({
    symbol: `${prefix}-${index}`,
    name: `标的${index + 1}`,
    nameEn: `Stock ${index + 1}`,
    value: `${100 + index}.00`,
    change: index % 2 === 0 ? "+1.00%" : "-0.50%",
    direction: index % 2 === 0 ? "up" : "down",
    asOf: "2026-08-21",
    source: `https://example.com/${prefix}/${index}`,
  }));
}

function props(aiUpdates = []) {
  return {
    markets: [
      {
        name: "标普 500",
        value: "6,500.00",
        change: "+0.50%",
        direction: "up",
        source: "https://example.com/spx",
      },
    ],
    sectorView: { current: [], streaks: [], threshold: 1.5 },
    sectorPerformance: Array.from({ length: 11 }, (_, index) => ({
      market: "US",
      symbol: `SECTOR-${index}`,
      name: `行业${index + 1}`,
      nameEn: `Sector ${index + 1}`,
      score: 1,
      change: "+1.00%",
      direction: "up",
      asOf: "2026-08-21",
      source: `https://example.com/sector/${index}`,
      constituents: constituents(`sector-${index}`),
    })),
    aiChainPerformance: Array.from({ length: 8 }, (_, index) => ({
      market: "US",
      layer: ["chips", "memory", "servers", "interconnect", "data_center", "cloud", "applications", "robotics"][index],
      name: `AI层${index + 1}`,
      nameEn: `AI layer ${index + 1}`,
      benchmark: "4只代表标的等权篮子",
      benchmarkEn: "Equal-weight basket of four stocks",
      benchmarkKind: "equal_weight_basket",
      symbol: `AI-${index}`,
      change: "+1.00%",
      direction: "up",
      asOf: "2026-08-21",
      source: `https://example.com/ai/${index}`,
      constituents: constituents(`ai-${index}`),
    })),
    drivers: [
      {
        id: "driver-1",
        market: "US",
        role: "primary",
        direction: "positive",
        title: "原材料供给变化支撑市场",
        summary: "供给变化支撑原材料并影响大盘。",
        mechanism: "供给收紧抬升原材料价格，并传导到行业表现。",
        sectorSymbols: ["SECTOR-0"],
        evidence: [evidence, xEvidence],
      },
    ],
    aiUpdates,
    market: "US",
    language: "zh",
    labels: {
      indices: "大盘指数",
      sectors: "行业板块",
      range: "11 类全覆盖",
      aiChain: "AI 产业链",
      aiRange: "8 层口径",
      streakDays: "连续 {count} 个交易日",
      highRelevance: "高相关",
      verifiedFact: "核心事实",
      marketTransmission: "影响路径",
      chainImpact: "产业链影响",
      sourceArticles: "核验文章",
      sourceOfficial: "官方",
      sourceSpecialist: "专业研究",
      sourceExpert: "行业专家",
    },
  };
}

test("market snapshot binds each evidence summary to its source and hides empty analysis", async () => {
  const { default: MarketSnapshot } = await vite.ssrLoadModule(
    "/src/components/MarketSnapshot.tsx",
  );
  const html = renderToStaticMarkup(React.createElement(MarketSnapshot, props()));
  const document = new JSDOM(html).window.document;

  assert.equal(document.querySelectorAll(".snapshot-evidence-list").length, 2);
  assert.equal(document.querySelectorAll(".snapshot-group-ai .snapshot-evidence-list").length, 0);
  assert.equal(document.querySelectorAll(".snapshot-evidence-high").length, 2);
  for (const item of document.querySelectorAll(".snapshot-evidence-list > li")) {
    assert.match(item.textContent, /原材料供给变化支撑市场/);
    assert.match(item.textContent, /核心事实/);
    assert.match(item.textContent, /影响路径/);
    assert.match(item.textContent, /供给变化支撑原材料并影响大盘/);
    assert.match(item.textContent, /供给收紧抬升原材料价格/);
    assert.match(item.textContent, /市场收评/);
    assert.match(item.textContent, /X · @example_research/);
    assert.match(item.textContent, /专业研究/);
    assert.equal(item.querySelectorAll(".snapshot-evidence-details > div").length, 2);
    assert.equal(item.querySelectorAll(".snapshot-evidence-articles > li").length, 2);
    assert.ok(item.querySelector('a[href="https://example.com/market-wrap"]'));
    assert.ok(item.querySelector('a[href="https://x.com/example/status/123"]'));
    assert.equal(item.querySelectorAll("time[datetime]").length, 2);
  }
  assert.doesNotMatch(html, /综合研判|未发现单一消息主导|表现居前|表现居后/);
  assert.equal(document.querySelectorAll(".snapshot-analysis").length, 0);
});

test("AI evidence renders as an article-summary-source list", async () => {
  const { default: MarketSnapshot } = await vite.ssrLoadModule(
    "/src/components/MarketSnapshot.tsx",
  );
  const aiUpdates = [
    {
      id: "ai-update-1",
      market: "US",
      layer: "interconnect",
      title: "光互连订单与技术路线得到验证",
      summary: "企业订单和行业研究共同指向光互连需求。",
      implication: "带宽需求支撑光互连链条。",
      evidence: [{ ...evidence, source: "https://example.com/ai-evidence" }],
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(MarketSnapshot, props(aiUpdates)),
  );
  const document = new JSDOM(html).window.document;
  const item = document.querySelector(
    ".snapshot-group-ai .snapshot-evidence-list > li",
  );

  assert.ok(item);
  assert.match(item.textContent, /光互连订单与技术路线得到验证/);
  assert.match(item.textContent, /核心事实/);
  assert.match(item.textContent, /企业订单和行业研究共同指向光互连需求/);
  assert.match(item.textContent, /产业链影响/);
  assert.match(item.textContent, /带宽需求支撑光互连链条/);
  assert.match(item.textContent, /市场收评/);
  assert.equal(item.querySelectorAll(".snapshot-evidence-details > div").length, 2);
  assert.equal(item.querySelectorAll(".snapshot-evidence-articles > li").length, 1);
  assert.ok(item.querySelector('a[href="https://example.com/ai-evidence"]'));
});
