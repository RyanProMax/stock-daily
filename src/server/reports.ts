import fallbackReportsJson from "../../data/reports.json";
import storyInsightsJson from "../../data/story-insights.json";
import type {
  DailyReport,
  DailyMarketView,
  ImpactTone,
  MarketMetric,
  MarketOverview,
  MarketRegion,
  MarketTrend,
  ReportListItem,
  SectorHeatDay,
  SectorHeatMetric,
  SectorHeatStreak,
  SectorHeatView,
  StoryInsight,
  WeeklyListItem,
  WeeklyReport,
} from "../types";

interface DailyRow {
  reportDate: string;
  edition: number;
  headline: string;
  summary: string;
  generatedAt: string;
  dataCut: string;
  agentModel: string;
  content: string;
}

interface WeeklyRow {
  weekStart: string;
  weekEnd: string;
  headline: string;
  summary: string;
  generatedAt: string;
  agentModel: string;
  content: string;
}

interface HeatRow {
  reportDate: string;
  sectorHeat: string | null;
}

interface DailyArchiveRow extends Omit<ReportListItem, "marketViews"> {
  cnSignalCount: number | null;
  usSignalCount: number | null;
  cnTitle: string | null;
  cnSummary: string | null;
  cnTitleEn: string | null;
  cnSummaryEn: string | null;
  usTitle: string | null;
  usSummary: string | null;
  usTitleEn: string | null;
  usSummaryEn: string | null;
  cnTone: ImpactTone | null;
  usTone: ImpactTone | null;
  marketsJson: string | null;
}

const fallbackReports = [...(fallbackReportsJson as DailyReport[])].sort((a, b) =>
  b.reportDate.localeCompare(a.reportDate),
);
const legacyInsights = storyInsightsJson as Record<string, StoryInsight>;
const heatThreshold = 70;
const primaryIndexSymbols: Record<MarketRegion, Set<string>> = {
  CN: new Set(["SSE", "CSI300"]),
  US: new Set(["SPX", "IXIC", "DJI"]),
};
type StoredDailyReport = Omit<DailyReport, "marketViews"> & {
  marketViews?: DailyReport["marketViews"];
};

function summarizeMarketTrend(
  markets: MarketMetric[],
  region: MarketRegion,
): MarketTrend | undefined {
  const directions = markets
    .filter(
      (market) =>
        market.region === region &&
        market.symbol &&
        primaryIndexSymbols[region].has(market.symbol),
    )
    .map((market) => market.direction);
  if (directions.length === 0) return undefined;
  const hasUp = directions.includes("up");
  const hasDown = directions.includes("down");
  if (hasUp && hasDown) return "mixed";
  if (hasUp) return "up";
  if (hasDown) return "down";
  return "flat";
}

function parseArchivedMarkets(value: string | null): MarketMetric[] {
  if (!value) return [];
  try {
    const markets = JSON.parse(value) as MarketMetric[];
    return Array.isArray(markets) ? markets : [];
  } catch {
    return [];
  }
}

function normalizeOverview(
  overview: DailyReport["overview"] | undefined,
): MarketOverview {
  if (overview && !Array.isArray(overview)) return overview;
  return {
    tone: "mixed",
    interpretation: overview?.join(" ") ?? "",
    positive: [],
    negative: [],
  };
}

function marketRegion(market: Partial<MarketMetric>): MarketRegion {
  return market.region === "CN" ||
    market.symbol === "SSE" ||
    market.symbol === "CSI300"
    ? "CN"
    : "US";
}

function storyRegions(story: DailyReport["stories"][number]): MarketRegion[] {
  if (Array.isArray(story.regions)) {
    const regions = story.regions.filter(
      (region): region is MarketRegion => region === "CN" || region === "US",
    );
    if (regions.length > 0) return [...new Set(regions)];
  }

  const source = [
    story.title,
    story.summary,
    story.evidence,
    story.sourceLabel,
    ...(story.ai?.sectors ?? []),
  ].join(" ");
  const regions: MarketRegion[] = [];
  if (
    /中国|A股|上证|沪深|商务部|发改委|人民银行|中证|China|Chinese|Moonshot/i.test(
      source,
    )
  ) {
    regions.push("CN");
  }
  if (
    /美股|纳斯达克|标普|道琼斯|美债|美联储|美国|Alphabet|Tesla|Apple|Nvidia|Nasdaq|S&P|Dow|Treasury|Federal Reserve|U\.S\./i.test(
      source,
    )
  ) {
    regions.push("US");
  }
  return regions.length > 0 ? regions : ["CN", "US"];
}

