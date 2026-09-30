import { ExternalLink } from "lucide-react";
import { formatTemplate, formatEvidenceTime } from "../lib/i18n";
import RecapDetails from "./RecapDetails";
import type {
  AiChainConstituent,
  AiChainMetric,
  AiChainUpdate,
  CompleteRecap,
  RecapEntry,
  DriverEvidence,
  Language,
  MarketDriver,
  MarketDirection,
  MarketMetric,
  MarketRegion,
  ResultComparison,
  SectorConstituent,
  SectorHeatMetric,
  SectorHeatView,
} from "../types";

interface SnapshotItemProps {
  name: string;
  value?: string;
  change: string;
  direction: MarketDirection;
  href?: string;
  kind: "index" | "sector" | "ai";
  detail?: string;
  language: Language;
}

function localizeMetricValue(value: string, language: Language) {
  if (language === "zh") return value;
  return value
    .replace(/个百分点/gu, " percentage points")
    .replace(/个?基点/gu, " basis points")
    .replace(/（/gu, " (")
    .replace(/）/gu, ")");
}

interface Props {
  markets: MarketMetric[];
  sectorView: SectorHeatView;
  sectorPerformance?: SectorHeatMetric[];
  aiChainPerformance?: AiChainMetric[];
  recap?: CompleteRecap;
  drivers: MarketDriver[];
  aiUpdates: AiChainUpdate[];
  market: MarketRegion;
  language: Language;
  emptyMarketAttribution?: {
    title: string;
    detail: string;
  };
  labels: {
    indices: string;
    sectors: string;
    range: string;
    aiChain: string;
    aiRange: string;
    streakDays: string;
    highRelevance: string;
    verifiedFact: string;
    marketTransmission: string;
    chainImpact: string;
    sourceOfficial: string;
    sourceSpecialist: string;
    sourceExpert: string;
  };
}

