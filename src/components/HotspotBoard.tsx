import { ExternalLink } from "lucide-react";
import { toneLabel } from "../lib/i18n";
import type { Language, Story, StoryCategory } from "../types";

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
  language: Language;
  labels: {
    title: string;
    eyebrow: string;
    hint: string;
    top: string;
    topEyebrow: string;
    macro: string;
    macroEyebrow: string;
    company: string;
    companyEyebrow: string;
    industry: string;
    industryEyebrow: string;
    source: string;
  };
}

interface HotspotGroup {
  key: "top" | "macro" | "company" | "industry";
  title: string;
  eyebrow: string;
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

export default function HotspotBoard({
  stories,
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
      eyebrow: labels.topEyebrow,
      stories: rankedStories.slice(0, 3),
    },
    {
      key: "macro",
      title: labels.macro,
      eyebrow: labels.macroEyebrow,
      stories: groupedStories.macro,
    },
    {
      key: "company",
      title: labels.company,
      eyebrow: labels.companyEyebrow,
      stories: groupedStories.company,
    },
    {
      key: "industry",
      title: labels.industry,
      eyebrow: labels.industryEyebrow,
      stories: groupedStories.industry,
    },
  ];
  const groups = allGroups.filter((group) => group.stories.length > 0);

  if (groups.length === 0) return null;

  function revealStory(storyId: string) {
    const storyElement = document.getElementById(`story-${storyId}`);
    const collapsedGroup = storyElement?.closest("details");
    if (collapsedGroup instanceof HTMLDetailsElement) {
      collapsedGroup.open = true;
    }
  }

  return (
    <section className="hotspot-board" aria-labelledby="hotspot-board-title">
      <header className="hotspot-board-heading">
        <div>
          <span className="eyebrow">{labels.eyebrow}</span>
          <h3 id="hotspot-board-title">{labels.title}</h3>
        </div>
        <p>{labels.hint}</p>
      </header>
      <div className="hotspot-groups">
        {groups.map((group) => (
          <section
            className={`hotspot-group hotspot-group-${group.key}`}
            key={group.key}
          >
            <header>
              <strong>{group.title}</strong>
              <span>{group.eyebrow}</span>
            </header>
            <ol>
              {group.stories.map(({ number, story }) => (
                <li key={story.id}>
                  <span className="hotspot-number">
                    {String(number).padStart(2, "0")}
                  </span>
                  <a
                    className="hotspot-title"
                    href={`#story-${story.id}`}
                    onClick={() => revealStory(story.id)}
                    aria-label={`${story.title} — ${toneLabel(
                      story.ai.tone,
                      language,
                    )}`}
                  >
                    <strong>{story.title}</strong>
                    <span>
                      <i
                        className={`hotspot-tone hotspot-tone-${story.ai.tone}`}
                      >
                        {toneLabel(story.ai.tone, language)}
                      </i>
                      <i>{story.categoryLabel}</i>
                    </span>
                  </a>
                  <a
                    className="hotspot-source"
                    href={story.source}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${labels.source}: ${story.sourceLabel}`}
                  >
                    <span>{story.sourceLabel}</span>
                    <ExternalLink aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}
