import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { marketAsOfFromInput } from "./daily-policy.mjs";
import {
  buildReportContent,
  validateInput,
  validateReport,
} from "./daily-publish.mjs";
import { fetchFreshDailySnapshot } from "./daily-readback.mjs";

const inputPath = resolve(process.argv[2] ?? "work/daily-input.json");
const reportPath = resolve(process.argv[3] ?? "work/daily-report.json");
const [inputValue, reportValue] = await Promise.all([
  readFile(inputPath, "utf8").then(JSON.parse),
  readFile(reportPath, "utf8").then(JSON.parse),
]);
const input = validateInput(inputValue);
const expectedReport = validateReport(reportValue, input);
const expectedContent = JSON.parse(buildReportContent(input, expectedReport));
const marketAsOf = marketAsOfFromInput(input);
const { health, report } = await fetchFreshDailySnapshot(input);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function readerFacingMarketNote(note) {
  return String(note ?? "")
    .replace(/\s*·\s*API\s*Skill\b/giu, "")
    .replace(/\s*·\s*market_data_query\b/giu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

expectedContent.markets = expectedContent.markets.map((market) => ({
  ...market,
  note: readerFacingMarketNote(market.note),
}));

const contentFields = [
  "contractVersion",
  "overview",
  "marketViews",
  "aiChainViews",
  "updateKind",
  "marketAsOf",
  "marketSessions",
  "markets",
  "sectorPerformance",
  "aiChainPerformance",
  "sectorHeat",
  "drivers",
  "aiChainUpdates",
  "stories",
  "translations",
  "isSample",
];
const mismatches = contentFields.filter(
  (field) => !same(report?.[field], expectedContent[field]),
);
const expectedDataCut = `CN ${marketAsOf.CN} · US ${marketAsOf.US}`;

if (
  health?.database !== "connected" ||
  health?.latestIngestion?.status !== "completed" ||
  health?.latestIngestion?.reportDate !== input.reportDate ||
  report?.reportDate !== input.reportDate ||
  report?.headline !== expectedReport.headline ||
  report?.summary !== expectedReport.summary ||
  report?.dataCut !== expectedDataCut ||
  report?.agentModel !== "openai/codex-scheduled" ||
  Object.hasOwn(report ?? {}, "researchAudit") ||
  mismatches.length > 0
) {
  throw new Error(
    `线上日报与本次已验证报告不一致${
      mismatches.length ? `：${mismatches.join(", ")}` : ""
    }`,
  );
}

console.log(
  JSON.stringify(
    {
      status: "verified",
      contractVersion: report.contractVersion,
      reportDate: report.reportDate,
      updateKind: report.updateKind,
      marketAsOf: report.marketAsOf,
      marketCount: report.markets.length,
      sectorCount: report.sectorPerformance.length,
      aiLayerCount: report.aiChainPerformance.length,
      driverCount: report.drivers.length,
      aiUpdateCount: report.aiChainUpdates.length,
      driverStatus: Object.fromEntries(
        ["CN", "US"].map((market) => [
          market,
          report.marketViews[market].driverStatus,
        ]),
      ),
      agentModel: report.agentModel,
    },
    null,
    2,
  ),
);
