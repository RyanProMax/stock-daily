import { ExternalLink } from "lucide-react";
import type {
  AiChainUpdate,
  Language,
  MarketDriver,
  SectorHeatMetric,
} from "../types";

interface Props {
  drivers: MarketDriver[];
  aiUpdates: AiChainUpdate[];
  sectors: SectorHeatMetric[];
  language: Language;
  labels: {
    attribution: string;
    aiNews: string;
    happened: string;
    mechanism: string;
    sectors: string;
    evidence: string;
    aiImplication: string;
  };
}

function EvidenceLinks({
  evidence,
  label,
}: {
  evidence: MarketDriver["evidence"] | AiChainUpdate["evidence"];
  label: string;
}) {
  const unique = [
    ...new Map(evidence.map((item) => [item.source, item])).values(),
  ];
  return (
    <div className="market-driver-evidence">
      <strong>{label}</strong>
      <span>
        {unique.map((item) => (
          <a
            href={item.source}
            target="_blank"
            rel="noreferrer"
            key={item.source}
          >
            {item.sourceLabel}
            <ExternalLink aria-hidden="true" />
          </a>
        ))}
      </span>
    </div>
  );
}

export default function MarketDrivers({
  drivers,
  aiUpdates,
  sectors,
  language,
  labels,
}: Props) {
  if (drivers.length === 0 && aiUpdates.length === 0) return null;
  const bySymbol = new Map(sectors.map((sector) => [sector.symbol, sector]));

  return (
    <section
      className="market-intelligence-panel"
      aria-label={labels.attribution}
    >
      {drivers.length > 0 && (
        <section className="intelligence-group intelligence-attribution">
          <header className="intelligence-group-heading">
            <strong>{labels.attribution}</strong>
          </header>
          <div className="market-driver-list">
            {drivers.map((driver) => (
              <article
                className={`market-driver-row market-driver-${driver.direction}`}
                key={driver.id}
              >
                <header className="market-driver-header">
                  <h2>{driver.title}</h2>
                  <div className="market-driver-meta">
                    <div className="market-driver-sectors">
                      <strong>{labels.sectors}</strong>
                      <span>
                        {driver.sectorSymbols.map((symbol) => {
                          const sector = bySymbol.get(symbol);
                          if (!sector) return null;
                          return (
                            <i
                              className={`sector-chip sector-chip-${sector.direction}`}
                              key={symbol}
                            >
                              {language === "en" ? sector.nameEn : sector.name}
                              <em>{sector.change}</em>
                            </i>
                          );
                        })}
                      </span>
                    </div>
                    <EvidenceLinks
                      evidence={driver.evidence}
                      label={labels.evidence}
                    />
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
              </article>
            ))}
          </div>
        </section>
      )}

      {aiUpdates.length > 0 && (
        <section className="intelligence-group intelligence-ai-news">
          <header className="intelligence-group-heading">
            <strong>{labels.aiNews}</strong>
          </header>
          <div className="ai-update-list">
            {aiUpdates.map((update) => (
              <article className="ai-update-row" key={update.id}>
                <header>
                  <span className="ai-update-layer">
                    {language === "en"
                      ? {
                          chips: "Chips",
                          interconnect: "Interconnects",
                          infrastructure: "Infrastructure",
                          applications: "Applications",
                        }[update.layer]
                      : {
                          chips: "芯片与设备",
                          interconnect: "光互连与网络",
                          infrastructure: "云与算力基础设施",
                          applications: "软件与应用",
                        }[update.layer]}
                  </span>
                  <h2>{update.title}</h2>
                  <EvidenceLinks
                    evidence={update.evidence}
                    label={labels.evidence}
                  />
                </header>
                <div className="ai-update-copy">
                  <p>{update.summary}</p>
                  <p>
                    <strong>{labels.aiImplication}</strong>
                    {update.implication}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
