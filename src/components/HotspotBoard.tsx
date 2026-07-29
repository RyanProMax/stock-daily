import {
  Check,
  ChevronDown,
  Clock3,
  ExternalLink,
  Minus,
} from "lucide-react";
import { formatTemplate, toneLabel } from "../lib/i18n";
import type {
  Language,
  Story,
  StoryCategory,
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
  story: LocalizedStory;
}

interface Props {
  stories: LocalizedStory[];
  timeline: WeeklyEventTimeline | null;
  market: string;
  language: Language;
  labels: {
    title: string;
    events: string;
    top: string;
    macro: string;
    company: string;
    industry: string;
    source: string;
    facts: string;
    logic: string;
    impact: string;
    priority: string;
    proof: string;
    scheduled: string;
    awaiting: string;
    realized: string;
    cancelled: string;
    postponed: string;
    result: string;
    noData: string;
  };
}

interface HotspotGroup {
  key: "top" | "macro" | "company" | "industry";
  title: string;
  stories: RankedStory[];
}

const remainingGroupByCategory: Record<
  StoryCategory,
  "macro" | "company" | "industry"
> = {
  宏观: "macro",
  公司: "company",
  行业: "industry",
  商品: "industry",
};

function eventDate(date: string, language: Language) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: language === "zh" ? "numeric" : "short",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${date}T00:00:00+08:00`));
}

function localizedEvent(
  event: WeeklyEventTimelineItem,
  language: Language,
) {
  return {
    title: language === "en" ? event.titleEn ?? event.title : event.title,
    why:
      language === "en"
        ? event.whyItMattersEn ?? event.whyItMatters
        : event.whyItMatters,
    result: language === "en" ? event.resultEn ?? event.result : event.result,
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
  if (status === "realized") {
    return <Check data-event-check aria-hidden="true" />;
  }
  if (status === "cancelled") return <Minus aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

export default function HotspotBoard({
  stories,
  timeline,
  market,
  language,
  labels,
}: Props) {
  const rankedStories = stories.map((story, index) => ({
    number: index + 1,
    story,
  }));
  const groupedStories = {
    macro: [] as RankedStory[],
    company: [] as RankedStory[],
    industry: [] as RankedStory[],
  };

  for (const rankedStory of rankedStories.slice(3)) {
    groupedStories[remainingGroupByCategory[rankedStory.story.category]].push(
      rankedStory,
    );
  }

  const allGroups: HotspotGroup[] = [
    {
      key: "top",
      title: labels.top,
      stories: rankedStories.slice(0, 3),
    },
    {
      key: "macro",
      title: labels.macro,
      stories: groupedStories.macro,
    },
    {
      key: "company",
      title: labels.company,
      stories: groupedStories.company,
    },
    {
      key: "industry",
      title: labels.industry,
      stories: groupedStories.industry,
    },
  ];
  const groups = allGroups.filter((group) => group.stories.length > 0);

  if (groups.length === 0 && !timeline) return null;

  const statusLabels: Record<WeeklyEventDisplayStatus, string> = {
    scheduled: labels.scheduled,
    awaiting: labels.awaiting,
    realized: labels.realized,
    cancelled: labels.cancelled,
    postponed: labels.postponed,
  };

  return (
    <section
      className="hotspot-board"
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
                        <span>
                          <StatusIcon status={status} />
                          {statusLabels[status]}
                        </span>
                      </div>
                      <h4>{localized.title}</h4>
                      <p>{localized.why}</p>
                      {status === "realized" && localized.result ? (
                        <div
                          className="hotspot-event-result"
                          data-event-result
                        >
                          <strong>{labels.result}</strong>
                          <p>{localized.result}</p>
                          <a
                            href={event.resultSource}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {event.resultSourceLabel ?? event.sourceLabel}
                            <ExternalLink aria-hidden="true" />
                          </a>
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
            <ol start={group.stories[0]?.number}>
              {group.stories.map(({ number, story }) => (
                <li key={story.id}>
                  <details
                    className="hotspot-story"
                    open={group.key === "top" && number === 1}
                  >
                    <summary>
                      <span className="hotspot-number">
                        {String(number).padStart(2, "0")}
                      </span>
                      <span className="hotspot-title">
                        <strong>{story.title}</strong>
                        <span>
                          <i
                            className={`hotspot-tone hotspot-tone-${story.ai.tone}`}
                          >
                            {toneLabel(story.ai.tone, language)}
                          </i>
                          <i>{story.categoryLabel}</i>
                          <i>
                            {formatTemplate(labels.priority, {
                              value: story.importance,
                            })}
                          </i>
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
                        <span>{story.sourceLabel}</span>
                        <ExternalLink aria-hidden="true" />
                      </a>
                      <ChevronDown
                        className="hotspot-expand-icon"
                        aria-hidden="true"
                      />
                    </summary>
                    <div
                      className="hotspot-analysis"
                      id={`story-${story.id}`}
                    >
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
