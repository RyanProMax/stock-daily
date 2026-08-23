import { ExternalLink } from "lucide-react";
import type {
  AiChainMetric,
  AiChainUpdate,
  Language,
  MarketDriver,
  SectorHeatMetric,
} from "../types";

interface Props {
  drivers: MarketDriver[];
  aiUpdates: AiChainUpdate[];
  sectors: SectorHeatMetric[];
  aiMetrics: AiChainMetric[];
  language: Language;
  labels: {
    attribution: string;
    aiNews: string;
    happened: string;
    mechanism: string;
    sectors: string;
    evidence: string;
    aiImplication: string;
    sourceOfficial: string;
    sourceSpecialist: string;
    sourceExpert: string;
  };
}

function EvidenceLinks({
  evidence,
  label,
  authorityLabels,
}: {
  evidence: MarketDriver["evidence"] | AiChainUpdate["evidence"];
  label: string;
  authorityLabels: Record<"first_party" | "specialist" | "expert", string>;
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
            {item.platform === "x" && item.authorHandle
              ? `@${item.authorHandle}`
              : item.sourceLabel}
            {item.platform === "x" && item.authority && (
              <small>{authorityLabels[item.authority]}</small>
            )}
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
  aiMetrics,
  language,
  labels,
}: Props) {
  if (drivers.length === 0 && aiUpdates.length === 0) return null;
  const bySymbol = new Map(sectors.map((sector) => [sector.symbol, sector]));
  const aiByLayer = new Map(aiMetrics.map((metric) => [metric.layer, metric]));
  const authorityLabels = {
    first_party: labels.sourceOfficial,
    specialist: labels.sourceSpecialist,
    expert: labels.sourceExpert,
  };
  const layerNames = language === "en"
    ? {
        chips: "Chips & equipment",
        memory: "Memory",
        servers: "Servers & compute systems",
        interconnect: "CPO / optical interconnects",
        data_center: "Data-center power & cooling",
        cloud: "Cloud / NeoCloud",
        applications: "AI software & applications",
        robotics: "Robotics",
      }
    : {
        chips: "芯片与设备",
        memory: "存储",
        servers: "服务器与算力设备",
        interconnect: "CPO / 光互连",
        data_center: "数据中心电力与液冷",
        cloud: "云计算 / NeoCloud",
        applications: "AI 软件与应用",
        robotics: "机器人",
      };

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
                      authorityLabels={authorityLabels}
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
                  <div className="ai-update-layer-row">
                    <span className="ai-update-layer">{layerNames[update.layer]}</span>
                    {aiByLayer.get(update.layer) && (
                      <em
                        className={`ai-update-change market-direction-${aiByLayer.get(update.layer)?.direction}`}
                      >
                        {aiByLayer.get(update.layer)?.change}
                      </em>
                    )}
                  </div>
                  <h2>{update.title}</h2>
                  <EvidenceLinks
                    evidence={update.evidence}
                    label={labels.evidence}
                    authorityLabels={authorityLabels}
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
