import type {
  DailyReport,
  DailyReportTranslation,
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
  ThesisLedgerEntry,
  WeeklyEvent,
  WeeklyEventTimeline,
  WeeklyEventTimelineItem,
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

interface EventDailyRow {
  reportDate: string;
  content: string;
}

type LedgerDailyRow = DailyRow;

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
  cnChange: string | null;
  usChange: string | null;
  marketsJson: string | null;
}

const heatThreshold = 70;
const primaryIndexSymbols: Record<MarketRegion, Set<string>> = {
  CN: new Set(["SSE", "SZSE", "CSI300", "CSI500", "CHINEXT", "STAR50"]),
  US: new Set(["SPX", "IXIC", "DJI"]),
};
const eventTokenStopwords = new Set([
  "and",
  "committee",
  "decision",
  "income",
  "outlays",
  "the",
  "united",
  "states",
]);
type StoredDailyReport = Omit<DailyReport, "marketViews"> & {
  marketViews?: DailyReport["marketViews"];
};

function addIsoDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function sourceAuthority(value: string | undefined) {
  if (!value) return "";
  try {
    const parts = new URL(value).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .split(".");
    return parts.slice(-2).join(".");
  } catch {
    return "";
  }
}

function meaningfulTokens(value: string) {
  const latin = value
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{3,}/g)
    ?.filter(
      (token) =>
        !["market", "price", "result", "change", "data", "later"].includes(
          token,
        ),
    ) ?? [];
  const han = [
    ...value.matchAll(/(?=([\p{Script=Han}]{2}))/gu),
  ].map((match) => match[1]);
  return [...new Set([...latin, ...han])];
}

function hasCheckpointSubject(checkpointMetric: string, storyText: string) {
  const tokens = meaningfulTokens(checkpointMetric);
  if (tokens.length === 0) return false;
  const normalized = storyText.toLowerCase();
  return tokens.filter((token) => normalized.includes(token)).length >=
    Math.min(2, tokens.length);
}

function exposureKeys(story: DailyReport["stories"][number]) {
  const structured =
    story.signal?.exposures.flatMap((exposure) =>
      exposure.ticker
        ? [`${exposure.exchange ?? ""}:${exposure.ticker}`]
        : [],
    ) ?? [];
  const legacy =
    story.ai?.tickers.map((ticker) => `:${ticker.toUpperCase()}`) ?? [];
  return new Set([...structured, ...legacy]);
}

function storiesShareExposure(
  origin: DailyReport["stories"][number],
  candidate: DailyReport["stories"][number],
) {
  const originKeys = exposureKeys(origin);
  if (originKeys.size === 0) return false;
  for (const candidateKey of exposureKeys(candidate)) {
    const ticker = candidateKey.split(":").at(-1);
    if (
      originKeys.has(candidateKey) ||
      [...originKeys].some((key) => key.endsWith(`:${ticker}`))
    ) {
      return true;
    }
  }
  return false;
}

function verifiedFollowUp(
  origin: DailyReport["stories"][number],
  checkpoint: NonNullable<
    DailyReport["stories"][number]["signal"]
  >["checkpoint"],
  laterReports: DailyReport[],
) {
  for (const report of laterReports) {
    for (const [index, story] of report.stories.entries()) {
      if (
        !story.publishedAt ||
        !Number.isFinite(Date.parse(story.publishedAt)) ||
        !story.evidenceSource ||
        story.evidenceSource.tier === "secondary"
      ) {
        continue;
      }
      const text = [
        story.title,
        story.summary,
        story.evidence,
        story.signal?.thesis,
      ].join(" ");
      if (
        !hasCheckpointSubject(checkpoint.metric, text) &&
        !storiesShareExposure(origin, story)
      ) {
        continue;
      }
      return {
        observation: story.summary,
        observationEn:
          report.translations?.en?.stories[index]?.summary,
        resultSource: story.evidenceSource,
        verifiedAt: story.publishedAt,
      };
    }
  }
  return null;
}

