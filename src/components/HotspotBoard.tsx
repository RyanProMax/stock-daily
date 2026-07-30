import {
  ChevronDown,
  Clock3,
  ExternalLink,
  Minus,
} from "lucide-react";
import { toneLabel } from "../lib/i18n";
import type {
  Language,
  MarketRegion,
  PricingSignal,
  SignalConfidence,
  SignalHorizon,
  SignalRole,
  SourceTier,
  Story,
  ThesisLedgerEntry,
  ThesisStatus,
  WeeklyEventDisplayStatus,
  WeeklyEventTimeline,
  WeeklyEventTimelineItem,
} from "../types";

interface LocalizedStory extends Story {
  categoryLabel: string;
  ai: NonNullable<Story["ai"]>;
}

interface RankedStory {
  number: number;
  role: Exclude<SignalRole, "excluded">;
  story: LocalizedStory;
}

interface Labels {
  title: string;
  events: string;
  top: string;
  supporting: string;
  source: string;
  facts: string;
  logic: string;
  impact: string;
  proof: string;
  scheduled: string;
  awaiting: string;
  cancelled: string;
  postponed: string;
  assessment: string;
  next: string;
  noData: string;
  pricingThesis: string;
  expectationGap: string;
  actual: string;
  expected: string;
  prior: string;
  surprise: string;
  marketReaction: string;
  transmission: string;
  exposure: string;
  checkpoint: string;
  confirmIf: string;
  invalidateIf: string;
  verifyBy: string;
  confidence: string;
  coreSignal: string;
  supportingSignal: string;
  horizonIntraday: string;
  horizonShort: string;
  horizonMedium: string;
  confidenceLow: string;
  confidenceMedium: string;
  confidenceHigh: string;
  sourceFirstParty: string;
  sourceWire: string;
  sourceSecondary: string;
  statusPending: string;
  statusConfirmed: string;
  statusPartial: string;
  statusInvalidated: string;
  statusInconclusive: string;
  observation: string;
}

interface Props {
  stories: LocalizedStory[];
  timeline: WeeklyEventTimeline | null;
  thesisLedger: ThesisLedgerEntry[];
  market: MarketRegion;
  language: Language;
  labels: Labels;
}

export function eventDate(date: string, language: Language) {
  const value = /^\d{4}-\d{2}-\d{2}$/u.test(date)
    ? new Date(`${date}T00:00:00+08:00`)
    : new Date(date);
  if (Number.isNaN(value.getTime())) return date;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: language === "zh" ? "numeric" : "short",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(value);
}

function localizedEvent(event: WeeklyEventTimelineItem, language: Language) {
  return {
    title: language === "en" ? event.titleEn ?? event.title : event.title,
    why:
      language === "en"
        ? event.whyItMattersEn ?? event.whyItMatters
        : event.whyItMatters,
    result: language === "en" ? event.resultEn ?? event.result : event.result,
    expectation:
      language === "en"
        ? event.expectationEn ?? event.expectation
        : event.expectation,
    assessment:
      language === "en"
        ? event.assessmentEn ?? event.assessment
        : event.assessment,
    nextWatch:
      language === "en"
        ? event.nextWatchEn ?? event.nextWatch
        : event.nextWatch,
  };
}

function sourceAuthority(value: string | undefined) {
  if (!value) return "";
  try {
    const parts = new URL(value).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .split(".");
    return parts.slice(-2).join(".");
  } catch {
    return "";
  }
}

function safeDisplayStatus(
  event: WeeklyEventTimelineItem,
  language: Language,
): WeeklyEventDisplayStatus {
  if (event.displayStatus !== "realized") return event.displayStatus;
  const result =
    language === "en" ? event.resultEn ?? event.result : event.result;
  const eventAuthority = sourceAuthority(event.source);
  const sourceMatches =
    Boolean(eventAuthority) &&
    sourceAuthority(event.resultSource) === eventAuthority;
  return result?.trim() &&
    sourceMatches &&
    Number.isFinite(Date.parse(event.resultVerifiedAt ?? ""))
    ? "realized"
    : "awaiting";
}

