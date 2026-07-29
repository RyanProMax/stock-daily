import { formatTemplate } from "../lib/i18n";
import type {
  Language,
  MarketRegion,
  SectorHeatMetric,
  SectorHeatView,
} from "../types";

interface Props {
  view: SectorHeatView;
  market: MarketRegion;
  language: Language;
  labels: {
    title: string;
    range: string;
    streakTitle: string;
    streakDays: string;
    noStreak: string;
  };
}

function localizedName(sector: SectorHeatMetric, language: Language) {
  return language === "en" ? sector.nameEn : sector.name;
}

export default function MarketHeatHistory({
  view,
  market,
  language,
  labels,
}: Props) {
  const streaks = view.streaks.filter(
    (sector) => sector.market === market,
  );

  function marketPanel(market: MarketRegion) {
    const sectors = view.current.filter((sector) => sector.market === market);

    return (
      <section
        className={`heat-market heat-market-${market.toLowerCase()}`}
        aria-label={market}
      >
        <div className="heat-sector-list">
          {sectors.map((sector) => {
            const name = localizedName(sector, language);
            return (
              <article
                className={`heat-item heat-item-${sector.direction}`}
                key={`${market}:${sector.symbol}`}
              >
                <div className="heat-item-top">
                  <a
                    href={sector.source}
                    target="_blank"
                    rel="noreferrer"
                    title={name}
                  >
                    {name}
                  </a>
                  <b>{sector.change}</b>
                </div>
                <div className="heat-item-meta">
                  <span>{sector.symbol}</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div className="heat-history">
      <div className="heat-heading">
        <strong>{labels.title}</strong>
        <span>{labels.range}</span>
      </div>
      <div className="heat-market-grid">
        {marketPanel(market)}
      </div>
      <div className="heat-streaks">
        <header>
          <strong>{labels.streakTitle}</strong>
          <small>|%| ≥ {(view.threshold / 20).toFixed(1)}</small>
        </header>
        {streaks.length > 0 ? (
          <div>
            {streaks.map((sector) => (
              <span key={`${sector.market}:${sector.symbol}`}>
                <i>{sector.market}</i>
                <b>{localizedName(sector, language)}</b>
                <em>
                  {formatTemplate(labels.streakDays, {
                    count: sector.days,
                  })}
                </em>
              </span>
            ))}
          </div>
        ) : (
          <p>{labels.noStreak}</p>
        )}
      </div>
    </div>
  );
}