export function deriveThesisLedger(
  reports: DailyReport[],
  throughDate: string,
  market: MarketRegion,
  originDate?: string,
  limit = 8,
): ThesisLedgerEntry[] {
  const ordered = [...reports]
    .filter((report) => report.reportDate <= throughDate)
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  const entries: ThesisLedgerEntry[] = [];

  for (const report of ordered) {
    if (originDate && report.reportDate !== originDate) continue;
    for (const [index, story] of report.stories.entries()) {
      const signal = story.signal;
      const role = signal?.roleByMarket[market];
      if (
        !signal ||
        !story.regions.includes(market) ||
        (role !== "core" && role !== "supporting")
      ) {
        continue;
      }
      let checkpoint = signal.checkpoint;
      let checkpointEn =
        report.translations?.en?.stories[index]?.signal?.checkpoint;
      if (
        checkpoint.status === "pending" &&
        checkpoint.dueAt < throughDate
      ) {
        const followUp = verifiedFollowUp(
          story,
          checkpoint,
          ordered.filter(
            (candidate) => candidate.reportDate > report.reportDate,
          ),
        );
        if (followUp) {
          checkpoint = {
            ...checkpoint,
            status: "inconclusive",
            observation: followUp.observation,
            resultSource: followUp.resultSource,
            verifiedAt: followUp.verifiedAt,
          };
          checkpointEn = {
            metric: checkpointEn?.metric ?? checkpoint.metric,
            confirmIf: checkpointEn?.confirmIf ?? checkpoint.confirmIf,
            invalidateIf:
              checkpointEn?.invalidateIf ?? checkpoint.invalidateIf,
            observation:
              followUp.observationEn ?? followUp.observation,
          };
        }
      }
      entries.push({
        id: `${report.reportDate}:${story.id}:${market}`,
        reportDate: report.reportDate,
        storyId: story.id,
        market,
        title: story.title,
        titleEn: report.translations?.en?.stories[index]?.title,
        thesis: signal.thesis,
        thesisEn: report.translations?.en?.stories[index]?.signal?.thesis,
        horizon: signal.horizon,
        confidence: signal.confidence,
        checkpoint,
        ...(checkpointEn ? { checkpointEn } : {}),
      });
    }
  }

  return entries
    .sort(
      (left, right) =>
        left.checkpoint.dueAt.localeCompare(right.checkpoint.dueAt) ||
        right.reportDate.localeCompare(left.reportDate),
    )
    .slice(0, limit);
}

function eventStoryPattern(eventTitle: string) {
  if (
    /fomc|federal open market|联邦公开市场|美联储.{0,8}(政策|利率|决议)/i.test(
      eventTitle,
    )
  ) {
    return /fomc|federal open market|联邦公开市场|美联储.{0,12}(政策|利率|决议)/i;
  }
  if (/gross domestic product|\bgdp\b|国内生产总值/i.test(eventTitle)) {
    return /gross domestic product|\bgdp\b|国内生产总值/i;
  }
  if (
    /personal income|income and outlays|个人收入|收入与支出|个人消费支出/i.test(
      eventTitle,
    )
  ) {
    return /personal income|income and outlays|个人收入|收入与支出|个人消费支出/i;
  }
  const tokens = [
    ...new Set(
      eventTitle
        .toLowerCase()
        .match(/[a-z0-9]{4,}/g)
        ?.filter((token) => !eventTokenStopwords.has(token)) ?? [],
    ),
  ];
  if (tokens.length === 0) return null;
  return new RegExp(
    tokens
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "i",
  );
}

function eventId(event: WeeklyEvent, index: number) {
  return (
    event.id?.trim() ||
    `${event.date}:${sourceAuthority(event.source) || event.sourceLabel}:${index}`
  );
}

type OutcomeReport = Pick<
  DailyReport,
  "reportDate" | "stories" | "translations"
>;

