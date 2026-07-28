import { ChevronDown, ExternalLink } from "lucide-react";
import CopyButton from "./components/CopyButton";
import DailyStory from "./components/DailyStory";
import DateNavigator from "./components/DateNavigator";
import HeaderActions from "./components/HeaderActions";
import MarketHeatHistory from "./components/MarketHeatHistory";
import {
  copy,
  formatDate,
  formatMarketDate,
  formatMarketUpdateTime,
  formatTemplate,
  formatWeekday,
  localizeDailyReport,
  localizeWeeklyReport,
  marketTrendLabel,
  toneLabel,
} from "./lib/i18n";
import type {
  DailyReport,
  Language,
  MarketRegion,
  ReportListItem,
  SectorHeatView,
  WeeklyListItem,
  WeeklyReport,
} from "./types";

interface CommonPageData {
  language: Language;
  requestUrl: string;
}

export interface DailyPageData extends CommonPageData {
  kind: "daily";
  market: MarketRegion;
  report: DailyReport;
  archive: ReportListItem[];
  sectorHeat: SectorHeatView;
}

export interface WeeklyPageData extends CommonPageData {
  kind: "weekly";
  report: WeeklyReport | null;
  archive: WeeklyListItem[];
}

export type PageData = DailyPageData | WeeklyPageData;

function buildLanguageHref(data: PageData) {
  const url = new URL(data.requestUrl);
  url.searchParams.set("lang", data.language === "zh" ? "en" : "zh");
  return `${url.pathname}${url.search}${url.hash}`;
}

function buildMarketHref(data: DailyPageData, market: MarketRegion) {
  const url = new URL(data.requestUrl);
  url.searchParams.set("market", market.toLowerCase());
  return `${url.pathname}${url.search}${url.hash}`;
}

function AppHeader({ data }: { data: PageData }) {
  const t = copy[data.language];
  const dailyActive = data.kind === "daily";
  const dailyHref =
    data.kind === "daily"
      ? `/?lang=${data.language}&market=${data.market.toLowerCase()}`
      : `/?lang=${data.language}`;
  const weeklyHref = `/weekly?lang=${data.language}`;
  const archiveHref = dailyActive ? "#archive" : `${dailyHref}#archive`;

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <a
          className="brand"
          href={dailyHref}
          aria-label="Stock Daily"
        >
          <span className="brand-mark" aria-hidden="true">
            SD
          </span>
          <span className="brand-copy">
            <strong>Stock Daily</strong>
            <span>{t.tagline}</span>
          </span>
        </a>
        <div className="header-navigation">
          <nav
            className="main-nav"
            aria-label={data.language === "zh" ? "主导航" : "Main"}
          >
            <a
              className={dailyActive ? "active" : undefined}
              href={dailyHref}
            >
              {t.daily}
            </a>
            <a
              className={!dailyActive ? "active" : undefined}
              href={weeklyHref}
            >
              {t.weekly}
            </a>
            <a href={archiveHref}>
              {t.archive}
            </a>
          </nav>
          <HeaderActions
            languageHref={buildLanguageHref(data)}
            languageLabel={t.language}
            darkLabel={t.themeDark}
            lightLabel={t.themeLight}
            market={data.kind === "daily" ? data.market : undefined}
            marketLabel={t.marketSwitch}
            cnHref={
              data.kind === "daily" ? buildMarketHref(data, "CN") : undefined
            }
            usHref={
              data.kind === "daily" ? buildMarketHref(data, "US") : undefined
            }
            mobileMenu={{
              menuLabel: t.menu,
              closeLabel: t.closeMenu,
              navigationLabel: t.navigation,
              preferencesLabel: t.preferences,
              languageSettingLabel: t.languageSetting,
              appearanceSettingLabel: t.appearanceSetting,
              darkModeLabel: t.darkMode,
              lightModeLabel: t.lightMode,
              dailyLabel: t.daily,
              weeklyLabel: t.weekly,
              archiveLabel: t.archive,
              dailyHref,
              weeklyHref,
              archiveHref,
              active: dailyActive ? "daily" : "weekly",
            }}
          />
        </div>
      </div>
    </header>
  );
}

function AppFooter({ language }: { language: Language }) {
  const t = copy[language];
  return (
    <footer>
      <div className="footer-inner">
        <p>
          <strong>Stock Daily</strong>
          <span>{t.footerLine}</span>
        </p>
        <nav aria-label={language === "zh" ? "页脚导航" : "Footer"}>
          <a href="/api/health" target="_blank" rel="noreferrer">
            {t.status}
          </a>
          <span>{t.disclaimer}</span>
        </nav>
      </div>
    </footer>
  );
}

