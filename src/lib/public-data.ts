import type {
  AiChainUpdate,
  DailyReport,
  DailyReportTranslation,
  MarketDriver,
  WeeklyReport,
} from "../types";

function publicDriver(driver: MarketDriver) {
  const { mechanism: _mechanism, ...readerFields } = driver;
  return readerFields as MarketDriver;
}

function publicAiUpdate(update: AiChainUpdate) {
  const { implication: _implication, ...readerFields } = update;
  return readerFields as AiChainUpdate;
}

function publicTranslation(
  translation: DailyReportTranslation,
): DailyReportTranslation {
  return {
    ...translation,
    aiChainViews: translation.aiChainViews
      ? Object.fromEntries(
          Object.entries(translation.aiChainViews).map(([market, view]) => {
            if (!view) return [market, view];
            const { mechanism: _mechanism, ...readerFields } = view;
            return [market, readerFields];
          }),
        ) as DailyReportTranslation["aiChainViews"]
      : undefined,
    drivers: translation.drivers?.map((driver) => {
      const { mechanism: _mechanism, ...readerFields } = driver;
      return readerFields as NonNullable<
        DailyReportTranslation["drivers"]
      >[number];
    }),
    aiChainUpdates: translation.aiChainUpdates?.map((update) => {
      const { implication: _implication, ...readerFields } = update;
      return readerFields as NonNullable<
        DailyReportTranslation["aiChainUpdates"]
      >[number];
    }),
  };
}

export function publicDailyReport(report: DailyReport): DailyReport {
  const reportWithAudit = report as DailyReport & { researchAudit?: unknown };
  const {
    agentModel: _agentModel,
    contractVersion: _contractVersion,
    researchAudit: _researchAudit,
    ...readerFields
  } = reportWithAudit;

  return {
    ...readerFields,
    aiChainViews: report.aiChainViews
      ? Object.fromEntries(
          Object.entries(report.aiChainViews).map(([market, view]) => {
            if (!view) return [market, view];
            const { mechanism: _mechanism, ...publicView } = view;
            return [market, publicView];
          }),
        ) as DailyReport["aiChainViews"]
      : undefined,
    drivers: report.drivers?.map(publicDriver),
    aiChainUpdates: report.aiChainUpdates?.map(publicAiUpdate),
    translations: report.translations?.en
      ? { ...report.translations, en: publicTranslation(report.translations.en) }
      : report.translations,
  } as DailyReport;
}

export function publicWeeklyReport(report: WeeklyReport): WeeklyReport {
  const { agentModel: _agentModel, ...readerFields } = report;
  return readerFields as WeeklyReport;
}