function findEventOutcome(
  event: WeeklyEvent,
  titleEn: string | undefined,
  reports: OutcomeReport[],
) {
  const authority = sourceAuthority(event.source);
  if (!authority) return null;
  const pattern = eventStoryPattern(`${event.title} ${titleEn ?? ""}`);
  if (!pattern) return null;

  for (const report of [...reports].sort((left, right) =>
    right.reportDate.localeCompare(left.reportDate),
  )) {
    if (report.reportDate < event.date) continue;
    for (const [index, story] of report.stories.entries()) {
      if (sourceAuthority(story.source) !== authority) continue;
      if (
        !story.publishedAt ||
        !Number.isFinite(Date.parse(story.publishedAt))
      ) {
        continue;
      }
      const text = [
        story.title,
        story.summary,
        story.evidence,
        story.sourceLabel,
      ].join(" ");
      if (!pattern.test(text)) continue;
      return {
        result: story.summary,
        resultEn: report.translations?.en?.stories[index]?.summary,
        impactTone:
          story.ai?.tone === "positive" || story.ai?.tone === "negative"
            ? story.ai.tone
            : ("neutral" as Exclude<ImpactTone, "mixed">),
        resultSource: story.source,
        resultSourceLabel: story.sourceLabel,
        resultVerifiedAt: story.publishedAt,
        realizedAt: report.reportDate,
        ...(story.signal?.baselineKind
          ? { baselineKind: story.signal.baselineKind }
          : {}),
        ...(story.signal?.metrics && story.signal.metrics.length > 0
          ? { metrics: story.signal.metrics }
          : {}),
      };
    }
  }
  return null;
}

export function buildWeeklyEventTimeline(
  report: WeeklyReport,
  throughDate: string,
  outcomeReports: OutcomeReport[] = [],
): WeeklyEventTimeline {
  const weekStart = addIsoDays(report.weekEnd, 1);
  const weekEnd = addIsoDays(report.weekEnd, 7);
  const translations = report.translations?.en?.events ?? [];
  const events = report.events
    .map((event, index): WeeklyEventTimelineItem | null => {
      if (event.date < weekStart || event.date > weekEnd) return null;
      const translation = translations[index];
      const eventAuthority = sourceAuthority(event.source);
      const storedResultIsVerified =
        event.status === "realized" &&
        Boolean(event.result?.trim()) &&
        Boolean(eventAuthority) &&
        sourceAuthority(event.resultSource) === eventAuthority &&
        Number.isFinite(Date.parse(event.resultVerifiedAt ?? ""));
      const derivedOutcome =
        event.date <= throughDate
          ? findEventOutcome(event, translation?.title, outcomeReports)
          : null;
      const outcome = storedResultIsVerified
        ? {
            result: event.result,
            resultEn: translation?.result,
            impactTone: (event.impactTone ?? "neutral") as Exclude<
              ImpactTone,
              "mixed"
            >,
            resultSource: event.resultSource,
            resultSourceLabel: event.resultSourceLabel,
            resultVerifiedAt: event.resultVerifiedAt,
            realizedAt: event.resultVerifiedAt?.slice(0, 10),
          }
        : derivedOutcome;
      const displayStatus =
        outcome
          ? "realized"
          : event.status === "cancelled" || event.status === "postponed"
            ? event.status
            : event.date < throughDate
              ? "awaiting"
              : "scheduled";
      return {
        ...event,
        id: eventId(event, index),
        titleEn: translation?.title,
        whyItMattersEn: translation?.whyItMatters,
        expectationEn: translation?.expectation,
        assessmentEn: translation?.assessment,
        nextWatchEn: translation?.nextWatch,
        displayStatus,
        ...outcome,
      };
    })
    .filter((event): event is WeeklyEventTimelineItem => event !== null);

  return {
    weekStart,
    weekEnd,
    sourceWeekEnd: report.weekEnd,
    events,
  };
}

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

