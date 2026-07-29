export type MarketDirection = "up" | "down" | "flat";
export type MarketTrend = MarketDirection | "mixed";
export type StoryCategory = "公司" | "宏观" | "商品" | "行业";
export type ImpactTone = "positive" | "negative" | "mixed" | "neutral";
export type Language = "zh" | "en";
export type MarketRegion = "CN" | "US";
export type DailyUpdateKind = "morning" | "close" | "evening";
export type SourceTier = "first_party" | "wire" | "secondary";
export type BaselineKind =
  | "consensus"
  | "prior"
  | "guidance"
  | "policy"
  | "none";
export type SignalRole = "core" | "supporting" | "excluded";
export type SignalHorizon = "intraday" | "1-5d" | "1-4w";
export type SignalConfidence = "low" | "medium" | "high";
export type ThesisStatus =
  | "pending"
  | "confirmed"
  | "partial"
  | "invalidated"
  | "inconclusive";

export interface MarketMetric {
  region: MarketRegion;
  name: string;
  symbol?: string;
  value: string;
  change: string;
  direction: MarketDirection;
  note: string;
  source?: string;
  asOf?: string;
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

export interface EvidenceSource {
  url: string;
  label: string;
  tier: SourceTier;
  observedAt?: string;
}

export interface SignalMetric {
  id: string;
  label: string;
  labelEn?: string;
  actual?: number;
  expected?: number;
  prior?: number;
  unit: string;
  surprise?: number;
  surpriseUnit?: string;
  source: EvidenceSource;
}

export interface MarketReaction {
  instrument: string;
  change: string;
  window: string;
  windowEn?: string;
  asOf: string;
  source: EvidenceSource;
}

export interface TransmissionStep {
  order: 1 | 2 | 3;
  from: string;
  to: string;
  mechanism: string;
  conditional: boolean;
}

export interface SignalExposure {
  name: string;
  ticker?: string;
  exchange?: string;
  direction: ImpactTone;
  basis: string;
}

export interface VerificationCheckpoint {
  metric: string;
  dueAt: string;
  confirmIf: string;
  invalidateIf: string;
  status: ThesisStatus;
  observation?: string;
  resultSource?: EvidenceSource;
  verifiedAt?: string;
}

export interface PricingSignal {
  version: 2;
  score: number;
  scoreReason: string;
  rankByMarket: Partial<Record<MarketRegion, number>>;
  roleByMarket: Partial<Record<MarketRegion, SignalRole>>;
  thesis: string;
  baselineKind: BaselineKind;
  metrics: SignalMetric[];
  reactions: MarketReaction[];
  transmission: TransmissionStep[];
  exposures: SignalExposure[];
  horizon: SignalHorizon;
  confidence: SignalConfidence;
  checkpoint: VerificationCheckpoint;
}

export interface ThesisLedgerEntry {
  id: string;
  reportDate: string;
  storyId: string;
  market: MarketRegion;
  title: string;
  titleEn?: string;
  thesis: string;
  thesisEn?: string;
  horizon: SignalHorizon;
  confidence: SignalConfidence;
  checkpoint: VerificationCheckpoint;
  checkpointEn?: Pick<
    VerificationCheckpoint,
    "metric" | "confirmIf" | "invalidateIf" | "observation"
  >;
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
  evidenceSource?: EvidenceSource;
  ai?: StoryInsight;
  signal?: PricingSignal;
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
    signal?: {
      thesis: string;
      scoreReason: string;
      transmission: Array<Pick<TransmissionStep, "from" | "to" | "mechanism">>;
      exposures: Array<Pick<SignalExposure, "name" | "basis">>;
      checkpoint: Pick<
        VerificationCheckpoint,
        "metric" | "confirmIf" | "invalidateIf" | "observation"
      >;
    };
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
  id?: string;
  date: string;
  title: string;
  whyItMatters: string;
  source: string;
  sourceLabel: string;
  status?: "scheduled" | "realized" | "cancelled" | "postponed";
  result?: string;
  resultSource?: string;
  resultSourceLabel?: string;
  resultVerifiedAt?: string;
  baselineKind?: BaselineKind;
  metrics?: SignalMetric[];
}

export type WeeklyEventDisplayStatus =
  | "scheduled"
  | "awaiting"
  | "realized"
  | "cancelled"
  | "postponed";

export interface WeeklyEventTimelineItem extends WeeklyEvent {
  id: string;
  titleEn?: string;
  whyItMattersEn?: string;
  displayStatus: WeeklyEventDisplayStatus;
  resultEn?: string;
  realizedAt?: string;
}

export interface WeeklyEventTimeline {
  weekStart: string;
  weekEnd: string;
  sourceWeekEnd: string;
  events: WeeklyEventTimelineItem[];
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
      events: Array<
        Pick<WeeklyEvent, "title" | "whyItMatters"> & {
          result?: string;
        }
      >;
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
