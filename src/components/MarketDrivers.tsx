import { ExternalLink } from "lucide-react";
import type {
  Language,
  MarketDriver,
  SectorHeatMetric,
} from "../types";

interface Props {
  drivers: MarketDriver[];
  sectors: SectorHeatMetric[];
  language: Language;
  labels: {
    primary: string;
    secondary: string;
    happened: string;
    mechanism: string;
    sectors: string;
    evidence: string;
  };
}

export default function MarketDrivers({
  drivers,
  sectors,
  language,
  labels,
}: Props) {
  if (drivers.length === 0) return null;
  const bySymbol = new Map(sectors.map((sector) => [sector.symbol, sector]));

  return (
    <ol className="market-driver-list" aria-label={labels.evidence}>
      {drivers.map((driver, index) => {
        const evidence = [...new Map(
          driver.evidence.map((item) => [item.source, item]),
        ).values()];
        return (
          <li
            className={`market-driver-card market-driver-${driver.direction}`}
            key={driver.id}
          >
            <header className="market-driver-header">
              <span className="market-driver-number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <span className={`market-driver-role role-${driver.role}`}>
                  {driver.role === "primary" ? labels.primary : labels.secondary}
                </span>
                <h2>{driver.title}</h2>
              </div>
            </header>
            <div className="market-driver-body">
              <section>
                <strong>{labels.happened}</strong>
                <p>{driver.summary}</p>
              </section>
              <section className="market-driver-mechanism">
                <strong>{labels.mechanism}</strong>
                <p>{driver.mechanism}</p>
              </section>
            </div>
            <footer className="market-driver-footer">
              <div className="market-driver-sectors">
                <strong>{labels.sectors}</strong>
                <span>
                  {driver.sectorSymbols.map((symbol) => {
                    const sector = bySymbol.get(symbol);
                    if (!sector) return null;
                    return (
                      <i className={`sector-chip sector-chip-${sector.direction}`} key={symbol}>
                        {language === "en" ? sector.nameEn : sector.name}
                        <em>{sector.change}</em>
                      </i>
                    );
                  })}
                </span>
              </div>
              <div className="market-driver-evidence">
                <strong>{labels.evidence}</strong>
                <span>
                  {evidence.map((item) => (
                    <a href={item.source} target="_blank" rel="noreferrer" key={item.source}>
                      {item.sourceLabel}
                      <ExternalLink aria-hidden="true" />
                    </a>
                  ))}
                </span>
              </div>
            </footer>
          </li>
        );
      })}
    </ol>
  );
}
