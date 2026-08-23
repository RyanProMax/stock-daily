import { formatTemplate } from "../lib/i18n";
import type {
  AiChainMetric,
  AiChainView,
  Language,
  MarketDirection,
  MarketMetric,
  MarketRegion,
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
  market: MarketRegion;
  language: Language;
  labels: {
    indices: string;
    sectors: string;
    range: string;
    aiChain: string;
    aiRange: string;
    streakDays: string;
  };
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
        <ul className="ai-constituent-list">
          {metric.constituents.map((constituent) => (
            <li key={constituent.symbol}>
              <a href={constituent.source} target="_blank" rel="noreferrer">
                <span>{language === "en" ? constituent.nameEn : constituent.name}</span>
                <em className={`market-direction-${constituent.direction}`}>
                  {constituent.change}
                </em>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
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
      </section>

      {completeSectors ? (
        <section className="snapshot-group snapshot-group-sectors snapshot-sector-complete">
          <header className="snapshot-heading">
            <strong>{labels.sectors}</strong>
            <span>{labels.range}</span>
          </header>
          <div className="snapshot-grid snapshot-sector-grid snapshot-sector-grid-complete">
            {completeSectors.map((sector) => (
              <SnapshotItem
                key={`${market}:${sector.symbol}`}
                name={localizedName(sector, language)}
                change={sector.change}
                direction={sector.direction}
                href={sector.source}
                kind="sector"
                language={language}
              />
            ))}
          </div>
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
          {aiChainView && (
            <div className="ai-chain-read">
              <strong>{aiChainView.headline}</strong>
              <p>{aiChainView.summary}</p>
            </div>
          )}
          <div className="snapshot-grid snapshot-ai-grid">
            {aiChain.map((metric) => (
              <AiSnapshotItem
                key={`${market}:${metric.layer}`}
                metric={metric}
                language={language}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
