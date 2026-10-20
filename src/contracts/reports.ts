import { Validator, type Schema } from "@cfworker/json-schema";
import common from "../../docs/report-contracts/common-v1.schema.json";
import daily from "../../docs/report-contracts/daily-v1.schema.json";
import weekly from "../../docs/report-contracts/weekly-v1.schema.json";
import type { DailyReportPayload, WeeklyReportPayload } from "../report-contracts.generated";
import type { DailyReport, WeeklyReport } from "../types";

export type ReportKind = "daily" | "weekly";
export type ReportPayload = DailyReportPayload | WeeklyReportPayload;
const validators = Object.fromEntries(Object.entries({ daily, weekly }).map(([kind, schema]) => {
  const validator = new Validator(schema as Schema, "2020-12");
  validator.addSchema(common as Schema);
  return [kind, validator];
})) as Record<ReportKind, Validator>;

export class ReportValidationError extends Error {}
export function isReportDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new ReportValidationError(message);
}
function aligned(left: unknown[], right: unknown[], label: string) {
  requireCondition(left.length === right.length, `${label}: translation count must match`);
}
function unique(values: string[], label: string) {
  requireCondition(new Set(values).size === values.length, `${label}: duplicate identifiers`);
}
function checkSourceTimes(value: unknown, cutoffAt: string, generatedAt: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "publishedAt" && typeof item === "string" && item.includes("T")) {
      requireCondition(Date.parse(item) <= Date.parse(cutoffAt), "Source is later than cutoffAt");
    }
    if ((key === "verifiedAt" || key === "resultVerifiedAt") && typeof item === "string") {
      requireCondition(Date.parse(item) <= Date.parse(generatedAt), "Verification is later than generatedAt");
    }
    checkSourceTimes(item, cutoffAt, generatedAt);
  }
}
export function validateReportPayload(kind: "daily", value: unknown): DailyReportPayload;
export function validateReportPayload(kind: "weekly", value: unknown): WeeklyReportPayload;
export function validateReportPayload(kind: ReportKind, value: unknown): ReportPayload;
export function validateReportPayload(kind: ReportKind, value: unknown): ReportPayload {
  const result = validators[kind].validate(value);
  if (!result.valid) {
    const error = result.errors[0];
    throw new ReportValidationError(`${error.instanceLocation || "/"}: ${error.keyword}`);
  }
  const report = value as ReportPayload;
  requireCondition(Date.parse(report.cutoffAt) <= Date.parse(report.generatedAt), "cutoffAt exceeds generatedAt");
  checkSourceTimes(report, report.cutoffAt, report.generatedAt);
  if (report.schemaVersion === "daily-v1") {
    requireCondition(isReportDate(report.reportDate), "Invalid reportDate");
    for (const market of ["CN", "US"] as const) {
      requireCondition(report.marketAsOf[market] <= report.reportDate, "Market date exceeds reportDate");
      const metrics = report.markets.filter((item) => item.region === market);
      requireCondition(metrics.length > 0, `${market}: missing market metrics`);
      for (const item of [...metrics, ...report.sectorHeat.filter((item) => item.market === market),
        ...report.sectorPerformance.filter((item) => item.market === market),
        ...report.aiChainPerformance.filter((item) => item.market === market)]) {
        requireCondition(item.asOf === report.marketAsOf[market], `${market}: metric date mismatch`);
        if ("constituents" in item) for (const child of item.constituents ?? []) {
          requireCondition(child.asOf === item.asOf, `${market}: constituent date mismatch`);
        }
      }
      const ids = report.drivers.filter((item) => item.market === market).map((item) => item.id);
      requireCondition(report.marketViews[market].driverIds.every((id) => ids.includes(id)), "Unknown market driver reference");
      const aiIds = report.aiChainUpdates.filter((item) => item.market === market).map((item) => item.id);
      requireCondition(report.aiChainViews[market].driverIds.every((id) => aiIds.includes(id)), "Unknown AI driver reference");
      const recap = report.recaps?.[market];
      if (recap) {
        requireCondition(recap.market === market && recap.marketAsOf === report.marketAsOf[market], "Recap market/date mismatch");
        unique(recap.entries.map((item) => item.target), "recap targets");
      }
    }
    unique(report.drivers.map((item) => item.id), "drivers");
    unique(report.aiChainUpdates.map((item) => item.id), "AI updates");
    unique(report.stories.map((item) => item.id), "stories");
    for (const field of ["drivers", "aiChainUpdates", "stories"] as const) {
      aligned(report[field], report.translations.en[field], field);
    }
  } else {
    requireCondition(isReportDate(report.weekStart) && isReportDate(report.weekEnd), "Invalid week date");
    requireCondition(Date.parse(report.weekEnd) - Date.parse(report.weekStart) === 6 * 86400000, "Week must cover seven days");
    unique(report.events.map((event) => event.id), "events");
    aligned(report.events, report.translations.en.events, "events");
    aligned(report.highlights, report.translations.en.highlights, "highlights");
    report.events.forEach((event, index) => {
      if (event.status === "realized") requireCondition(report.translations.en.events[index].result, "Realized event needs English result");
    });
  }
  return report;
}

// Compile-time checked bridges: new report content is not passed through legacy
// research heuristics. The existing components consume the same display fields.
export function dailyReportView(payload: DailyReportPayload, edition: number): DailyReport {
  return { ...payload, edition, dataCut: `CN ${payload.marketAsOf.CN} · US ${payload.marketAsOf.US}`,
    contractVersion: "external-report-v1", agentModel: "external-agent", isSample: false };
}
export function weeklyReportView(payload: WeeklyReportPayload): WeeklyReport {
  return { ...payload, agentModel: "external-agent" };
}
