// Generated from docs/report-contracts/*.schema.json. Do not edit.
type ReportDate = string;

type ReportTime = string;

type ReportPublished = ReportDate | ReportTime;

type ReportUrl = string;

type ReportMarket = "CN" | "US";

type ReportDirection = "up" | "down" | "flat";

type ReportTone = "positive" | "negative" | "mixed" | "neutral";

type ReportLayer = "chips" | "memory" | "servers" | "interconnect" | "data_center" | "cloud" | "applications" | "robotics";

type ReportDriverStatus = "explained" | "partial" | "insufficient" | "structural" | "unattributed";

type ReportOverviewText = {
  "interpretation": string;
  "positive": Array<string>;
  "negative": Array<string>;
};

type ReportOverview = {
  "tone": ReportTone;
  "interpretation": string;
  "positive": Array<string>;
  "negative": Array<string>;
};

type ReportView = {
  "headline": string;
  "summary": string;
  "overview": ReportOverview;
  "driverStatus": ReportDriverStatus;
  "leaderSectorSymbols": Array<string>;
  "laggardSectorSymbols": Array<string>;
  "driverIds": Array<string>;
};

type ReportViewEn = {
  "headline": string;
  "summary": string;
  "overview": ReportOverviewText;
};

type ReportAiView = {
  "headline": string;
  "summary": string;
  "mechanism"?: string;
  "driverStatus": ReportDriverStatus;
  "leaderLayers": Array<ReportLayer>;
  "laggardLayers": Array<ReportLayer>;
  "driverIds": Array<string>;
};

type ReportAiViewEn = {
  "headline": string;
  "summary": string;
  "mechanism"?: string;
};

type ReportSource = {
  "url": ReportUrl;
  "label": string;
  "tier": "first_party" | "wire" | "secondary";
  "observedAt"?: ReportTime;
};

type ReportConstituent = {
  "symbol": string;
  "name": string;
  "nameEn": string;
  "value"?: string;
  "change": string;
  "direction": ReportDirection;
  "asOf": ReportDate;
  "source": ReportUrl;
};

type ReportMarketMetric = {
  "region": ReportMarket;
  "symbol": string;
  "name": string;
  "value": string;
  "change": string;
  "direction": ReportDirection;
  "note": string;
  "source": ReportUrl;
  "asOf": ReportDate;
  "previousAsOf"?: ReportDate;
};

type ReportSector = {
  "market": ReportMarket;
  "symbol": string;
  "name": string;
  "nameEn": string;
  "score": number;
  "change": string;
  "direction": ReportDirection;
  "asOf": ReportDate;
  "source": ReportUrl;
  "constituents"?: Array<ReportConstituent>;
};

type ReportAiMetric = {
  "market": ReportMarket;
  "layer": ReportLayer;
  "name": string;
  "nameEn": string;
  "benchmark": string;
  "benchmarkEn": string;
  "benchmarkKind": "index" | "etf_proxy" | "equal_weight_basket";
  "symbol": string;
  "change": string;
  "direction": ReportDirection;
  "asOf": ReportDate;
  "source": ReportUrl;
  "constituents"?: Array<ReportConstituent>;
};

type ReportComparison = {
  "label": string;
  "actual": string;
  "baselineLabel": string;
  "baseline": string;
  "delta": string;
  "tone": ReportTone;
  "note": string;
};

type ReportEvidence = {
  "title": string;
  "facts": string;
  "source": ReportUrl;
  "sourceLabel": string;
  "publishedAt": ReportPublished;
  "kind": "market_data" | "market_wrap" | "event" | "official";
  "sourceType": "first_party" | "publisher" | "expert";
  "platform"?: "web" | "x";
  "authority"?: "first_party" | "specialist" | "expert";
  "authorHandle"?: string;
};

type ReportDriverText = {
  "title": string;
  "summary": string;
  "metrics"?: Array<ReportComparison>;
  "mechanism": string;
};

type ReportDriver = {
  "id": string;
  "market": ReportMarket;
  "role": "primary" | "secondary";
  "basis": "event" | "macro";
  "direction": "positive" | "negative" | "mixed";
  "title": string;
  "summary": string;
  "metrics"?: Array<ReportComparison>;
  "mechanism": string;
  "sectorSymbols": Array<string>;
  "evidence": Array<ReportEvidence>;
};

type ReportAiText = {
  "title": string;
  "summary": string;
  "metrics"?: Array<ReportComparison>;
  "implication": string;
};

type ReportAiUpdate = {
  "id": string;
  "market": ReportMarket;
  "layer": ReportLayer;
  "title": string;
  "summary": string;
  "metrics"?: Array<ReportComparison>;
  "implication": string;
  "evidence": Array<ReportEvidence>;
};

type ReportStoryInsight = {
  "tone": ReportTone;
  "interpretation": string;
  "sectors": Array<string>;
  "tickers": Array<string>;
};