function OverviewCard({
  overview,
  language,
  weekly = false,
}: {
  overview: ReturnType<typeof localizeDailyReport>["overview"];
  language: Language;
  weekly?: boolean;
}) {
  const t = copy[language];
  return (
    <aside
      className={`thesis-card${weekly ? " weekly-overview" : ""}`}
      aria-label={t.agentOverview}
    >
      <div className="thesis-heading">
        <span className="eyebrow">
          {weekly ? t.agentOverview : t.agentOverviewEyebrow}
        </span>
        <span className={`impact-badge impact-badge-${overview.tone}`}>
          {toneLabel(overview.tone, language)}
        </span>
      </div>
      {!weekly && <h2>{t.agentOverview}</h2>}
      <p>{overview.interpretation}</p>
      {(overview.positive.length > 0 || overview.negative.length > 0) && (
        <div className="overview-impact-grid">
          {overview.positive.length > 0 && (
            <div>
              <strong>{t.favorable}</strong>
              <span>
                {overview.positive.map((item) => (
                  <i key={item}>{item}</i>
                ))}
              </span>
            </div>
          )}
          {overview.negative.length > 0 && (
            <div>
              <strong>{t.adverse}</strong>
              <span>
                {overview.negative.map((item) => (
                  <i key={item}>{item}</i>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function DailyPage({ data }: { data: DailyPageData }) {
  const { language } = data;
  const t = copy[language];
  const report = localizeDailyReport(data.report, language);
  const marketView = report.marketViews[data.market];
  const marketMetrics = report.markets.filter(
    (market) => market.region === data.market,
  );
  const marketStories = report.stories.filter((story) =>
    story.regions.includes(data.market),
  );
  const displayArchive = data.archive.map((item) => {
    const marketArchive = item.marketViews?.[data.market];
    return {
      ...item,
      title:
        language === "en"
          ? marketArchive?.titleEn ??
            item.titleEn ??
            marketArchive?.title ??
            item.title
          : marketArchive?.title ?? item.title,
      summary:
        language === "en"
          ? marketArchive?.summaryEn ??
            item.summaryEn ??
            marketArchive?.summary ??
            item.summary
          : marketArchive?.summary ?? item.summary,
      signalCount:
        item.marketSignalCounts?.[data.market] ?? item.signalCount,
      tone: marketArchive?.tone,
      trend: marketArchive?.trend,
    };
  });
  const archiveIndex = displayArchive.findIndex(
    (item) => item.reportDate === report.reportDate,
  );
  const otherEditions = displayArchive
    .filter((item) => item.reportDate !== report.reportDate)
    .slice(0, 6);
  const visibleStories = marketStories.slice(0, 3);
  const remainingStories = marketStories.slice(3);
  const marketAsOf =
    report.marketAsOf?.[data.market] ??
    report.sectorHeat.find((sector) => sector.market === data.market)?.asOf;
  const marketUpdatedLabel = formatTemplate(t.marketUpdatedAt, {
    time: formatMarketUpdateTime(report.generatedAt, language),
  });
  const marketAsOfLabel = marketAsOf
    ? formatTemplate(t.marketAsOf, {
        market: data.market,
        date: formatMarketDate(marketAsOf, language),
      })
    : "";
  const copyText = `Stock Daily | ${formatDate(report.reportDate, language)}
${marketView.headline}
${marketView.overview.interpretation}
${marketUpdatedLabel}
${marketAsOfLabel}
${t.disclaimer}`;

  return (
    <div className="page-shell" data-render="ssr">
      <section className="report-toolbar" aria-label={t.selectDate}>
        <DateNavigator
          archive={displayArchive}
          selectedDate={report.reportDate}
          language={language}
          selectLabel={t.selectDate}
          newerLabel={t.newer}
          olderLabel={t.older}
        />
      </section>

      <article className="hero">
        <div className="hero-copy">
          <div className="edition-row">
            <span className="edition-label">
              {archiveIndex === 0 ? t.latest : t.history}
            </span>
            <span>
              {formatTemplate(t.edition, {
                edition: String(report.edition).padStart(2, "0"),
              })}
            </span>
            {report.isSample && <span className="sample-badge">{t.sample}</span>}
          </div>
          <p className="kicker">
            {formatWeekday(report.reportDate, language)} · {t.kicker}
          </p>
          <h1>{marketView.headline}</h1>
          <p className="hero-summary">{marketView.summary}</p>
          <div className="publish-row">
            <div className="market-freshness">
              <time dateTime={report.generatedAt}>{marketUpdatedLabel}</time>
              {marketAsOf && (
                <span data-market-as-of={marketAsOf}>{marketAsOfLabel}</span>
              )}
            </div>
            <CopyButton
              text={copyText}
              label={t.copy}
              copiedLabel={t.copied}
            />
          </div>
        </div>
        <OverviewCard overview={marketView.overview} language={language} />
      </article>

      <section className="market-section" aria-labelledby="market-title">
        <div className="section-intro">
          <span className="section-index">01</span>
          <div>
            <span className="eyebrow">{t.marketEyebrow}</span>
            <h2 id="market-title">
              {t.market}
              <small>{data.market}</small>
            </h2>
          </div>
          <p>{t.marketHint}</p>
        </div>
        <MarketHeatHistory
          view={data.sectorHeat}
          market={data.market}
          language={language}
          labels={{
            title: t.sectorHeat,
            range: t.heatRange,
            streakTitle: t.heatStreak,
            streakDays: t.heatStreakDays,
            noStreak: t.noHeatStreak,
          }}
        />
        <p className="market-price-heading">{t.currentMarkets}</p>
        <div
          className={`market-grid${
            marketMetrics.length === 4
              ? " market-grid-four"
              : marketMetrics.length === 2
                ? " market-grid-two"
                : ""
          }`}
        >
          {marketMetrics.map((market) => (
            <article
              className={`market-item market-item-${market.direction}`}
              key={market.symbol ?? market.name}
            >
              <div>
                <span>{market.name}</span>
                <small>{market.note}</small>
              </div>
              <strong>{market.value}</strong>
              <em>{market.change}</em>
            </article>
          ))}
        </div>
      </section>

      <section id="signals" className="signals-section">
        <div className="section-intro">
          <span className="section-index">02</span>
          <div>
            <span className="eyebrow">{t.signalsEyebrow}</span>
            <h2>
              {t.signals}
              <small>{data.market}</small>
            </h2>
          </div>
          <p>{t.signalsHint}</p>
        </div>
        <div className="signal-list">
          {visibleStories.map((story, index) => (
            <DailyStory
              story={story}
              number={index + 1}
              language={language}
              labels={{
                aiRead: t.aiRead,
                impact: t.impact,
                priority: t.priority,
                proof: t.proof,
              }}
              key={story.id}
            />
          ))}
        </div>
        {marketStories.length === 0 && (
          <p className="empty-market-news">{t.noMarketNews}</p>
        )}
        {remainingStories.length > 0 && (
          <details className="remaining-signals">
            <summary>
              <span className="remaining-open-label">
                {formatTemplate(t.remaining, {
                  count: remainingStories.length,
                })}
              </span>
              <span className="remaining-close-label">{t.collapse}</span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <div className="signal-list">
              {remainingStories.map((story, index) => (
                <DailyStory
                  story={story}
                  number={index + 4}
                  language={language}
                  labels={{
                    aiRead: t.aiRead,
                    impact: t.impact,
                    priority: t.priority,
                    proof: t.proof,
                  }}
                  key={story.id}
                />
              ))}
            </div>
          </details>
        )}
      </section>

      <section id="archive" className="archive-section">
        <div className="section-intro">
          <span className="section-index">03</span>
          <div>
            <span className="eyebrow">{t.previousEyebrow}</span>
            <h2>{t.previous}</h2>
          </div>
          <p>{t.previousHint}</p>
        </div>
        <div className="archive-list">
          {otherEditions.map((edition) => (
            <a
              href={`/?date=${edition.reportDate}&lang=${language}&market=${data.market.toLowerCase()}`}
              key={edition.reportDate}
            >
              <span className="archive-edition">
                {formatTemplate(t.edition, {
                  edition: String(edition.edition).padStart(2, "0"),
                })}
              </span>
              <div className="archive-entry-main">
                <strong>{edition.title}</strong>
                <div className="archive-tags">
                  {edition.tone && (
                    <span
                      className={`archive-tag archive-tone-${edition.tone}`}
                    >
                      {formatTemplate(t.overallTone, {
                        tone: toneLabel(edition.tone, language),
                      })}
                    </span>
                  )}
                  {edition.trend && (
                    <span
                      className={`archive-tag archive-trend-${edition.trend}`}
                    >
                      {marketTrendLabel(edition.trend, language)}
                    </span>
                  )}
                  <i className="archive-count">
                    {formatTemplate(t.newsCount, {
                      count: edition.signalCount,
                    })}
                  </i>
                </div>
              </div>
              <time dateTime={edition.reportDate}>
                {edition.reportDate.slice(5).replace("-", ".")}
              </time>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function WeeklyPage({ data }: { data: WeeklyPageData }) {
  const { language } = data;
  const t = copy[language];
  const report = data.report
    ? localizeWeeklyReport(data.report, language)
    : null;

  if (!report) {
    return (
      <div className="page-shell weekly-shell" data-render="ssr">
        <section className="empty-weekly">
          <span className="eyebrow">{t.weeklyEyebrow}</span>
          <h1>{t.weeklyTitle}</h1>
          <p>{t.noWeekly}</p>
          <a href={`/?lang=${language}`}>{t.daily}</a>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell weekly-shell" data-render="ssr">
      <article className="weekly-hero">
        <div>
          <span className="eyebrow">{t.weeklyEyebrow}</span>
          <p className="weekly-range">
            {formatDate(report.weekStart, language)} —{" "}
            {formatDate(report.weekEnd, language)}
          </p>
          <h1>{report.headline}</h1>
          <p>{report.summary}</p>
        </div>
        <OverviewCard
          overview={report.overview}
          language={language}
          weekly
        />
      </article>

      <section className="weekly-section">
        <div className="section-intro compact">
          <span className="section-index">01</span>
          <h2>{t.weeklyHighlights}</h2>
        </div>
        <ol className="weekly-highlights">
          {report.highlights.map((highlight) => (
            <li key={highlight}>{highlight}</li>
          ))}
        </ol>
      </section>

      <section className="weekly-section">
        <div className="section-intro compact">
          <span className="section-index">02</span>
          <h2>{t.weeklyOutlook}</h2>
        </div>
        <div className="scenario-grid">
          <article>
            <span>{t.baseCase}</span>
            <p>{report.outlook.base}</p>
          </article>
          <article>
            <span>{t.upsideCase}</span>
            <p>{report.outlook.upside}</p>
          </article>
          <article>
            <span>{t.downsideCase}</span>
            <p>{report.outlook.downside}</p>
          </article>
        </div>
      </section>

      <section className="weekly-section">
        <div className="section-intro compact">
          <span className="section-index">03</span>
          <h2>{t.upcoming}</h2>
        </div>
        <div className="event-list">
          {report.events.map((event) => (
            <article key={`${event.date}-${event.title}`}>
              <time dateTime={event.date}>{event.date.slice(5)}</time>
              <div>
                <h3>{event.title}</h3>
                <p>{event.whyItMatters}</p>
                <a href={event.source} target="_blank" rel="noreferrer">
                  {event.sourceLabel}
                  <ExternalLink aria-hidden="true" />
                </a>
              </div>
            </article>
          ))}
        </div>
      </section>

      {data.archive.length > 1 && (
        <nav className="weekly-archive" aria-label={t.archive}>
          {data.archive
            .filter((item) => item.weekEnd !== report.weekEnd)
            .map((item) => (
              <a
                href={`/weekly?week=${item.weekEnd}&lang=${language}`}
                key={item.weekEnd}
              >
                <time dateTime={item.weekEnd}>{item.weekEnd}</time>
                <strong>
                  {language === "en"
                    ? item.headlineEn ?? item.headline
                    : item.headline}
                </strong>
              </a>
            ))}
        </nav>
      )}
    </div>
  );
}

function pageMetadata(data: PageData) {
  if (data.kind === "daily") {
    const report = localizeDailyReport(data.report, data.language);
    const view = report.marketViews[data.market];
    return {
      title: `${view.headline} | Stock Daily`,
      description: view.summary,
    };
  }
  const report = data.report
    ? localizeWeeklyReport(data.report, data.language)
    : null;
  return {
    title: report
      ? `${report.headline} | Stock Daily Weekly`
      : `${copy[data.language].weeklyTitle} | Stock Daily`,
    description: report?.summary ?? copy[data.language].noWeekly,
  };
}

function serializePageData(data: PageData) {
  return JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export default function Document({ data }: { data: PageData }) {
  const t = copy[data.language];
  const metadata = pageMetadata(data);
  const canonical = data.requestUrl;

  return (
    <html
      lang={data.language === "zh" ? "zh-CN" : "en"}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#f5f0e6" />
        <meta name="description" content={metadata.description} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Stock Daily" />
        <meta property="og:title" content={metadata.title} />
        <meta property="og:description" content={metadata.description} />
        <meta property="og:url" content={canonical} />
        <meta
          property="og:image"
          content="https://stock-daily-4ip.pages.dev/og.png"
        />
        <link rel="canonical" href={canonical} />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="icon" href="/og.png" type="image/png" />
        <link rel="stylesheet" href="/static/client.css" />
        <title>{metadata.title}</title>
        <script
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{const s=localStorage.getItem("stock-daily-theme");document.documentElement.dataset.theme=s||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch{}})()`,
          }}
        />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          {t.skip}
        </a>
        <AppHeader data={data} />
        <main id="main-content">
          {data.kind === "daily" ? (
            <DailyPage data={data} />
          ) : (
            <WeeklyPage data={data} />
          )}
        </main>
        <AppFooter language={data.language} />
        <script
          id="stock-daily-data"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: serializePageData(data) }}
        />
        <script type="module" src="/static/client.js" />
      </body>
    </html>
  );
}