function fallbackMarketViews(
  report: Pick<DailyReport, "headline" | "summary" | "overview">,
): Record<MarketRegion, DailyMarketView> {
  const overview = normalizeOverview(report.overview);
  const view = {
    headline: report.headline,
    summary: report.summary,
    overview,
  };
  return { CN: view, US: view };
}

function normalizeMarketAsOf(
  report: Pick<DailyReport, "marketAsOf" | "sectorHeat">,
): Partial<Record<MarketRegion, string>> {
  return Object.fromEntries(
    (["CN", "US"] as MarketRegion[]).flatMap((market) => {
      const storedDate = report.marketAsOf?.[market];
      if (/^\d{4}-\d{2}-\d{2}$/.test(storedDate ?? "")) {
        return [[market, storedDate]];
      }
      const dates = [
        ...new Set(
          report.sectorHeat
            .filter((sector) => sector.market === market)
            .map((sector) => sector.asOf),
        ),
      ];
      return dates.length === 1 ? [[market, dates[0]]] : [];
    }),
  );
}

function normalizeReport(report: StoredDailyReport): DailyReport {
  const marketViews =
    report.marketViews?.CN && report.marketViews?.US
      ? report.marketViews
      : fallbackMarketViews(report);
  return {
    ...report,
    overview: normalizeOverview(report.overview),
    marketViews,
    marketAsOf: normalizeMarketAsOf(report),
    markets: report.markets.map((market) => ({
      ...market,
      region: marketRegion(market),
    })),
    stories: report.stories.map((story) => ({
      ...story,
      regions: storyRegions(story),
      ai: story.ai ?? legacyInsights[story.id],
    })),
  };
}

function parseDailyRow(row: DailyRow): DailyReport {
  const content = JSON.parse(row.content) as Partial<DailyReport>;
  return normalizeReport({
    reportDate: row.reportDate,
    edition: row.edition,
    headline: row.headline,
    summary: row.summary,
    generatedAt: row.generatedAt,
    dataCut: row.dataCut,
    agentModel: row.agentModel,
    updateKind: content.updateKind,
    marketAsOf: content.marketAsOf,
    overview: content.overview ?? [],
    marketViews: content.marketViews,
    markets: content.markets ?? [],
    sectorHeat: content.sectorHeat ?? [],
    stories: content.stories ?? [],
    isSample: content.isSample ?? false,
    translations: content.translations,
  });
}

function parseHeatRow(row: HeatRow): SectorHeatDay | null {
  if (!row.sectorHeat) return null;
  try {
    const sectors = (JSON.parse(row.sectorHeat) as SectorHeatMetric[]).filter(
      (sector) =>
        (sector.market === "CN" || sector.market === "US") &&
        typeof sector.symbol === "string" &&
        typeof sector.asOf === "string",
    );
    if (!Array.isArray(sectors) || sectors.length === 0) return null;
    return { reportDate: row.reportDate, sectors };
  } catch {
    return null;
  }
}

export function buildSectorHeatView(
  current: SectorHeatMetric[],
  history: SectorHeatDay[],
): SectorHeatView {
  const sessionMaps = new Map<string, Map<string, SectorHeatMetric>>();
  for (const day of history) {
    for (const sector of day.sectors) {
      const sessionKey = `${sector.market}:${sector.asOf}`;
      const sectors =
        sessionMaps.get(sessionKey) ?? new Map<string, SectorHeatMetric>();
      if (!sectors.has(sector.symbol)) sectors.set(sector.symbol, sector);
      sessionMaps.set(sessionKey, sectors);
    }
  }

  const streaks: SectorHeatStreak[] = [];
  for (const sector of current) {
    if (sector.score < heatThreshold) continue;
    const sessionDates = [...sessionMaps.keys()]
      .filter((key) => key.startsWith(`${sector.market}:`))
      .map((key) => key.slice(3))
      .filter((date) => date <= sector.asOf)
      .sort((left, right) => right.localeCompare(left));
    let days = 0;
    for (const date of sessionDates) {
      const candidate = sessionMaps
        .get(`${sector.market}:${date}`)
        ?.get(sector.symbol);
      if (!candidate || candidate.score < heatThreshold) break;
      days += 1;
    }
    if (days >= 2) streaks.push({ ...sector, days });
  }

  return {
    current,
    streaks: streaks.sort(
      (left, right) =>
        right.days - left.days ||
        right.score - left.score ||
        left.symbol.localeCompare(right.symbol),
    ),
    threshold: heatThreshold,
  };
}