type ReportStory = {
  "id": string;
  "regions": Array<ReportMarket>;
  "category": "公司" | "宏观" | "商品" | "行业";
  "importance": number;
  "title": string;
  "summary": string;
  "evidence": string;
  "source": ReportUrl;
  "sourceLabel": string;
  "publishedAt": ReportPublished;
  "evidenceSource"?: ReportSource;
  "ai"?: ReportStoryInsight;
};

type ReportStoryEn = {
  "title": string;
  "summary": string;
  "interpretation": string;
  "sectors": Array<string>;
};

type ReportRecapSource = {
  "id": string;
  "url": ReportUrl;
  "label": string;
  "publishedAt": ReportPublished;
  "verifiedAt": ReportTime;
  "kind"?: "market_data";
};

type ReportAlternative = {
  "text": string;
  "textEn": string;
  "status": "supported" | "contradicted" | "unresolved";
  "sources": Array<ReportRecapSource>;
};

type ReportOpinion = {
  "text": string;
  "textEn": string;
  "authorHandle": string;
  "url": ReportUrl;
  "publishedAt": ReportPublished;
  "sources": Array<ReportRecapSource>;
};

type ReportRecapEntry = {
  "target": string;
  "kind": "market" | "sector" | "ai_layer";
  "status": "explained" | "partial" | "unresolved";
  "confidence": "high" | "medium" | "low";
  "why": string;
  "whyEn": string;
  "magnitude": string;
  "magnitudeEn": string;
  "invalidateIf": string;
  "invalidateIfEn": string;
  "sources": Array<ReportRecapSource>;
  "alternatives": Array<ReportAlternative>;
  "opinions": Array<ReportOpinion>;
};

type ReportRecap = {
  "market": ReportMarket;
  "marketAsOf": ReportDate;
  "status": "complete" | "partial";
  "socialStatus": "consulted" | "no_relevant_posts" | "unavailable";
  "entries": Array<ReportRecapEntry>;
};

type ReportOutlook = {
  "base": string;
  "upside": string;
  "downside": string;
};

type ReportEvent = {
  "id": string;
  "date": ReportDate;
  "title": string;
  "whyItMatters": string;
  "source": ReportUrl;
  "sourceLabel": string;
  "expectation"?: string;
  "expectationSource"?: ReportUrl;
  "expectationSourceLabel"?: string;
  "status": "scheduled" | "realized" | "cancelled" | "postponed";
  "result"?: string;
  "assessment"?: string;
  "nextWatch"?: string;
  "impactTone"?: "positive" | "negative" | "neutral";
  "resultSource"?: ReportUrl;
  "resultSourceLabel"?: string;
  "resultVerifiedAt"?: ReportTime;
};

type ReportEventEn = {
  "title": string;
  "whyItMatters": string;
  "expectation"?: string;
  "result"?: string;
  "assessment"?: string;
  "nextWatch"?: string;
};

export type DailyReportPayload = {
  "schemaVersion": "daily-v1";
  "reportDate": ReportDate;
  "generatedAt": ReportTime;
  "cutoffAt": ReportTime;
  "marketAsOf": {
  "CN": ReportDate;
  "US": ReportDate;
};
  "headline": string;
  "summary": string;
  "overview": ReportOverview;
  "marketViews": {
  "CN": ReportView;
  "US": ReportView;
};
  "aiChainViews": {
  "CN": ReportAiView;
  "US": ReportAiView;
};
  "markets": Array<ReportMarketMetric>;
  "sectorHeat": Array<ReportSector>;
  "sectorPerformance": Array<ReportSector>;
  "aiChainPerformance": Array<ReportAiMetric>;
  "drivers": Array<ReportDriver>;
  "aiChainUpdates": Array<ReportAiUpdate>;
  "stories": Array<ReportStory>;
  "recaps"?: {
  "CN"?: ReportRecap;
  "US"?: ReportRecap;
};
  "translations": {
  "en": {
  "headline": string;
  "summary": string;
  "overview": ReportOverviewText;
  "marketViews": {
  "CN": ReportViewEn;
  "US": ReportViewEn;
};
  "aiChainViews": {
  "CN": ReportAiViewEn;
  "US": ReportAiViewEn;
};
  "drivers": Array<ReportDriverText>;
  "aiChainUpdates": Array<ReportAiText>;
  "stories": Array<ReportStoryEn>;
};
};
};

export type WeeklyReportPayload = {
  "schemaVersion": "weekly-v1";
  "weekStart": ReportDate;
  "weekEnd": ReportDate;
  "generatedAt": ReportTime;
  "cutoffAt": ReportTime;
  "headline": string;
  "summary": string;
  "overview": ReportOverview;
  "highlights": Array<string>;
  "outlook": ReportOutlook;
  "events": Array<ReportEvent>;
  "translations": {
  "en": {
  "headline": string;
  "summary": string;
  "overview": ReportOverviewText;
  "highlights": Array<string>;
  "outlook": ReportOutlook;
  "events": Array<ReportEventEn>;
};
};
};
