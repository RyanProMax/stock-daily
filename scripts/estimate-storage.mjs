import { readFile } from "node:fs/promises";

const reports = JSON.parse(
  await readFile(new URL("../data/reports.json", import.meta.url), "utf8"),
);

const rowBytes = reports.map((report) => {
  const content = JSON.stringify({
    overview: report.overview,
    marketViews: report.marketViews,
    updateKind: report.updateKind,
    marketAsOf: report.marketAsOf,
    markets: report.markets,
    sectorHeat: report.sectorHeat,
    stories: report.stories,
    translations: report.translations,
    isSample: report.isSample,
  });
  return Buffer.byteLength(
    [
      report.reportDate,
      String(report.edition),
      report.headline,
      report.summary,
      report.generatedAt,
      report.dataCut,
      report.agentModel,
      content,
    ].join(""),
  );
});

const averageReportBytes =
  rowBytes.reduce((total, bytes) => total + bytes, 0) / rowBytes.length;
const plannedDailyBytes = Math.max(averageReportBytes, 20 * 1024);
const plannedWeeklyBytes = 12 * 1024;
const annualDailyBytes = plannedDailyBytes * 365;
const annualWeeklyBytes = plannedWeeklyBytes * 52;
const annualPayloadBytes = annualDailyBytes + annualWeeklyBytes;
const annualAuditBytes = 512 * 365 * 3;
const conservativeSqliteBytes = (annualPayloadBytes + annualAuditBytes) * 3;
const mib = (bytes) => bytes / 1024 / 1024;

console.log(
  JSON.stringify(
    {
      sampleReports: reports.length,
      averageReportKiB: Number((averageReportBytes / 1024).toFixed(2)),
      plannedDailyKiB: Number((plannedDailyBytes / 1024).toFixed(2)),
      plannedWeeklyKiB: Number((plannedWeeklyBytes / 1024).toFixed(2)),
      annualDailyMiB: Number(mib(annualDailyBytes).toFixed(2)),
      annualWeeklyMiB: Number(mib(annualWeeklyBytes).toFixed(2)),
      annualPayloadMiB: Number(mib(annualPayloadBytes).toFixed(2)),
      annualAuditMiB: Number(mib(annualAuditBytes).toFixed(2)),
      conservativeAnnualD1MiB: Number(mib(conservativeSqliteBytes).toFixed(2)),
      assumption:
        "每日同一行由早盘、收盘和晚间三次覆盖 + 每周 1 份双语周报 + 每日最多 3 条运行审计；SQLite 页、索引和增长余量按原始数据的 3 倍计。",
    },
    null,
    2,
  ),
);