function RepresentativeList({
  constituents,
  language,
}: {
  constituents: Array<AiChainConstituent | SectorConstituent>;
  language: Language;
}) {
  return (
    <ul className="representative-list">
      {constituents.map((constituent) => (
        <li key={constituent.symbol}>
          <a href={constituent.source} target="_blank" rel="noreferrer">
            <span>{language === "en" ? constituent.nameEn : constituent.name}</span>
            <span className={`representative-quote market-direction-${constituent.direction}`}>
              {constituent.value && <b>{constituent.value}</b>}
              <em>({constituent.change})</em>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function AiSnapshotItem({
  metric,
  language,
  entry,
}: {
  metric: AiChainMetric;
  language: Language;
  entry?: RecapEntry;
}) {
  const changeLabel = language === "zh" ? `（${metric.change}）` : `(${metric.change})`;
  return (
    <article
      className={`snapshot-item snapshot-item-ai snapshot-item-${metric.direction}`}
    >
      <div className="snapshot-item-top">
        <a href={metric.source} target="_blank" rel="noreferrer">
          {language === "en" ? metric.nameEn : metric.name}
          <em>{changeLabel}</em>
        </a>
      </div>
      {metric.constituents && (
        <RepresentativeList constituents={metric.constituents} language={language} />
      )}
      <RecapDetails entry={entry} language={language} market={metric.market} />
    </article>
  );
}

function SectorSnapshotItem({
  metric,
  language,
  entry,
}: {
  metric: SectorHeatMetric;
  language: Language;
  entry?: RecapEntry;
}) {
  const changeLabel = language === "zh" ? `（${metric.change}）` : `(${metric.change})`;
  return (
    <article
      className={`snapshot-item snapshot-item-sector snapshot-item-basket snapshot-item-${metric.direction}`}
    >
      <div className="snapshot-item-top">
        <a href={metric.source} target="_blank" rel="noreferrer">
          {localizedName(metric, language)}
          <em>{changeLabel}</em>
        </a>
      </div>
      {metric.constituents && (
        <RepresentativeList constituents={metric.constituents} language={language} />
      )}
      <RecapDetails entry={entry} language={language} market={metric.market} />
    </article>
  );
}

interface SnapshotEvidenceItem {
  tag: string;
  title: string;
  summary: string;
  metrics: ResultComparison[];
  evidence: DriverEvidence[];
}

function hasVerifiedExternalEvidence(evidence: DriverEvidence[]) {
  return evidence.some(
    (item) =>
      item.kind !== "market_data" &&
      (item.sourceType === "first_party" ||
        item.sourceType === "publisher" ||
        item.authority === "first_party"),
  );
}

function sourceName(evidence: DriverEvidence) {
  return evidence.platform === "x" && evidence.authorHandle
    ? `X · @${evidence.authorHandle}`
    : evidence.sourceLabel;
}

function sourceTitle(evidence: DriverEvidence) {
  return evidence.platform === "x" ? evidence.facts : evidence.title;
}

function evidenceTime(
  publishedAt: string,
  language: Language,
  market: MarketRegion,
) {
  return formatEvidenceTime(publishedAt, language, market);
}

function SnapshotEvidenceList({
  items,
  labels,
  language,
  market,
  emptyState,
}: {
  items: SnapshotEvidenceItem[];
  labels: Props["labels"];
  language: Language;
  market: MarketRegion;
  emptyState?: Props["emptyMarketAttribution"];
}) {
  const evidenceItems = items
    .filter((item) => hasVerifiedExternalEvidence(item.evidence));
  if (evidenceItems.length === 0) {
    return emptyState ? (
      <article className="snapshot-attribution-empty">
        <strong>{emptyState.title}</strong>
        <p>{emptyState.detail}</p>
      </article>
    ) : null;
  }

  const authorityLabels = {
    first_party: labels.sourceOfficial,
    specialist: labels.sourceSpecialist,
    expert: labels.sourceExpert,
  };

  return (
    <ul className="snapshot-evidence-list">
      {evidenceItems.map(({ evidence, tag, title, summary, metrics }) => (
            <li
              key={`${title}:${evidence.map((item) => item.source).join(":")}`}
            >
              <article className="snapshot-evidence-row">
                <header className="snapshot-evidence-header">
                  <span className="snapshot-evidence-tag">{tag}</span>
                  <strong>{title}</strong>
                </header>
                {metrics.length > 0 && (
                  <div className="snapshot-result-metrics">
                    {metrics.map((metric) => (
                      <article
                        className="snapshot-result-metric"
                        key={`${metric.label}:${metric.actual}:${metric.baseline}`}
                      >
                        <strong>{metric.label}</strong>
                        <p>
                          <span>
                            <small>{language === "zh" ? "实际" : "Actual"}</small>
                            <b>{localizeMetricValue(metric.actual, language)}</b>
                          </span>
                          <span>
                            <small>{metric.baselineLabel}</small>
                            <b>{localizeMetricValue(metric.baseline, language)}</b>
                          </span>
                          <em className={`snapshot-result-${metric.tone}`}>
                            {localizeMetricValue(metric.delta, language)}
                          </em>
                        </p>
                        {metric.note && <small>{metric.note}</small>}
                      </article>
                    ))}
                  </div>
                )}
                <p className="snapshot-causal-summary">
                  {summary}
                </p>
                <div className="snapshot-evidence-meta">
                  {[
                    ...new Map(
                      evidence.map((item) => [item.source, item]),
                    ).values(),
                  ].map((item) => (
                    <a
                      className="snapshot-evidence-source"
                      href={item.source}
                      key={item.source}
                      target="_blank"
                      rel="noreferrer"
                      title={sourceTitle(item)}
                    >
                      <strong>{sourceName(item)}</strong>
                      <time dateTime={item.publishedAt}>
                        {evidenceTime(item.publishedAt, language, market)}
                      </time>
                      {item.platform === "x" && item.authority && (
                        <small>{authorityLabels[item.authority]}</small>
                      )}
                      <ExternalLink aria-hidden="true" />
                    </a>
                  ))}
                </div>
              </article>
            </li>
          ))}
    </ul>
  );
}

function SnapshotItem({
  name,
  value,
  change,
  direction,
  href,
  kind,
  detail,
  language,
}: SnapshotItemProps) {
  const changeLabel =
    language === "zh" ? `（${change}）` : `(${change})`;
  const label = href ? (
    <a href={href} target="_blank" rel="noreferrer" title={name}>
      {name}
      <em>{changeLabel}</em>
    </a>
  ) : (
    <span title={name}>
      {name}
      <em>{changeLabel}</em>
    </span>
  );

  return (
    <article
      className={`snapshot-item snapshot-item-${kind} snapshot-item-${direction}`}
    >
      <div className="snapshot-item-top">
        {label}
      </div>
      {(value || detail) && (
        <div className="snapshot-item-bottom">
          {value && <strong>{value}</strong>}
          {detail && <small className="snapshot-item-detail">{detail}</small>}
        </div>
      )}
    </article>
  );
}

function localizedName(sector: SectorHeatMetric, language: Language) {
  return language === "en" ? sector.nameEn : sector.name;
}

export default function MarketSnapshot({
  markets,
  sectorView,
  sectorPerformance,
  aiChainPerformance,
  recap,
  drivers,
  aiUpdates,
  market,
  language,
  emptyMarketAttribution,
  labels,
}: Props) {
  const sectors = sectorView.current.filter((sector) => sector.market === market);
  const completeSectors = sectorPerformance
    ?.filter((sector) => sector.market === market)
    .sort(
      (left, right) =>
        Number.parseFloat(right.change) - Number.parseFloat(left.change),
    );
  const streaks = sectorView.streaks.filter((sector) => sector.market === market);
  const aiChain = aiChainPerformance?.filter(
    (metric) => metric.market === market,
  );
  const recapByTarget = new Map(recap?.entries.map((entry) => [entry.target, entry]) ?? []);
  const marketEvidence: SnapshotEvidenceItem[] = drivers
    .filter((driver) => driver.role === "primary")
    .map((driver) => ({
      evidence: driver.evidence,
      tag: language === "zh" ? "大盘" : "Market",
      title: driver.title,
      summary: driver.summary,
      metrics: driver.metrics ?? [],
    }));
  const sectorEvidence: SnapshotEvidenceItem[] = drivers
    .filter((driver) => driver.role === "secondary")
    .map((driver) => ({
      evidence: driver.evidence,
      tag: language === "zh" ? "行业" : "Sector",
      title: driver.title,
      summary: driver.summary,
      metrics: driver.metrics ?? [],
    }));
  const aiEvidence: SnapshotEvidenceItem[] = aiUpdates.map((update) => ({
    evidence: update.evidence,
    tag:
      aiChain?.find((metric) => metric.layer === update.layer)?.[
        language === "en" ? "nameEn" : "name"
      ] ?? "AI",
    title: update.title,
    summary: update.summary,
    metrics: update.metrics ?? [],
  }));

  return (
    <div className="market-snapshot">
      <section className="snapshot-group snapshot-group-indices">
        <header className="snapshot-heading">
          <strong>{labels.indices}</strong>
        </header>
        <div
          className={`snapshot-grid snapshot-index-grid snapshot-index-grid-count-${markets.length}`}
        >
          {markets.map((item) => (
            <SnapshotItem
              key={item.symbol ?? item.name}
              name={item.name}
              value={item.value}
              change={item.change}
              direction={item.direction}
              href={item.source}
              kind="index"
              language={language}
            />
          ))}
        </div>
        <SnapshotEvidenceList
          items={recap ? [] : marketEvidence}
          labels={labels}
          language={language}
          market={market}
          emptyState={recap ? undefined : emptyMarketAttribution}
        />
        {recap && <div className="recap-market"><RecapDetails entry={recap.entries.find((entry) => entry.kind === "market")} language={language} market={market} />
          {recap.socialStatus !== "consulted" && <p className="recap-pending">{recap.socialStatus === "unavailable" ? (language === "zh" ? "X 原文暂无法核实，未引用相关观点。" : "Original X posts could not be verified; related perspectives are unavailable.") : (language === "zh" ? "本期未发现可核实的相关 X 观点。" : "No relevant verified X perspectives were found for this session.")}</p>}
        </div>}
      </section>

      {completeSectors ? (
        <section className="snapshot-group snapshot-group-sectors snapshot-sector-complete">
          <header className="snapshot-heading">
            <strong>{labels.sectors}</strong>
          </header>
          <div className="snapshot-grid snapshot-sector-grid snapshot-sector-grid-complete">
            {completeSectors.map((sector) => (
              <SectorSnapshotItem
                key={`${market}:${sector.symbol}`}
                metric={sector}
                language={language}
                entry={recapByTarget.get(sector.symbol)}
              />
            ))}
          </div>
          <SnapshotEvidenceList
            items={recap ? [] : sectorEvidence}
            labels={labels}
            language={language}
            market={market}
          />
        </section>
      ) : (
        <details
          className="snapshot-group snapshot-group-sectors snapshot-sector-disclosure"
          data-sector-disclosure
        >
          <summary className="snapshot-heading">
          <strong>{labels.sectors}</strong>
          <span>{labels.range}</span>
          </summary>
          <div
            className={`snapshot-grid snapshot-sector-grid${
              sectors.length >= 6 ? " snapshot-sector-grid-expanded" : ""
            }`}
          >
            {sectors.map((sector) => {
              const streak = streaks.find(
                (item) => item.symbol === sector.symbol,
              );
              return (
                <SnapshotItem
                  key={`${market}:${sector.symbol}`}
                  name={localizedName(sector, language)}
                  change={sector.change}
                  direction={sector.direction}
                  href={sector.source}
                  kind="sector"
                  language={language}
                  detail={
                    streak
                      ? formatTemplate(labels.streakDays, {
                          count: streak.days,
                        })
                      : undefined
                  }
                />
              );
            })}
          </div>
        </details>
      )}

      {aiChain && aiChain.length > 0 && (
        <section className="snapshot-group snapshot-group-ai">
          <header className="snapshot-heading">
            <strong>{labels.aiChain}</strong>
          </header>
          <div className="snapshot-grid snapshot-ai-grid">
            {aiChain.map((metric) => (
              <AiSnapshotItem
                key={`${market}:${metric.layer}`}
                metric={metric}
                language={language}
                entry={recapByTarget.get(metric.symbol)}
              />
            ))}
          </div>
          <SnapshotEvidenceList
            items={recap ? [] : aiEvidence}
            labels={labels}
            language={language}
            market={market}
          />
        </section>
      )}
    </div>
  );
}