function visibleStoryForMarket(
  story: DailyReport["stories"][number],
  market: MarketRegion,
) {
  return (
    story.importance >= 3 &&
    story.regions.includes(market) &&
    story.signal?.roleByMarket[market] !== "excluded"
  );
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
    market.symbol === "SZSE" ||
    market.symbol === "CSI300" ||
    market.symbol === "CSI500" ||
    market.symbol === "CHINEXT" ||
    market.symbol === "STAR50"
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

function readerFacingMarketNote(note: string) {
  return note
    .replace(/\s*·\s*API\s*Skill\b/giu, "")
    .replace(/\s*·\s*market_data_query\b/giu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function hasVerifiedExternalEvidence(
  evidence: NonNullable<DailyReport["drivers"]>[number]["evidence"],
) {
  return evidence.some(
    (item) =>
      item.kind !== "market_data" &&
      (item.sourceType === "first_party" ||
        item.sourceType === "publisher" ||
        item.authority === "first_party"),
  );
}

function normalizeReport(report: StoredDailyReport): DailyReport {
  const storedDrivers = report.drivers ?? [];
  const verifiedDriverIndexes = storedDrivers.flatMap((driver, index) =>
    (driver.basis === "event" || driver.basis === "macro") &&
    hasVerifiedExternalEvidence(driver.evidence)
      ? [index]
      : [],
  );
  const drivers = verifiedDriverIndexes.map((index) => storedDrivers[index]);
  const storedAiChainUpdates = report.aiChainUpdates ?? [];
  const verifiedAiUpdateIndexes = storedAiChainUpdates.flatMap((update, index) =>
    hasVerifiedExternalEvidence(update.evidence) ? [index] : [],
  );
  const aiChainUpdates = verifiedAiUpdateIndexes.map(
    (index) => storedAiChainUpdates[index],
  );
  const hasDriver = (market: MarketRegion) =>
    drivers.some((driver) => driver.market === market);
  const hasAiUpdate = (market: MarketRegion) =>
    aiChainUpdates.some((update) => update.market === market);
  const storedMarketViews =
    report.marketViews?.CN && report.marketViews?.US
      ? report.marketViews
      : fallbackMarketViews(report);
  const marketViews = Object.fromEntries(
    (["CN", "US"] as MarketRegion[]).map((market) => [
      market,
      {
        ...storedMarketViews[market],
        driverStatus: hasDriver(market)
          ? storedMarketViews[market].driverStatus === "explained"
            ? "explained"
            : "partial"
          : "insufficient",
        driverIds: drivers
          .filter((driver) => driver.market === market)
          .map((driver) => driver.id),
      },
    ]),
  ) as Record<MarketRegion, DailyMarketView>;
  const aiChainViews = report.aiChainViews
    ? (Object.fromEntries(
        (["CN", "US"] as MarketRegion[]).map((market) => {
          const view = report.aiChainViews?.[market];
          if (!view) return [market, view];
          const { mechanism: _mechanism, ...summaryOnly } = view;
          return [
            market,
            hasAiUpdate(market)
              ? {
                  ...view,
                  driverStatus:
                    view.driverStatus === "explained" ? "explained" : "partial",
                  driverIds: aiChainUpdates
                    .filter((update) => update.market === market)
                    .map((update) => update.id),
                }
              : { ...summaryOnly, driverStatus: "insufficient", driverIds: [] },
          ];
        }),
      ) as Record<MarketRegion, NonNullable<DailyReport["aiChainViews"]>[MarketRegion]>)
    : undefined;
  const translations = report.translations?.en
    ? {
        ...report.translations,
        en: {
          ...report.translations.en,
          drivers: verifiedDriverIndexes.map(
            (index) => report.translations?.en?.drivers?.[index],
          ).filter((driver) => driver !== undefined),
          aiChainUpdates: verifiedAiUpdateIndexes
            .map((index) => report.translations?.en?.aiChainUpdates?.[index])
            .filter((update) => update !== undefined),
          aiChainViews: report.translations.en.aiChainViews
            ? (Object.fromEntries(
                (["CN", "US"] as MarketRegion[]).map((market) => {
                  const view = report.translations?.en?.aiChainViews?.[market];
                  if (!view || hasAiUpdate(market)) return [market, view];
                  const { mechanism: _mechanism, ...summaryOnly } = view;
                  return [market, summaryOnly];
                }),
              ) as NonNullable<DailyReportTranslation["aiChainViews"]>)
            : undefined,
        },
      }
    : report.translations;
  return {
    ...report,
    overview: normalizeOverview(report.overview),
    marketViews,
    marketAsOf: normalizeMarketAsOf(report),
    markets: report.markets.map((market) => ({
      ...market,
      region: marketRegion(market),
      note: readerFacingMarketNote(market.note),
    })),
    stories: report.stories.map((story) => ({
      ...story,
      regions: storyRegions(story),
      ai: story.ai,
    })),
    drivers,
    sectorPerformance: report.sectorPerformance ?? [],
    aiChainPerformance: report.aiChainPerformance ?? [],
    aiChainViews,
    aiChainUpdates,
    translations,
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
    contractVersion: content.contractVersion,
    updateKind: content.updateKind,
    marketAsOf: content.marketAsOf,
    marketSessions: content.marketSessions,
    overview: content.overview ?? [],
    marketViews: content.marketViews,
    markets: content.markets ?? [],
    sectorHeat: content.sectorHeat ?? [],
    sectorPerformance: content.sectorPerformance ?? [],
    aiChainPerformance: content.aiChainPerformance ?? [],
    aiChainViews: content.aiChainViews,
    drivers: content.drivers ?? [],
    aiChainUpdates: content.aiChainUpdates ?? [],
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
  db: D1Database,
  limit = 100,
): Promise<ReportListItem[]> {
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
        (
          SELECT json_extract(market.value, '$.change')
          FROM json_each(daily_reports.content, '$.markets') AS market
          WHERE json_extract(market.value, '$.region') = 'CN'
          AND json_extract(market.value, '$.symbol') IN ('CSI300', 'SSE', 'SZSE')
          ORDER BY CASE json_extract(market.value, '$.symbol')
            WHEN 'CSI300' THEN 1
            WHEN 'SSE' THEN 2
            ELSE 3
          END
          LIMIT 1
        ) AS cnChange,
        (
          SELECT json_extract(market.value, '$.change')
          FROM json_each(daily_reports.content, '$.markets') AS market
          WHERE json_extract(market.value, '$.region') = 'US'
          AND json_extract(market.value, '$.symbol') IN ('SPX', 'DJI', 'IXIC')
          ORDER BY CASE json_extract(market.value, '$.symbol')
            WHEN 'SPX' THEN 1
            WHEN 'DJI' THEN 2
            ELSE 3
          END
          LIMIT 1
        ) AS usChange,
        json_extract(content, '$.markets') AS marketsJson,
        CASE WHEN json_type(content, '$.drivers') = 'array' THEN (
          SELECT COUNT(*) FROM json_each(daily_reports.content, '$.drivers')
        ) ELSE (
          SELECT COUNT(*)
          FROM json_each(daily_reports.content, '$.stories') AS story
          WHERE CAST(json_extract(story.value, '$.importance') AS INTEGER) >= 3
        ) END AS signalCount,
        CASE WHEN json_type(content, '$.drivers') = 'array' THEN (
          SELECT COUNT(*)
          FROM json_each(daily_reports.content, '$.drivers') AS driver
          WHERE json_extract(driver.value, '$.market') = 'CN'
        ) ELSE (
          SELECT COUNT(*)
          FROM json_each(daily_reports.content, '$.stories') AS story
          WHERE CAST(json_extract(story.value, '$.importance') AS INTEGER) >= 3
          AND COALESCE(json_extract(story.value, '$.signal.roleByMarket.CN'), 'core') != 'excluded'
          AND EXISTS (
            SELECT 1 FROM json_each(story.value, '$.regions') AS region
            WHERE region.value = 'CN'
          )
        ) END AS cnSignalCount,
        CASE WHEN json_type(content, '$.drivers') = 'array' THEN (
          SELECT COUNT(*)
          FROM json_each(daily_reports.content, '$.drivers') AS driver
          WHERE json_extract(driver.value, '$.market') = 'US'
        ) ELSE (
          SELECT COUNT(*)
          FROM json_each(daily_reports.content, '$.stories') AS story
          WHERE CAST(json_extract(story.value, '$.importance') AS INTEGER) >= 3
          AND COALESCE(json_extract(story.value, '$.signal.roleByMarket.US'), 'core') != 'excluded'
          AND EXISTS (
            SELECT 1 FROM json_each(story.value, '$.regions') AS region
            WHERE region.value = 'US'
          )
        ) END AS usSignalCount,
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
      cnChange,
      usChange,
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
                ...(cnChange ? { change: cnChange } : {}),
                ...(cnTitleEn ? { titleEn: cnTitleEn } : {}),
                ...(cnSummaryEn ? { summaryEn: cnSummaryEn } : {}),
              },
              US: {
                title: usTitle,
                summary: usSummary,
                ...(usTone ? { tone: usTone } : {}),
                ...(usTrend ? { trend: usTrend } : {}),
                ...(usChange ? { change: usChange } : {}),
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
  db: D1Database,
  date?: string | null,
): Promise<DailyReport | null> {
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

export async function getThesisLedger(
  db: D1Database,
  reportDate: string,
  market: MarketRegion,
): Promise<ThesisLedgerEntry[]> {
  const rows = await db
    .prepare(
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
       ORDER BY report_date DESC
       LIMIT 30`,
    )
    .all<LedgerDailyRow>();
  const reports = rows.results.flatMap((row) => {
    try {
      return [parseDailyRow(row)];
    } catch {
      return [];
    }
  });
  return deriveThesisLedger(
    reports,
    reports[0]?.reportDate ?? reportDate,
    market,
    reportDate,
  );
}

export async function getThesisHistory(
  db: D1Database,
  reportDate: string,
  market: MarketRegion,
): Promise<ThesisLedgerEntry[]> {
  const rows = await db
    .prepare(
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
       WHERE report_date <= ?
       ORDER BY report_date DESC
       LIMIT 45`,
    )
    .bind(reportDate)
    .all<LedgerDailyRow>();
  const reports = rows.results.flatMap((row) => {
    try {
      return [parseDailyRow(row)];
    } catch {
      return [];
    }
  });
  return deriveThesisLedger(reports, reportDate, market, undefined, 45)
    .filter((entry) => entry.reportDate < reportDate)
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
    .slice(0, 6);
}

export async function getDailyHeatHistory(
  db: D1Database,
  throughDate?: string | null,
): Promise<SectorHeatDay[]> {
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

export async function getWeeklyEventTimeline(
  db: D1Database,
  targetDate: string,
): Promise<WeeklyEventTimeline | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return null;
  const row = await db
    .prepare(
      `SELECT
        week_start AS weekStart,
        week_end AS weekEnd,
        headline,
        summary,
        generated_at AS generatedAt,
        agent_model AS agentModel,
        content
      FROM weekly_reports
      WHERE ? BETWEEN date(week_end, '+1 day') AND date(week_end, '+7 days')
      ORDER BY week_end DESC
      LIMIT 1`,
    )
    .bind(targetDate)
    .first<WeeklyRow>();
  if (!row) return null;

  const report = parseWeeklyRow(row);
  const weekStart = addIsoDays(report.weekEnd, 1);
  const dailyRows = await db
    .prepare(
      `SELECT report_date AS reportDate, content
       FROM daily_reports
       WHERE report_date BETWEEN ? AND ?
       ORDER BY report_date DESC`,
    )
    .bind(weekStart, targetDate)
    .all<EventDailyRow>();
  const outcomeReports = dailyRows.results.flatMap((dailyRow) => {
    try {
      const content = JSON.parse(dailyRow.content) as Partial<DailyReport>;
      return [
        {
          reportDate: dailyRow.reportDate,
          stories: content.stories ?? [],
          translations: content.translations,
        },
      ];
    } catch {
      return [];
    }
  });
  return buildWeeklyEventTimeline(report, targetDate, outcomeReports);
}

export async function getWeeklyArchive(
  db: D1Database,
  limit = 52,
): Promise<WeeklyListItem[]> {
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
  db: D1Database,
  weekEnd?: string | null,
): Promise<WeeklyReport | null> {
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
