import { formatTemplate } from "../lib/i18n";
import type {
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
  kind: "index" | "sector";
  detail?: string;
  language: Language;
}

interface Props {
  markets: MarketMetric[];
  sectorView: SectorHeatView;
  market: MarketRegion;
  language: Language;
  labels: {
    indices: string;
    sectors: string;
    range: string;
    streakDays: string;
  };
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
  market,
  language,
  labels,
}: Props) {
  const sectors = sectorView.current.filter((sector) => sector.market === market);
  const streaks = sectorView.streaks.filter((sector) => sector.market === market);

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
    </div>
  );
}
