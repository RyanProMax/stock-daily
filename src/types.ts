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
export type DriverStatus = "explained" | "partial" | "unattributed";
export type DriverRole = "primary" | "secondary";
export type AiChainLayer =
  | "chips"
  | "memory"
  | "servers"
  | "interconnect"
  | "data_center"
  | "cloud"
  | "applications"
  | "robotics";

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
  previousAsOf?: string;
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

export interface AiChainMetric {
  market: MarketRegion;
  layer: AiChainLayer;
  name: string;
  nameEn: string;
  benchmark: string;
  benchmarkEn: string;
  benchmarkKind: "index" | "etf_proxy" | "equal_weight_basket";
  symbol: string;
  change: string;
  direction: MarketDirection;
  asOf: string;
  source: string;
  constituents?: AiChainConstituent[];
}

export interface AiChainConstituent {
  symbol: string;
  name: string;
  nameEn: string;
  change: string;
  direction: MarketDirection;
  asOf: string;
  source: string;
}

export interface AiChainView {
  headline: string;
  summary: string;
  driverStatus: DriverStatus;
  leaderLayers: AiChainLayer[];
  laggardLayers: AiChainLayer[];
  driverIds: string[];
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
  driverStatus?: DriverStatus;
  leaderSectorSymbols?: string[];
  laggardSectorSymbols?: string[];
  driverIds?: string[];
}

export interface MarketSession {
  market: MarketRegion;
  asOf: string;
  previousAsOf: string;
  windowStart: string;
  windowEnd: string;
  wrapDeadline: string;
}

export interface DriverEvidence {
  title: string;
  facts: string;
  source: string;
  sourceLabel: string;
  publishedAt: string;
  kind: "event" | "market_wrap";
  platform?: "web" | "x";
  authority?: "first_party" | "specialist" | "expert";
  authorHandle?: string;
}

export interface MarketDriver {
  id: string;
  market: MarketRegion;
  role: DriverRole;
  direction: Exclude<ImpactTone, "neutral">;
  title: string;
  summary: string;
  mechanism: string;
  sectorSymbols: string[];
  evidence: DriverEvidence[];
}

export interface AiChainUpdate {
  id: string;
  market: MarketRegion;
  layer: AiChainLayer;
  title: string;
  summary: string;
  implication: string;
  evidence: DriverEvidence[];
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
  contractVersion?: string;
  reportDate: string;
  edition: number;
  generatedAt: string;
  dataCut: string;
  updateKind?: DailyUpdateKind;
  marketAsOf?: Partial<Record<MarketRegion, string>>;
  marketSessions?: MarketSession[];
  headline: string;
  summary: string;
  overview: MarketOverview | string[];
  marketViews: Record<MarketRegion, DailyMarketView>;
  aiChainViews?: Record<MarketRegion, AiChainView>;
  markets: MarketMetric[];
  sectorHeat: SectorHeatMetric[];
  sectorPerformance?: SectorHeatMetric[];
  aiChainPerformance?: AiChainMetric[];
  drivers?: MarketDriver[];
  aiChainUpdates?: AiChainUpdate[];
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
  aiChainViews?: Record<MarketRegion, Pick<AiChainView, "headline" | "summary">>;
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
  drivers?: Array<Pick<MarketDriver, "title" | "summary" | "mechanism">>;
  aiChainUpdates?: Array<
    Pick<AiChainUpdate, "title" | "summary" | "implication">
  >;
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
      change?: string;
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
  expectation?: string;
  expectationSource?: string;
  expectationSourceLabel?: string;
  status?: "scheduled" | "realized" | "cancelled" | "postponed";
  result?: string;
  assessment?: string;
  nextWatch?: string;
  impactTone?: Exclude<ImpactTone, "mixed">;
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
  expectationEn?: string;
  displayStatus: WeeklyEventDisplayStatus;
  resultEn?: string;
  assessmentEn?: string;
  nextWatchEn?: string;
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
          expectation?: string;
          result?: string;
          assessment?: string;
          nextWatch?: string;
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
