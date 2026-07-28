import { Check, Clock3, ExternalLink, Minus } from "lucide-react";
import type {
  Language,
  WeeklyEventDisplayStatus,
  WeeklyEventTimeline as WeeklyEventTimelineData,
  WeeklyEventTimelineItem,
} from "../types";

interface Props {
  timeline: WeeklyEventTimelineData;
  language: Language;
  labels: {
    title: string;
    eyebrow: string;
    hint: string;
    scheduled: string;
    awaiting: string;
    realized: string;
    cancelled: string;
    postponed: string;
    result: string;
    noData: string;
  };
}

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
  if (status === "realized") return <Check data-event-check aria-hidden="true" />;
  if (status === "cancelled") return <Minus aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

export default function WeeklyEventTimeline({
  timeline,
  language,
  labels,
}: Props) {
  const statusLabels: Record<WeeklyEventDisplayStatus, string> = {
    scheduled: labels.scheduled,
    awaiting: labels.awaiting,
    realized: labels.realized,
    cancelled: labels.cancelled,
    postponed: labels.postponed,
  };

  return (
    <section
      className="week-events"
      data-weekly-events
      aria-labelledby="week-events-title"
    >
      <div className="week-events-heading">
        <div>
          <span className="eyebrow">{labels.eyebrow}</span>
          <h2 id="week-events-title">{labels.title}</h2>
        </div>
        <p>{labels.hint}</p>
      </div>
      {timeline.events.length === 0 ? (
        <p className="week-events-empty" data-weekly-events-empty>
          {labels.noData}
        </p>
      ) : (
        <div className="week-events-grid">
          {timeline.events.map((event) => {
            const localized = localizedEvent(event, language);
            const status = safeDisplayStatus(event, language);
            return (
              <article
                className={`week-event week-event-${status}`}
                data-event-state={status}
                key={event.id}
              >
                <div className="week-event-meta">
                  <time dateTime={event.date}>
                    {eventDate(event.date, language)}
                  </time>
                  <span>
                    <StatusIcon status={status} />
                    {statusLabels[status]}
                  </span>
                </div>
                <h3>{localized.title}</h3>
                <p>{localized.why}</p>
                {status === "realized" && localized.result && (
                  <div className="week-event-result" data-event-result>
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
                )}
                {status !== "realized" && (
                  <a
                    className="week-event-source"
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
  );
}
