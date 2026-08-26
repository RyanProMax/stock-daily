import assert from "node:assert/strict";
import test from "node:test";
import { auditCodexRun } from "../scripts/daily-agent-audit.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

const queries = [
  "A股 收盘 复盘",
  "A股 原材料 供应 原因",
  "A股 光互连 订单 公告",
  "US stocks close market wrap",
  "US stocks materials business activity reason",
  "US stocks artificial intelligence company filing",
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
  assert.equal(result.queryCount, 6);
  assert.deepEqual(result.coverage, { CN: 3, US: 3 });
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

test("Codex run audit requires three actual searches for each market", () => {
  const report = fixtureReport(fixtureInput());
  assert.throws(
    () => auditCodexRun(eventsFor(queries.slice(0, 5)), report),
    /足够的原生网页搜索|至少三条 CN 与 US 查询/,
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
    "A股 Broadcom 人工智能",
    "A股 Nvidia 复盘",
    "A股 Micron 原因",
    "A股 Seagate 公告",
  ];
  const report = fixtureReport(fixtureInput());
  report.researchAudit.CN.queries = ambiguousQueries.slice(0, 3);
  report.researchAudit.US.queries = ambiguousQueries.slice(3);
  assert.throws(
    () => auditCodexRun(eventsFor(ambiguousQueries), report),
    /至少三条 CN 与 US 查询/,
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
  assert.equal(result.coverage.US, 3);
});
