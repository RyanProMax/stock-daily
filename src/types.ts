export type MarketDirection = "up" | "down" | "flat";
export type MarketTrend = MarketDirection | "mixed";
export type StoryCategory = "公司" | "宏观" | "商品" | "行业";
export type ImpactTone = "positive" | "negative" | "mixed" | "neutral";
export type Language = "zh" | "en";
export type MarketRegion = "CN" | "US";
export type DailyUpdateKind = "morning" | "close" | "evening";

export interface MarketMetric {
  region: MarketRegion;
  name: string;
  symbol?: string;
  value: string;
  change: string;
  direction: MarketDirection;
  note: string;
  source?: string;
}

export interface SectorHeatMetric {
  market: MarketRegion;
  symbol: string;
  name: string;
  nameEn: string;
  score: number;
  change: string;
  direction: MarketDirection;
  asOf: string;
  source: string;
}

export interface SectorHeatDay {
  reportDate: string;
  sectors: SectorHeatMetric[];
}

export interface SectorHeatStreak extends SectorHeatMetric {
  days: number;
}

export interface SectorHeatView {
  current: SectorHeatMetric[];
  streaks: SectorHeatStreak[];
  threshold: number;
}

export interface StoryInsight {
  tone: ImpactTone;
  interpretation: string;
  sectors: string[];
  tickers: string[];
}

export interface MarketOverview {
  tone: ImpactTone;
  interpretation: string;
  positive: string[];
  negative: string[];
}

export interface DailyMarketView {
  headline: string;
  summary: string;
  overview: MarketOverview;
}

export interface Story {
  id: string;
  regions: MarketRegion[];
  category: StoryCategory;
  importance: number;
  title: string;
  summary: string;
  evidence: string;
  source: string;
  sourceLabel: string;
  publishedAt?: string;
  ai?: StoryInsight;
}

export interface DailyReport {
  reportDate: string;
  edition: number;
  generatedAt: string;
  dataCut: string;
  updateKind?: DailyUpdateKind;
  marketAsOf?: Partial<Record<MarketRegion, string>>;
  headline: string;
  summary: string;
  overview: MarketOverview | string[];
  marketViews: Record<MarketRegion, DailyMarketView>;
  markets: MarketMetric[];
  sectorHeat: SectorHeatMetric[];
  stories: Story[];
  agentModel: string;
  isSample: boolean;
  translations?: {
    en?: DailyReportTranslation;
  };
}

export interface DailyReportTranslation {
  headline: string;
  summary: string;
  overview: Omit<MarketOverview, "tone">;
  marketViews: Record<
    MarketRegion,
    Omit<DailyMarketView, "overview"> & {
      overview: Omit<MarketOverview, "tone">;
    }
  >;
  stories: Array<{
    title: string;
    summary: string;
    interpretation: string;
    sectors: string[];
  }>;
}

export interface ReportListItem {
  reportDate: string;
  edition: number;
  title: string;
  summary: string;
  signalCount: number;
  generatedAt: string;
  titleEn?: string;
  summaryEn?: string;
  marketSignalCounts?: Record<MarketRegion, number>;
  marketViews?: Record<
    MarketRegion,
    {
      title: string;
      summary: string;
      titleEn?: string;
      summaryEn?: string;
      tone?: ImpactTone;
      trend?: MarketTrend;
    }
  >;
}

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface WeeklyEvent {
  date: string;
  title: string;
  whyItMatters: string;
  source: string;
  sourceLabel: string;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  headline: string;
  summary: string;
  overview: MarketOverview;
  highlights: string[];
  outlook: {
    base: string;
    upside: string;
    downside: string;
  };
  events: WeeklyEvent[];
  agentModel: string;
  translations?: {
    en?: {
      headline: string;
      summary: string;
      overview: Omit<MarketOverview, "tone">;
      highlights: string[];
      outlook: WeeklyReport["outlook"];
      events: Array<Pick<WeeklyEvent, "title" | "whyItMatters">>;
    };
  };
}

export interface WeeklyListItem {
  weekStart: string;
  weekEnd: string;
  headline: string;
  summary: string;
  generatedAt: string;
  headlineEn?: string;
  summaryEn?: string;
}
