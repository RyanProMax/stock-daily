import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKETS = ["CN", "US"];
const SCORE_KEYS = [
  "factualAccuracy",
  "causalLogic",
  "evidenceDirectness",
  "alternativeTesting",
  "readerUtility",
];
const CHECK_KEYS = [
  "noUnsupportedClaims",
  "explainsRatherThanRestates",
  "allSourcesTraceable",
  "alternativesTested",
  "emptyAttributionHonest",
];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

function text(value, label, minLength = 1) {
  if (typeof value !== "string" || [...value.trim()].length < minLength) {
    throw new Error(`${label} 缺失`);
  }
  return value.trim();
}

function textArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
  return value.map((item) => item.trim());
}

function normalizedUrl(value, label) {
  const raw = text(value, label, 12);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} 必须是 HTTPS URL`);
  }
}

function assertClaimReviews(review, report) {
  const claims = Array.isArray(review.claimReviews) ? review.claimReviews : [];
  const expected = [
    ...report.drivers.map((item) => ({
      market: item.market,
      publishedAs: "market_driver",
      publishedTitle: item.title,
      publishedClaim: item.mechanism,
      requiredScope: item.attributionScope,
      sources: new Set(
        item.evidence
          .filter((evidence) => evidence.kind !== "market_data")
          .map((evidence) => normalizedUrl(evidence.source, "report evidence source")),
      ),
    })),
    ...report.aiChainUpdates.map((item) => ({
      market: item.market,
      publishedAs: "ai_update",
      publishedTitle: item.title,
      publishedClaim: item.implication,
      requiredScope: null,
      sources: new Set(
        item.evidence
          .filter((evidence) => evidence.kind !== "market_data")
          .map((evidence) => normalizedUrl(evidence.source, "report evidence source")),
      ),
    })),
  ];
  if (claims.length !== expected.length) {
    throw new Error(`独立复盘逐条归因数量不一致：expected=${expected.length}, actual=${claims.length}`);
  }
  const seen = new Set();
  for (const [index, rawClaim] of claims.entries()) {
    const claim = object(rawClaim, `daily-review.claimReviews[${index}]`);
    const key = `${claim.market}|${claim.publishedAs}|${claim.publishedTitle}`;
    const match = expected.find(
      (item) =>
        item.market === claim.market &&
        item.publishedAs === claim.publishedAs &&
        item.publishedTitle === claim.publishedTitle,
    );
    if (!match || seen.has(key)) {
      throw new Error(`独立复盘逐条归因映射无效或重复：${key}`);
    }
    seen.add(key);
    const source = normalizedUrl(
      claim.source,
      `daily-review.claimReviews[${index}].source`,
    );
    text(
      claim.publishedClaim,
      `daily-review.claimReviews[${index}].publishedClaim`,
      100,
    );
    text(claim.summary, `daily-review.claimReviews[${index}].summary`, 20);
    if (
      claim.publishedClaim !== match.publishedClaim ||
      !match.sources.has(source) ||
      claim.verdict !== "pass" ||
      ![
        "market",
        "sector",
        "subsector",
        "ai_layer",
        "company",
      ].includes(claim.supportedScope) ||
      (match.requiredScope && claim.supportedScope !== match.requiredScope)
    ) {
      throw new Error(`独立复盘逐条归因未通过：${key}`);
    }
  }
}

export function assertReviewPassed(value, report) {
  const review = object(value, "daily-review");
  const checkedReport = object(report, "daily-report");
  if (review.contractVersion !== "stock-daily-recap-review-v1") {
    throw new Error("独立复盘契约版本无效");
  }
  text(review.summary, "daily-review.summary", 20);
  const qualityChecks = object(review.qualityChecks, "daily-review.qualityChecks");
  const failedChecks = CHECK_KEYS.filter((key) => qualityChecks[key] !== true);
  const marketReviews = object(review.marketReviews, "daily-review.marketReviews");
  const failures = [];
  for (const market of MARKETS) {
    const item = object(marketReviews[market], `daily-review.marketReviews.${market}`);
    text(item.summary, `daily-review.marketReviews.${market}.summary`, 20);
    const scores = object(item.scores, `daily-review.marketReviews.${market}.scores`);
    const lowScores = SCORE_KEYS.filter(
      (key) => !Number.isInteger(scores[key]) || scores[key] < 4 || scores[key] > 5,
    );
    const issues = textArray(item.issues, `daily-review.marketReviews.${market}.issues`);
    const actions = textArray(
      item.revisionActions,
      `daily-review.marketReviews.${market}.revisionActions`,
    );
    if (item.verdict !== "pass" || lowScores.length > 0 || issues.length > 0 || actions.length > 0) {
      failures.push(
        `${market}: ${item.summary}; low=${lowScores.join(",") || "none"}; issues=${issues.join(" | ") || "none"}; actions=${actions.join(" | ") || "none"}`,
      );
    }
  }
  if (review.verdict !== "pass" || failedChecks.length > 0 || failures.length > 0) {
    throw new Error(
      `独立复盘未通过：checks=${failedChecks.join(",") || "none"}; ${failures.join("; ") || review.summary}`,
    );
  }
  assertClaimReviews(review, checkedReport);
  return {
    status: "passed",
    scores: Object.fromEntries(
      MARKETS.map((market) => [market, marketReviews[market].scores]),
    ),
  };
}

async function main() {
  const reviewPath = resolve(process.argv[2] ?? "work/daily-review.json");
  const reportPath = resolve(process.argv[3] ?? "work/daily-report.json");
  const [review, report] = await Promise.all([
    readFile(reviewPath, "utf8").then(JSON.parse),
    readFile(reportPath, "utf8").then(JSON.parse),
  ]);
  console.log(JSON.stringify(assertReviewPassed(review, report), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
