import assert from "node:assert/strict";
import test from "node:test";
import { auditIndependentReview } from "../scripts/daily-review-audit.mjs";
import { assertReviewPassed } from "../scripts/daily-review-check.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

function passingReview(report = fixtureReport(fixtureInput())) {
  const marketReview = {
    verdict: "pass",
    scores: {
      factualAccuracy: 5,
      causalLogic: 4,
      evidenceDirectness: 5,
      alternativeTesting: 4,
      readerUtility: 4,
    },
    summary: "引用来源、因果范围和替代解释均已核对，报告提供了行情之外的原因信息。",
    issues: [],
    revisionActions: [],
  };
  return {
    contractVersion: "stock-daily-recap-review-v1",
    verdict: "pass",
    summary: "两个市场的候选原因、引用来源和读者结论均通过独立复盘。",
    reviewAudit: {
      CN: { queries: ["A股 原材料 公用事业 当日异动 复盘 原因"] },
      US: { queries: ["U.S. stocks materials technology session drivers review"] },
    },
    claimReviews: [
      ...report.drivers.map((item) => ({
        market: item.market,
        publishedAs: "market_driver",
        publishedTitle: item.title,
        publishedClaim: item.mechanism,
        source: item.evidence.find((evidence) => evidence.kind !== "market_data").source,
        supportedScope: "sector",
        verdict: "pass",
        summary: "The opened source directly supports the stated sector-level causal mechanism and no broader scope was claimed.",
      })),
      ...report.aiChainUpdates.map((item) => ({
        market: item.market,
        publishedAs: "ai_update",
        publishedTitle: item.title,
        publishedClaim: item.implication,
        source: item.evidence.find((evidence) => evidence.kind !== "market_data").source,
        supportedScope: "ai_layer",
        verdict: "pass",
        summary: "The opened source supports the named AI-layer mechanism without extending it to unrelated layers.",
      })),
    ],
    qualityChecks: {
      noUnsupportedClaims: true,
      explainsRatherThanRestates: true,
      allSourcesTraceable: true,
      alternativesTested: true,
      emptyAttributionHonest: true,
    },
    marketReviews: {
      CN: structuredClone(marketReview),
      US: structuredClone(marketReview),
    },
  };
}

function reviewerEvents(report, review) {
  const searchEvents = ["CN", "US"].flatMap((market) =>
    review.reviewAudit[market].queries.map((query, index) => ({
      type: "item.completed",
      item: {
        id: `review-${market}-${index}`,
        type: "web_search",
        query,
        action: { type: "search", queries: [query] },
      },
    })),
  );
  const sourceEvents = [
    ...new Set(
      [...report.drivers, ...report.aiChainUpdates]
        .flatMap((item) => item.evidence)
        .filter((evidence) => evidence.kind !== "market_data")
        .map((evidence) => evidence.source),
    ),
  ].map((source, index) => ({
    type: "item.completed",
    item: {
      id: `source-${index}`,
      type: "web_search",
      query: source,
      action: { type: "other" },
    },
  }));
  return [...searchEvents, ...sourceEvents, { type: "turn.completed", usage: {} }]
    .map(JSON.stringify)
    .join("\n");
}

test("independent review passes only after fresh searches and every source open", () => {
  const report = fixtureReport(fixtureInput());
  const review = passingReview(report);
  const audit = auditIndependentReview(reviewerEvents(report, review), review, report);
  assert.equal(audit.status, "audited");
  assert.equal(audit.openedSourceCount, 5);
  assert.equal(assertReviewPassed(review, report).status, "passed");
});

test("independent review rejects a copied researcher query", () => {
  const report = fixtureReport(fixtureInput());
  const review = passingReview(report);
  review.reviewAudit.CN.queries = [report.researchAudit.CN.queries[0]];
  assert.throws(
    () => auditIndependentReview(reviewerEvents(report, review), review, report),
    /不得原样复制研究查询/,
  );
});

test("independent review rejects a cited source that was not opened", () => {
  const report = fixtureReport(fixtureInput());
  const review = passingReview(report);
  const events = reviewerEvents(report, review)
    .split("\n")
    .filter((line) => !line.includes("technology-capex"))
    .join("\n");
  assert.throws(
    () => auditIndependentReview(events, review, report),
    /打开来源数量不足/,
  );
});

test("review score or quality failure prevents publication", () => {
  const report = fixtureReport(fixtureInput());
  const lowScore = passingReview(report);
  lowScore.marketReviews.US.scores.causalLogic = 3;
  assert.throws(() => assertReviewPassed(lowScore, report), /独立复盘未通过/);

  const unsupported = passingReview(report);
  unsupported.qualityChecks.noUnsupportedClaims = false;
  assert.throws(() => assertReviewPassed(unsupported, report), /noUnsupportedClaims/);
});

test("pass verdict cannot hide unresolved issues", () => {
  const report = fixtureReport(fixtureInput());
  const review = passingReview(report);
  review.marketReviews.CN.issues = ["一条来源只支持事件存在，尚未支持其市场影响。"];
  assert.throws(() => assertReviewPassed(review, report), /来源只支持事件存在/);
});

test("aggregate pass cannot hide a failed itemized causal claim", () => {
  const report = fixtureReport(fixtureInput());
  const review = passingReview(report);
  review.claimReviews[0].verdict = "revise";
  review.claimReviews[0].supportedScope = "none";
  assert.throws(
    () => assertReviewPassed(review, report),
    /逐条归因未通过/,
  );
});
