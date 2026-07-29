import { ChevronDown, ExternalLink, Sparkles } from "lucide-react";
import { formatTemplate, toneLabel } from "../lib/i18n";
import type { Language, Story } from "../types";

interface LocalizedStory extends Story {
  categoryLabel: string;
  ai: NonNullable<Story["ai"]>;
}

interface Props {
  story: LocalizedStory;
  number: number;
  anchorId: string;
  language: Language;
  labels: {
    aiRead: string;
    impact: string;
    priority: string;
    proof: string;
  };
}

export default function DailyStory({
  story,
  number,
  anchorId,
  language,
  labels,
}: Props) {
  return (
    <article className="signal-row" id={anchorId}>
      <div className="signal-body">
        <div className="signal-meta">
          <span className="signal-number">
            {String(number).padStart(2, "0")}
          </span>
          <span className={`impact-badge impact-badge-${story.ai.tone}`}>
            {toneLabel(story.ai.tone, language)}
          </span>
          <span className="category">{story.categoryLabel}</span>
          <span className="importance">
            {formatTemplate(labels.priority, { value: story.importance })}
          </span>
        </div>
        <h3>{story.title}</h3>
        <p>{story.summary}</p>
        <div className="ai-insight">
          <div className="ai-insight-heading">
            <Sparkles aria-hidden="true" />
            <span>{labels.aiRead}</span>
          </div>
          <p>{story.ai.interpretation}</p>
        </div>
        <div className="impact-tags" aria-label={labels.impact}>
          <span className="impact-tags-label">{labels.impact}</span>
          {story.ai.sectors.map((sector) => (
            <span className="sector-tag" key={sector}>
              {sector}
            </span>
          ))}
          {story.ai.tickers.map((ticker) => (
            <span className="ticker-tag" key={ticker}>
              {ticker}
            </span>
          ))}
        </div>
        <div className="signal-actions">
          <details className="signal-proof">
            <summary>
              {labels.proof}
              <ChevronDown aria-hidden="true" />
            </summary>
            <p>{story.evidence}</p>
          </details>
          <a href={story.source} target="_blank" rel="noreferrer">
            {story.sourceLabel}
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </div>
    </article>
  );
}