function parseWeeklyRow(row: WeeklyRow): WeeklyReport {
  const content = JSON.parse(row.content) as Omit<
    WeeklyReport,
    "weekStart" | "weekEnd" | "headline" | "summary" | "generatedAt" | "agentModel"
  >;
  return {
    weekStart: row.weekStart,
    weekEnd: row.weekEnd,
    headline: row.headline,
    summary: row.summary,
    generatedAt: row.generatedAt,
    agentModel: row.agentModel,
    ...content,
  };
}

export async function getDailyArchive(
  db: D1Database | undefined,
  limit = 100,
): Promise<ReportListItem[]> {
  if (!db) {
    return fallbackReports.map((report) => ({
      reportDate: report.reportDate,
      edition: report.edition,
      title: report.headline,
      summary: report.summary,
      signalCount: report.stories.length,
      generatedAt: report.generatedAt,
      titleEn: report.translations?.en?.headline,
      summaryEn: report.translations?.en?.summary,
      marketSignalCounts: {
        CN: report.stories.filter((story) => story.regions.includes("CN"))
          .length,
        US: report.stories.filter((story) => story.regions.includes("US"))
          .length,
      },
      marketViews: {
        CN: {
          title: report.marketViews.CN.headline,
          summary: report.marketViews.CN.summary,
          tone: report.marketViews.CN.overview.tone,
          trend: summarizeMarketTrend(report.markets, "CN"),
          titleEn:
            report.translations?.en?.marketViews.CN.headline,
          summaryEn:
            report.translations?.en?.marketViews.CN.summary,
        },
        US: {
          title: report.marketViews.US.headline,
          summary: report.marketViews.US.summary,
          tone: report.marketViews.US.overview.tone,
          trend: summarizeMarketTrend(report.markets, "US"),
          titleEn:
            report.translations?.en?.marketViews.US.headline,
          summaryEn:
            report.translations?.en?.marketViews.US.summary,
        },
      },
    }));
  }

  const rows = await db
    .prepare(
      `SELECT
        report_date AS reportDate,
        edition,
        headline AS title,
        summary,
        json_extract(content, '$.translations.en.headline') AS titleEn,
        json_extract(content, '$.translations.en.summary') AS summaryEn,
        json_extract(content, '$.marketViews.CN.headline') AS cnTitle,
        json_extract(content, '$.marketViews.CN.summary') AS cnSummary,
        json_extract(content, '$.translations.en.marketViews.CN.headline') AS cnTitleEn,
        json_extract(content, '$.translations.en.marketViews.CN.summary') AS cnSummaryEn,
        json_extract(content, '$.marketViews.US.headline') AS usTitle,
        json_extract(content, '$.marketViews.US.summary') AS usSummary,
        json_extract(content, '$.translations.en.marketViews.US.headline') AS usTitleEn,
        json_extract(content, '$.translations.en.marketViews.US.summary') AS usSummaryEn,
        json_extract(content, '$.marketViews.CN.overview.tone') AS cnTone,
        json_extract(content, '$.marketViews.US.overview.tone') AS usTone,
        json_extract(content, '$.markets') AS marketsJson,
        json_array_length(content, '$.stories') AS signalCount,
        (
          SELECT COUNT(*)
          FROM json_each(daily_reports.content, '$.stories') AS story
          WHERE EXISTS (
            SELECT 1
            FROM json_each(story.value, '$.regions') AS region
            WHERE region.value = 'CN'
          )
        ) AS cnSignalCount,
        (
          SELECT COUNT(*)
          FROM json_each(daily_reports.content, '$.stories') AS story
          WHERE EXISTS (
            SELECT 1
            FROM json_each(story.value, '$.regions') AS region
            WHERE region.value = 'US'
          )
        ) AS usSignalCount,
        generated_at AS generatedAt
      FROM daily_reports
      ORDER BY report_date DESC
      LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 100))
    .all<DailyArchiveRow>();

  return rows.results.map((row) => {
    const {
      cnTitle,
      cnSummary,
      cnTitleEn,
      cnSummaryEn,
      cnSignalCount,
      usTitle,
      usSummary,
      usTitleEn,
      usSummaryEn,
      usSignalCount,
      cnTone,
      usTone,
      marketsJson,
      ...item
    } = row;
    const archivedMarkets = parseArchivedMarkets(marketsJson);
    const cnTrend = summarizeMarketTrend(archivedMarkets, "CN");
    const usTrend = summarizeMarketTrend(archivedMarkets, "US");
    return {
      ...item,
      ...(cnSignalCount !== null && usSignalCount !== null
        ? {
            marketSignalCounts: {
              CN: cnSignalCount,
              US: usSignalCount,
            },
          }
        : {}),
      ...(cnTitle && cnSummary && usTitle && usSummary
        ? {
            marketViews: {
              CN: {
                title: cnTitle,
                summary: cnSummary,
                ...(cnTone ? { tone: cnTone } : {}),
                ...(cnTrend ? { trend: cnTrend } : {}),
                ...(cnTitleEn ? { titleEn: cnTitleEn } : {}),
                ...(cnSummaryEn ? { summaryEn: cnSummaryEn } : {}),
              },
              US: {
                title: usTitle,
                summary: usSummary,
                ...(usTone ? { tone: usTone } : {}),
                ...(usTrend ? { trend: usTrend } : {}),
                ...(usTitleEn ? { titleEn: usTitleEn } : {}),
                ...(usSummaryEn ? { summaryEn: usSummaryEn } : {}),
              },
            },
          }
        : {}),
    };
  });
}

export async function getDailyReport(
  db: D1Database | undefined,
  date?: string | null,
): Promise<DailyReport | null> {
  if (!db) {
    const report =
      fallbackReports.find((item) => item.reportDate === date) ??
      (date ? null : fallbackReports[0]);
    return report ? normalizeReport(report) : null;
  }

  const where = date ? "WHERE report_date = ?" : "";
  const statement = db.prepare(
    `SELECT
      report_date AS reportDate,
      edition,
      headline,
      summary,
      generated_at AS generatedAt,
      data_cut AS dataCut,
      agent_model AS agentModel,
      content
    FROM daily_reports
    ${where}
    ORDER BY report_date DESC
    LIMIT 1`,
  );
  const row = date
    ? await statement.bind(date).first<DailyRow>()
    : await statement.first<DailyRow>();
  return row ? parseDailyRow(row) : null;
}

export async function getDailyHeatHistory(
  db: D1Database | undefined,
  throughDate?: string | null,
): Promise<SectorHeatDay[]> {
  if (!db) {
    return fallbackReports
      .filter((report) => !throughDate || report.reportDate <= throughDate)
      .slice(0, 7)
      .filter((report) => report.sectorHeat.length > 0)
      .map((report) => ({
        reportDate: report.reportDate,
        sectors: report.sectorHeat,
      }));
  }

  const rows = await db
    .prepare(
      `SELECT
        report_date AS reportDate,
        json_extract(content, '$.sectorHeat') AS sectorHeat
      FROM daily_reports
      WHERE report_date <= ?
      ORDER BY report_date DESC
      LIMIT 30`,
    )
    .bind(throughDate ?? "9999-12-31")
    .all<HeatRow>();

  return rows.results
    .map(parseHeatRow)
    .filter((day): day is SectorHeatDay => day !== null);
}

export async function getWeeklyArchive(
  db: D1Database | undefined,
  limit = 52,
): Promise<WeeklyListItem[]> {
  if (!db) return [];
  const rows = await db
    .prepare(
      `SELECT
        week_start AS weekStart,
        week_end AS weekEnd,
        headline,
        summary,
        json_extract(content, '$.translations.en.headline') AS headlineEn,
        json_extract(content, '$.translations.en.summary') AS summaryEn,
        generated_at AS generatedAt
      FROM weekly_reports
      ORDER BY week_end DESC
      LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 100))
    .all<WeeklyListItem>();
  return rows.results;
}

export async function getWeeklyReport(
  db: D1Database | undefined,
  weekEnd?: string | null,
): Promise<WeeklyReport | null> {
  if (!db) return null;
  const where = weekEnd ? "WHERE week_end = ?" : "";
  const statement = db.prepare(
    `SELECT
      week_start AS weekStart,
      week_end AS weekEnd,
      headline,
      summary,
      generated_at AS generatedAt,
      agent_model AS agentModel,
      content
    FROM weekly_reports
    ${where}
    ORDER BY week_end DESC
    LIMIT 1`,
  );
  const row = weekEnd
    ? await statement.bind(weekEnd).first<WeeklyRow>()
    : await statement.first<WeeklyRow>();
  return row ? parseWeeklyRow(row) : null;
}
