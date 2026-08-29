import assert from "node:assert/strict";
import test from "node:test";
import { auditCodexRun } from "../scripts/daily-agent-audit.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

const queries = [
  "A股 收盘 复盘",
  "A股 原材料 供应 原因",
  "A股 CPO 光互连 订单 公告",
  "A股 AI 机器人 原因 业绩",
  "US stocks close market wrap",
  "US stocks materials business activity reason",
  "US stocks artificial intelligence chips filing reason",
  "US stocks artificial intelligence cloud earnings catalyst",
];

function eventsFor(searchQueries = queries) {
  return [
    ...searchQueries.map((query, index) =>
      JSON.stringify({
        type: "item.completed",
        item: { id: `search-${index}`, type: "web_search", query },
      }),
    ),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
}

test("Codex run audit proves native search covered both markets", () => {
  const report = fixtureReport(fixtureInput());
  const result = auditCodexRun(eventsFor(), report);
  assert.equal(result.status, "audited");
  assert.equal(result.queryCount, 8);
  assert.deepEqual(result.coverage, { CN: 4, US: 4 });
});

test("declared source review count cannot be smaller than cited sources", () => {
  const report = fixtureReport(fixtureInput());
  const extraEvidence = structuredClone(report.drivers[0].evidence[1]);
  extraEvidence.source = "https://news.example.com/second-cn-source";
  report.drivers[0].evidence.push(extraEvidence);
  report.researchAudit.CN.sourcesReviewed = 1;
  assert.throws(
    () => auditCodexRun(eventsFor(), report),
    /查看来源数量少于报告实际引用数量/,
  );
});

test("Codex run audit rejects missing completion and failed turns", () => {
  const report = fixtureReport(fixtureInput());
  assert.throws(
    () =>
      auditCodexRun(
        eventsFor().replace(/\{"type":"turn.completed"[^\n]+/u, ""),
        report,
      ),
    /没有完成事件/,
  );
  assert.throws(
    () =>
      auditCodexRun(
        `${eventsFor()}\n${JSON.stringify({ type: "turn.failed" })}`,
        report,
      ),
    /包含失败事件/,
  );
});

test("Codex run audit rejects malformed JSONL records", () => {
  const report = fixtureReport(fixtureInput());
  assert.throws(
    () => auditCodexRun(`${eventsFor()}\nnot-json`, report),
    /无法解析的记录/,
  );
});

test("Codex run audit requires four actual searches for each market", () => {
  const report = fixtureReport(fixtureInput());
  assert.throws(
    () => auditCodexRun(eventsFor(queries.slice(0, 7)), report),
    /足够的原生网页搜索|至少四条 CN 与 US 查询/,
  );
});

test("Codex run audit rejects fabricated research query declarations", () => {
  const report = fixtureReport(fixtureInput());
  report.researchAudit.CN.queries[2] = "A股 从未执行的查询";
  assert.throws(
    () => auditCodexRun(eventsFor(), report),
    /声明了未实际执行的查询/,
  );
});

test("Codex run audit does not count ambiguous CN queries as US research", () => {
  const ambiguousQueries = [
    "A股 Nvidia 收盘",
    "A股 Micron 行业",
    "A股 AI Broadcom 原因",
    "A股 AI Seagate 公告",
    "A股 Nvidia 复盘",
    "A股 Micron 原因",
    "A股 AI Palantir 原因",
    "A股 AI CoreWeave 公告",
  ];
  const report = fixtureReport(fixtureInput());
  report.researchAudit.CN.queries = ambiguousQueries.slice(0, 4);
  report.researchAudit.US.queries = ambiguousQueries.slice(4);
  assert.throws(
    () => auditCodexRun(eventsFor(ambiguousQueries), report),
    /至少四条 CN 与 US 查询/,
  );
});

test("declared research queries must carry the declared market marker", () => {
  const report = fixtureReport(fixtureInput());
  report.researchAudit.US.queries[0] = "A股 收盘 复盘";
  assert.throws(
    () => auditCodexRun(eventsFor(), report),
    /US 研究审计查询缺少唯一、明确的市场标记/,
  );
});

test("declared research permits unclassified source follow-ups after market coverage", () => {
  const sourceFollowUp = '"market wrap" publication time';
  const report = fixtureReport(fixtureInput());
  report.researchAudit.US.queries.push(sourceFollowUp);
  const result = auditCodexRun(eventsFor([...queries, sourceFollowUp]), report);
  assert.equal(result.status, "audited");
  assert.equal(result.coverage.US, 4);
});

test("Codex run audit requires active AI cause searches for both markets", () => {
  const report = fixtureReport(fixtureInput());
  const passiveQueries = queries.map((query) =>
    query.includes("AI") || query.includes("artificial intelligence")
      ? query.replace(
          /原因|催化|公告|财报|订单|供需|政策|业绩|why|reason|catalyst|filing|earnings|order|demand|supply|policy/giu,
          "走势",
        )
      : query,
  );
  report.researchAudit.CN.queries = passiveQueries.slice(0, 4);
  report.researchAudit.US.queries = passiveQueries.slice(4);
  assert.throws(
    () => auditCodexRun(eventsFor(passiveQueries), report),
    /AI 对象与原因线索的主动归因查询/,
  );
});

test("AI cause searches may name tracked companies from the current input", () => {
  const input = fixtureInput();
  const cloud = input.aiChainPerformance.find(
    (item) => item.market === "US" && item.layer === "cloud",
  );
  const interconnect = input.aiChainPerformance.find(
    (item) => item.market === "US" && item.layer === "interconnect",
  );
  Object.assign(cloud.constituents[0], {
    symbol: "CRWV",
    name: "CoreWeave",
    nameEn: "CoreWeave",
  });
  Object.assign(interconnect.constituents[0], {
    symbol: "ANET",
    name: "Arista Networks",
    nameEn: "Arista Networks",
  });
  const companyQueries = [
    ...queries.slice(0, 6),
    "US stocks Arista Networks orders reason",
    "US stocks CoreWeave earnings catalyst",
  ];
  const report = fixtureReport(input);
  report.researchAudit.US.queries = companyQueries.slice(4);
  const result = auditCodexRun(eventsFor(companyQueries), report, input);
  assert.equal(result.status, "audited");
});
