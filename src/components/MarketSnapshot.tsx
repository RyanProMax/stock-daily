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

interface SnapshotEvidenceItem {
  tag: string;
  title: string;
  summary: string;
  highRelevance: boolean;
  evidence: DriverEvidence[];
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
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return publishedAt;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: language === "zh" ? "long" : "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: language === "en",
    timeZone: market === "CN" ? "Asia/Shanghai" : "America/New_York",
  }).format(date);
}

function SnapshotEvidenceList({
  items,
  labels,
  language,
  market,
}: {
  items: SnapshotEvidenceItem[];
  labels: Props["labels"];
  language: Language;
  market: MarketRegion;
}) {
  const evidenceItems = items
    .filter((item) => item.evidence.length > 0)
    .sort(
      (left, right) => Number(right.highRelevance) - Number(left.highRelevance),
    );
  if (evidenceItems.length === 0) return null;

  const authorityLabels = {
    first_party: labels.sourceOfficial,
    specialist: labels.sourceSpecialist,
    expert: labels.sourceExpert,
  };

  return (
    <ul className="snapshot-evidence-list">
      {evidenceItems.map(({ evidence, tag, title, summary, highRelevance }) => (
        <li
          className={highRelevance ? "snapshot-evidence-high" : undefined}
          key={`${title}:${evidence.map((item) => item.source).join(":")}`}
        >
          <article className="snapshot-evidence-row">
            <p>
              <strong>{title}</strong>
              <span>：{summary}</span>
            </p>
            <div className="snapshot-evidence-meta">
              <span className="snapshot-evidence-tag">{tag}</span>
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
  aiChainView,
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
  const marketEvidence = drivers.filter((driver) => driver.role === "primary").map((driver) => ({
    evidence: driver.evidence,
    tag: language === "zh" ? "大盘" : "Market",
    title: driver.title,
    summary: driver.summary,
    highRelevance: true,
  }));
  const sectorEvidence = drivers.filter((driver) => driver.role === "secondary").map((driver) => ({
    evidence: driver.evidence,
    tag: language === "zh" ? "行业" : "Sector",
    title: driver.title,
    summary: driver.summary,
    highRelevance: false,
  }));
  const aiEvidence = aiUpdates.map((update) => ({
    evidence: update.evidence,
    tag:
      aiChain?.find((metric) => metric.layer === update.layer)?.[
        language === "en" ? "nameEn" : "name"
      ] ?? (language === "zh" ? "AI" : "AI"),
    title: update.title,
    summary: update.summary,
    highRelevance: update.evidence.some((evidence) => evidence.platform !== "x"),
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
          items={marketEvidence}
          labels={labels}
          language={language}
          market={market}
        />
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
              />
            ))}
          </div>
          <SnapshotEvidenceList
            items={sectorEvidence}
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
              />
            ))}
          </div>
          {aiUpdates.length === 0 && aiChainView && (
            <article className="snapshot-structural-view">
              <strong>{aiChainView.headline}</strong>
              <p>{aiChainView.summary}</p>
            </article>
          )}
          <SnapshotEvidenceList
            items={aiEvidence}
            labels={labels}
            language={language}
            market={market}
          />
        </section>
      )}
    </div>
  );
}
