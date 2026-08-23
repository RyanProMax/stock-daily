import { ExternalLink } from "lucide-react";
import { formatTemplate } from "../lib/i18n";
import type {
  AiChainConstituent,
  AiChainMetric,
  AiChainUpdate,
  AiChainView,
  DriverEvidence,
  Language,
  MarketDriver,
  MarketDirection,
  MarketMetric,
  MarketRegion,
  DailyMarketView,
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

interface Props {
  markets: MarketMetric[];
  sectorView: SectorHeatView;
  sectorPerformance?: SectorHeatMetric[];
  aiChainPerformance?: AiChainMetric[];
  aiChainView?: AiChainView;
  marketView: DailyMarketView;
  drivers: MarketDriver[];
  aiUpdates: AiChainUpdate[];
  market: MarketRegion;
  language: Language;
  labels: {
    indices: string;
    sectors: string;
    range: string;
    aiChain: string;
    aiRange: string;
    streakDays: string;
    compositeAnalysis: string;
    verifiedSources: string;
    representativeBasket: string;
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
}: {
  metric: AiChainMetric;
  language: Language;
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
    </article>
  );
}

function SectorSnapshotItem({
  metric,
  language,
}: {
  metric: SectorHeatMetric;
  language: Language;
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
    </article>
  );
}

function uniqueEvidence(evidence: DriverEvidence[]) {
  return [...new Map(evidence.map((item) => [item.source, item])).values()];
}

function SnapshotAnalysis({
  headline,
  summary,
  signals,
  evidence,
  tags,
  labels,
}: {
  headline: string;
  summary: string;
  signals: Array<{ title: string; detail: string }>;
  evidence: DriverEvidence[];
  tags: Array<{ label: string; direction: MarketDirection }>;
  labels: Props["labels"];
}) {
  const sources = uniqueEvidence(evidence);
  const authorityLabels = {
    first_party: labels.sourceOfficial,
    specialist: labels.sourceSpecialist,
    expert: labels.sourceExpert,
  };
  return (
    <section className="snapshot-analysis">
      <div className="snapshot-analysis-main">
        <span className="snapshot-analysis-eyebrow">{labels.compositeAnalysis}</span>
        <h3>{headline}</h3>
        <p>{summary}</p>
        {signals.length > 0 && (
          <ul>
            {signals.slice(0, 3).map((signal) => (
              <li key={`${signal.title}:${signal.detail}`}>
                <strong>{signal.title}</strong>
                <span>{signal.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className="snapshot-analysis-aside">
        <div className="snapshot-analysis-tags">
          {tags.slice(0, 4).map((tag) => (
            <i className={`snapshot-analysis-tag market-direction-${tag.direction}`} key={tag.label}>
              {tag.label}
            </i>
          ))}
        </div>
        {sources.length > 0 && (
          <div className="snapshot-analysis-sources">
            <strong>{labels.verifiedSources}</strong>
            <span>
              {sources.map((item) => (
                <a href={item.source} target="_blank" rel="noreferrer" key={item.source}>
                  {item.platform === "x" && item.authorHandle
                    ? `X · @${item.authorHandle}`
                    : item.sourceLabel}
                  {item.platform === "x" && item.authority && (
                    <small>{authorityLabels[item.authority]}</small>
                  )}
                  <ExternalLink aria-hidden="true" />
                </a>
              ))}
            </span>
          </div>
        )}
      </aside>
    </section>
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
  aiChainView,
  marketView,
  drivers,
  aiUpdates,
  market,
  language,
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
  const sectorLeaders = completeSectors?.slice(0, 2) ?? [];
  const sectorLaggards = completeSectors?.slice(-2).reverse() ?? [];
  const sectorHeadline = language === "en"
    ? `${sectorLeaders.map((item) => item.nameEn).join(" and ")} led; ${sectorLaggards.map((item) => item.nameEn).join(" and ")} lagged`
    : `${sectorLeaders.map((item) => item.name).join("、")}表现居前，${sectorLaggards.map((item) => item.name).join("、")}表现居后`;
  const sectorSummary = drivers.length > 0
    ? drivers.map((driver) => driver.mechanism).join(language === "en" ? " " : "")
    : marketView.summary;
  const driverEvidence = drivers.flatMap((driver) => driver.evidence);
  const aiEvidence = aiUpdates.flatMap((update) => update.evidence);
  const aiByLayer = new Map(aiChain?.map((metric) => [metric.layer, metric]));

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
        <SnapshotAnalysis
          headline={marketView.headline}
          summary={marketView.summary}
          signals={drivers.map((driver) => ({ title: driver.title, detail: driver.summary }))}
          evidence={driverEvidence}
          tags={markets.slice(0, 4).map((item) => ({ label: `${item.name} ${item.change}`, direction: item.direction }))}
          labels={labels}
        />
      </section>

      {completeSectors ? (
        <section className="snapshot-group snapshot-group-sectors snapshot-sector-complete">
          <header className="snapshot-heading">
            <strong>{labels.sectors}</strong>
            <span>{labels.range}</span>
          </header>
          <div className="snapshot-grid snapshot-sector-grid snapshot-sector-grid-complete">
            {completeSectors.map((sector) => (
              <SectorSnapshotItem
                key={`${market}:${sector.symbol}`}
                metric={sector}
                language={language}
              />
            ))}
          </div>
          <SnapshotAnalysis
            headline={sectorHeadline}
            summary={sectorSummary}
            signals={drivers.map((driver) => ({ title: driver.title, detail: driver.mechanism }))}
            evidence={driverEvidence}
            tags={[...sectorLeaders, ...sectorLaggards].map((item) => ({
              label: `${localizedName(item, language)} ${item.change}`,
              direction: item.direction,
            }))}
            labels={labels}
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
            <span>{labels.aiRange}</span>
          </header>
          <div className="snapshot-grid snapshot-ai-grid">
            {aiChain.map((metric) => (
              <AiSnapshotItem
                key={`${market}:${metric.layer}`}
                metric={metric}
                language={language}
              />
            ))}
          </div>
          {aiChainView && (
            <SnapshotAnalysis
              headline={aiChainView.headline}
              summary={aiChainView.summary}
              signals={aiUpdates.map((update) => ({ title: update.title, detail: update.implication }))}
              evidence={aiEvidence}
              tags={[
                ...aiChainView.leaderLayers.map((layer) => aiByLayer.get(layer)),
                ...aiChainView.laggardLayers.map((layer) => aiByLayer.get(layer)),
              ].filter((metric): metric is AiChainMetric => Boolean(metric)).map((metric) => ({
                label: `${language === "en" ? metric.nameEn : metric.name} ${metric.change}`,
                direction: metric.direction,
              }))}
              labels={labels}
            />
          )}
        </section>
      )}
    </div>
  );
}