function StatusIcon({ status }: { status: WeeklyEventDisplayStatus }) {
  if (status === "cancelled") return <Minus aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

function rankStories(stories: LocalizedStory[], market: MarketRegion) {
  const eligible = stories.filter((story) => story.importance >= 3);
  const hasStructuredSignals = eligible.some((story) => story.signal);
  const ranked = eligible
    .filter(
      (story) =>
        !hasStructuredSignals ||
        story.signal?.roleByMarket[market] !== "excluded",
    )
    .sort((left, right) => {
      const leftRank = left.signal?.rankByMarket[market];
      const rightRank = right.signal?.rankByMarket[market];
      if (leftRank && rightRank) return leftRank - rightRank;
      if (leftRank) return -1;
      if (rightRank) return 1;
      return right.importance - left.importance;
    })
    .slice(0, 5);

  return ranked.map((story, index): RankedStory => {
    const assignedRole = story.signal?.roleByMarket[market];
    return {
      number: index + 1,
      role:
        assignedRole === "core" || assignedRole === "supporting"
          ? assignedRole
          : index < 3
            ? "core"
            : "supporting",
      story,
    };
  });
}

function metricValue(
  value: number | undefined,
  unit: string,
  signed = false,
) {
  if (value === undefined) return "—";
  return `${signed && value > 0 ? "+" : ""}${value}${unit}`;
}

function horizonLabel(
  horizon: SignalHorizon,
  labels: Labels,
) {
  return {
    intraday: labels.horizonIntraday,
    "1-5d": labels.horizonShort,
    "1-4w": labels.horizonMedium,
  }[horizon];
}

function confidenceLabel(
  confidence: SignalConfidence,
  labels: Labels,
) {
  return {
    low: labels.confidenceLow,
    medium: labels.confidenceMedium,
    high: labels.confidenceHigh,
  }[confidence];
}

function sourceTierLabel(tier: SourceTier | undefined, labels: Labels) {
  if (tier === "first_party") return labels.sourceFirstParty;
  if (tier === "wire") return labels.sourceWire;
  return labels.sourceSecondary;
}

function statusLabel(status: ThesisStatus, labels: Labels) {
  return {
    pending: labels.statusPending,
    confirmed: labels.statusConfirmed,
    partial: labels.statusPartial,
    invalidated: labels.statusInvalidated,
    inconclusive: labels.statusInconclusive,
  }[status];
}

function localizedLedgerEntry(
  entry: ThesisLedgerEntry,
  language: Language,
) {
  return {
    title: language === "en" ? entry.titleEn ?? entry.title : entry.title,
    thesis:
      language === "en" ? entry.thesisEn ?? entry.thesis : entry.thesis,
    checkpoint:
      language === "en" && entry.checkpointEn
        ? { ...entry.checkpoint, ...entry.checkpointEn }
        : entry.checkpoint,
  };
}

function MetricGrid({
  signal,
  labels,
}: {
  signal: PricingSignal;
  labels: Labels;
}) {
  if (signal.metrics.length === 0) return null;
  return (
    <section className="signal-block signal-metrics">
      <strong>{labels.expectationGap}</strong>
      <div>
        {signal.metrics.map((metric) => (
          <article key={metric.id}>
            <h5>{metric.label}</h5>
            <dl>
              <div>
                <dt>{labels.actual}</dt>
                <dd>{metricValue(metric.actual, metric.unit)}</dd>
              </div>
              <div>
                <dt>{labels.expected}</dt>
                <dd>{metricValue(metric.expected, metric.unit)}</dd>
              </div>
              <div>
                <dt>{labels.prior}</dt>
                <dd>{metricValue(metric.prior, metric.unit)}</dd>
              </div>
              <div className="metric-surprise">
                <dt>{labels.surprise}</dt>
                <dd>
                  {metricValue(
                    metric.surprise,
                    metric.surpriseUnit ?? metric.unit,
                    true,
                  )}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function SignalAnalysis({
  story,
  ledgerEntry,
  labels,
  language,
}: {
  story: LocalizedStory;
  ledgerEntry?: ThesisLedgerEntry;
  labels: Labels;
  language: Language;
}) {
  const signal = story.signal;
  if (!signal) {
    return (
      <div className="hotspot-analysis" id={`story-${story.id}`}>
        <div className="hotspot-analysis-copy">
          <div>
            <strong>{labels.facts}</strong>
            <p>{story.summary}</p>
          </div>
          <div>
            <strong>{labels.logic}</strong>
            <p>{story.ai.interpretation}</p>
          </div>
        </div>
        <div className="hotspot-impact">
          <strong>{labels.impact}</strong>
          <span>
            {story.ai.sectors.map((sector) => (
              <i className="sector-tag" key={sector}>
                {sector}
              </i>
            ))}
            {story.ai.tickers.map((ticker) => (
              <i className="ticker-tag" key={ticker}>
                {ticker}
              </i>
            ))}
          </span>
        </div>
        <details className="hotspot-proof">
          <summary>
            {labels.proof}
            <ChevronDown aria-hidden="true" />
          </summary>
          <p>{story.evidence}</p>
        </details>
      </div>
    );
  }
  const checkpoint = ledgerEntry
    ? localizedLedgerEntry(ledgerEntry, language).checkpoint
    : signal.checkpoint;

  return (
    <div className="hotspot-analysis signal-analysis" id={`story-${story.id}`}>
      <div className="signal-fact-thesis">
        <div>
          <strong>{labels.facts}</strong>
          <p>{story.summary}</p>
        </div>
        <div>
          <strong>{labels.pricingThesis}</strong>
          <p>{signal.thesis}</p>
        </div>
      </div>

      <MetricGrid signal={signal} labels={labels} />

      {signal.reactions.length > 0 && (
        <section className="signal-block signal-reactions">
          <strong>{labels.marketReaction}</strong>
          <div>
            {signal.reactions.map((reaction) => (
              <article key={`${reaction.instrument}:${reaction.window}`}>
                <span>{reaction.instrument}</span>
                <em>{reaction.change}</em>
                <small>{reaction.window}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="signal-block signal-transmission">
        <strong>{labels.transmission}</strong>
        <ol>
          {signal.transmission.map((step) => (
            <li key={step.order}>
              <span>{step.from}</span>
              <i aria-hidden="true">→</i>
              <span>{step.to}</span>
              <p>{step.mechanism}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="signal-block signal-exposures">
        <strong>{labels.exposure}</strong>
        <div>
          {signal.exposures.map((exposure) => (
            <article
              className={`signal-exposure signal-exposure-${exposure.direction}`}
              key={`${exposure.exchange ?? ""}:${exposure.ticker ?? exposure.name}`}
            >
              <span>
                <b>{exposure.name}</b>
                {exposure.ticker && (
                  <i>
                    {exposure.exchange}:{exposure.ticker}
                  </i>
                )}
              </span>
              <p>{exposure.basis}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="signal-checkpoint">
        <header>
          <strong>{labels.checkpoint}</strong>
          <span className={`ledger-status status-${checkpoint.status}`}>
            {statusLabel(checkpoint.status, labels)}
          </span>
        </header>
        <h5>{checkpoint.metric}</h5>
        <dl>
          <div>
            <dt>{labels.confirmIf}</dt>
            <dd>{checkpoint.confirmIf}</dd>
          </div>
          <div>
            <dt>{labels.invalidateIf}</dt>
            <dd>{checkpoint.invalidateIf}</dd>
          </div>
        </dl>
        <p>
          {labels.verifyBy}{" "}
          <time dateTime={checkpoint.dueAt}>
            {eventDate(checkpoint.dueAt, language)}
          </time>
        </p>
        {checkpoint.observation && (
          <div className="checkpoint-observation" data-signal-review>
            <strong>{labels.observation}</strong>
            <p>{checkpoint.observation}</p>
            {(checkpoint.resultSource || checkpoint.verifiedAt) && (
              <div>
                {checkpoint.resultSource && (
                  <a
                    href={checkpoint.resultSource.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {checkpoint.resultSource.label}
                    <ExternalLink aria-hidden="true" />
                  </a>
                )}
                {checkpoint.verifiedAt && (
                  <time dateTime={checkpoint.verifiedAt}>
                    {eventDate(checkpoint.verifiedAt, language)}
                  </time>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <details className="hotspot-proof">
        <summary>
          {labels.proof}
          <ChevronDown aria-hidden="true" />
        </summary>
        <p>{story.evidence}</p>
      </details>
    </div>
  );
}

export default function HotspotBoard({
  stories,
  timeline,
  thesisLedger,
  market,
  language,
  labels,
}: Props) {
  const rankedStories = rankStories(stories, market);
  const groups = [
    {
      key: "core",
      title: labels.top,
      stories: rankedStories.filter((item) => item.role === "core"),
    },
    {
      key: "supporting",
      title: labels.supporting,
      stories: rankedStories.filter((item) => item.role === "supporting"),
    },
  ].filter((group) => group.stories.length > 0);
  const ledgerByStory = new Map(
    thesisLedger.map((entry) => [entry.storyId, entry]),
  );

  if (groups.length === 0 && !timeline) return null;

  const statusLabels: Record<WeeklyEventDisplayStatus, string> = {
    scheduled: labels.scheduled,
    awaiting: labels.scheduled,
    realized: "",
    cancelled: labels.cancelled,
    postponed: labels.postponed,
  };

  return (
    <section
      className="hotspot-board pricing-board"
      id="signals"
      aria-labelledby="hotspot-board-title"
    >
      <header className="hotspot-board-heading">
        <span className="section-index">02</span>
        <h2 id="hotspot-board-title">
          {labels.title}
          <small>{market}</small>
        </h2>
      </header>
      <div className="hotspot-groups">
        {timeline && (
          <section className="hotspot-events" data-weekly-events>
            <header>
              <strong>{labels.events}</strong>
            </header>
            {timeline.events.length === 0 ? (
              <p className="hotspot-events-empty" data-weekly-events-empty>
                {labels.noData}
              </p>
            ) : (
              <div className="hotspot-event-grid">
                {timeline.events.map((event) => {
                  const localized = localizedEvent(event, language);
                  const status = safeDisplayStatus(event, language);
                  return (
                    <article
                      className={`hotspot-event hotspot-event-${status}`}
                      data-event-state={status}
                      key={event.id}
                    >
                      <div className="hotspot-event-meta">
                        <time dateTime={event.date}>
                          {eventDate(event.date, language)}
                        </time>
                        <span
                          className={
                            status === "realized"
                              ? `event-impact-tag event-impact-${event.impactTone ?? "neutral"}`
                              : `event-status-tag event-status-${status}`
                          }
                          data-event-impact={
                            status === "realized"
                              ? event.impactTone ?? "neutral"
                              : undefined
                          }
                        >
                          {status === "realized" ? (
                            toneLabel(event.impactTone ?? "neutral", language)
                          ) : (
                            <>
                              <StatusIcon status={status} />
                              {statusLabels[status]}
                            </>
                          )}
                        </span>
                      </div>
                      <h4>{localized.title}</h4>
                      {status !== "realized" && <p>{localized.why}</p>}
                      {status !== "realized" &&
                        event.metrics &&
                        event.metrics.length > 0 && (
                        <div className="event-metrics">
                          {event.metrics.slice(0, 2).map((metric) => (
                            <span key={metric.id}>
                              <b>
                                {language === "en"
                                  ? metric.labelEn ?? metric.label
                                  : metric.label}
                              </b>
                              <i>
                                {metricValue(metric.expected, metric.unit)}
                              </i>
                            </span>
                          ))}
                        </div>
                      )}
                      {status === "realized" && localized.result ? (
                        <div className="hotspot-event-result" data-event-result>
                          <dl>
                            {localized.expectation && (
                              <div>
                                <dt>{labels.expected}</dt>
                                <dd>{localized.expectation}</dd>
                              </div>
                            )}
                            <div>
                              <dt>{labels.actual}</dt>
                              <dd>{localized.result}</dd>
                            </div>
                            {localized.assessment && (
                              <div>
                                <dt>{labels.assessment}</dt>
                                <dd>{localized.assessment}</dd>
                              </div>
                            )}
                            {localized.nextWatch && (
                              <div>
                                <dt>{labels.next}</dt>
                                <dd>{localized.nextWatch}</dd>
                              </div>
                            )}
                          </dl>
                          <div className="hotspot-event-sources">
                            {event.expectationSource && (
                              <a
                                href={event.expectationSource}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {event.expectationSourceLabel ??
                                  labels.expected}
                                <ExternalLink aria-hidden="true" />
                              </a>
                            )}
                            <a
                              href={event.resultSource}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {event.resultSourceLabel ?? event.sourceLabel}
                              <ExternalLink aria-hidden="true" />
                            </a>
                          </div>
                        </div>
                      ) : (
                        <a
                          className="hotspot-event-source"
                          href={event.source}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {event.sourceLabel}
                          <ExternalLink aria-hidden="true" />
                        </a>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {groups.map((group) => (
          <section
            className={`hotspot-group hotspot-group-${group.key}`}
            key={group.key}
          >
            <header>
              <strong>{group.title}</strong>
            </header>
            <ol>
              {group.stories.map(({ number, role, story }) => (
                <li key={story.id}>
                  <details
                    className="hotspot-story"
                    open={role === "core" && number === 1}
                  >
                    <summary>
                      <span className="hotspot-number">
                        {String(number).padStart(2, "0")}
                      </span>
                      <span className="hotspot-title">
                        <strong>{story.title}</strong>
                        <span>
                          <i
                            className={`signal-role signal-role-${role}`}
                          >
                            {role === "core"
                              ? labels.coreSignal
                              : labels.supportingSignal}
                          </i>
                          {story.signal ? (
                            <>
                              <i>
                                {horizonLabel(story.signal.horizon, labels)}
                              </i>
                              <i>
                                {labels.confidence}{" "}
                                {confidenceLabel(
                                  story.signal.confidence,
                                  labels,
                                )}
                              </i>
                            </>
                          ) : (
                            <>
                              <i>{story.categoryLabel}</i>
                              <i>{toneLabel(story.ai.tone, language)}</i>
                            </>
                          )}
                        </span>
                      </span>
                      <a
                        className="hotspot-source"
                        href={story.source}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${labels.source}: ${story.sourceLabel}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span>
                          {story.sourceLabel}
                          {story.evidenceSource && (
                            <small>
                              {sourceTierLabel(
                                story.evidenceSource.tier,
                                labels,
                              )}
                            </small>
                          )}
                        </span>
                        <ExternalLink aria-hidden="true" />
                      </a>
                      <ChevronDown
                        className="hotspot-expand-icon"
                        aria-hidden="true"
                      />
                    </summary>
                    <SignalAnalysis
                      story={story}
                      ledgerEntry={ledgerByStory.get(story.id)}
                      labels={labels}
                      language={language}
                    />
                  </details>
                </li>
              ))}
            </ol>
          </section>
        ))}

      </div>
    </section>
  );
}
