import type {
  DailyReport,
  ImpactTone,
  Language,
  MarketOverview,
  MarketRegion,
  MarketTrend,
  StoryCategory,
  WeeklyReport,
} from "../types";

export const copy = {
  zh: {
    skip: "跳到正文",
    tagline: "跨市场研究备忘录",
    daily: "日报",
    weekly: "周报",
    archive: "往期",
    themeDark: "切换到深色模式",
    themeLight: "切换到浅色模式",
    language: "Switch to English",
    menu: "菜单",
    closeMenu: "关闭菜单",
    navigation: "内容导航",
    preferences: "显示设置",
    languageSetting: "语言",
    appearanceSetting: "外观",
    darkMode: "深色模式",
    lightMode: "浅色模式",
    marketSwitch: "切换市场",
    cnTab: "中国市场",
    usTab: "美国市场",
    database: "数据库已连接",
    latest: "今日简报",
    history: "历史简报",
    edition: "第 {edition} 期",
    sample: "演示数据",
    kicker: "本期必须知道的市场变量",
    dataCut: "数据截止",
    copy: "复制摘要",
    copied: "已复制",
    agentOverview: "AI 总览",
    agentOverviewEyebrow: "Agent overview",
    favorable: "主要利好",
    adverse: "主要利空",
    market: "市场状态",
    marketEyebrow: "Market pulse",
    marketHint: "本页仅展示当前市场的指数与一级行业强弱。",
    sectorHeat: "板块热度",
    heatRange: "价格波动强度 · 0–100",
    heatStreak: "连续高热",
    heatStreakDays: "连续 {count} 个交易日",
    noHeatStreak: "暂无连续两个交易日高热的板块",
    currentMarkets: "主要行情",
    marketUpdatedAt: "市场信息更新于 {time}（北京时间）",
    marketAsOfToday: "{market}数据截至今天（{date}）收盘",
    marketAsOfYesterday: "{market}数据截至昨天（{date}）收盘",
    marketAsOfLatest: "{market}数据截至最近交易日（{date}）收盘",
    weekEvents: "本周关键事件",
    weekEventsEyebrow: "Event realization",
    weekEventsHint: "按公布日跟踪；只有结果经来源核验后才标记兑现。",
    eventScheduled: "待公布",
    eventAwaiting: "结果待核验",
    eventRealized: "已兑现",
    eventCancelled: "已取消",
    eventPostponed: "已延期",
    eventResult: "兑现结果",
    eventNoData: "本周暂无关键事件。",
    signals: "重点新闻",
    signalsEyebrow: "Market moving news",
    signalsHint: "方向、对象与依据分开标注。",
    aiRead: "AI 解读",
    impact: "影响",
    priority: "优先级 {value}/5",
    proof: "查看依据",
    remaining: "其余 {count} 条信号",
    collapse: "收起信号",
    previous: "其他日报",
    previousEyebrow: "Previous editions",
    previousHint: "按日期回看。",
    overallTone: "整体{tone}",
    newsCount: "{count} 条新闻",
    newer: "查看更新一期",
    older: "查看更早一期",
    selectDate: "选择日报日期",
    footerLine: "事实、价格与判断分开记录。",
    status: "服务状态",
    disclaimer: "仅作信息整理，不构成投资建议。",
    weeklyTitle: "本周复盘",
    weeklyEyebrow: "Weekly intelligence",
    weeklyHighlights: "一周脉络",
    weeklyOutlook: "下周推演",
    baseCase: "基准情景",
    upsideCase: "上行情景",
    downsideCase: "下行情景",
    upcoming: "未来一周关键事件",
    noWeekly: "首份周报将在周日晚上生成。",
    noMarketNews: "本期暂无该市场的已核验新闻。",
  },
  en: {
    skip: "Skip to content",
    tagline: "Cross-market research memo",
    daily: "Daily",
    weekly: "Weekly",
    archive: "Archive",
    themeDark: "Switch to dark mode",
    themeLight: "Switch to light mode",
    language: "切换到中文",
    menu: "Menu",
    closeMenu: "Close menu",
    navigation: "Navigation",
    preferences: "Display settings",
    languageSetting: "Language",
    appearanceSetting: "Appearance",
    darkMode: "Dark mode",
    lightMode: "Light mode",
    marketSwitch: "Switch market",
    cnTab: "China market",
    usTab: "U.S. market",
    database: "Database connected",
    latest: "Latest brief",
    history: "Archive brief",
    edition: "Edition {edition}",
    sample: "Sample data",
    kicker: "Market variables that define this edition",
    dataCut: "Data through",
    copy: "Copy summary",
    copied: "Copied",
    agentOverview: "AI Overview",
    agentOverviewEyebrow: "Agent overview",
    favorable: "Favorable for",
    adverse: "Adverse for",
    market: "Market Pulse",
    marketEyebrow: "Market pulse",
    marketHint: "Only indexes and level-one sectors for this market are shown.",
    sectorHeat: "Sector Heat",
    heatRange: "Price-move intensity · 0–100",
    heatStreak: "Sustained Heat",
    heatStreakDays: "{count} trading days",
    noHeatStreak: "No sector has stayed hot for two trading days.",
    currentMarkets: "Key Market Data",
    marketUpdatedAt: "Market info updated {time} (Beijing time)",
    marketAsOfToday: "{market} data through today's close ({date})",
    marketAsOfYesterday: "{market} data through yesterday's close ({date})",
    marketAsOfLatest: "{market} data through the latest trading-day close ({date})",
    weekEvents: "This Week's Key Events",
    weekEventsEyebrow: "Event realization",
    weekEventsHint:
      "Tracked by release date; an event is realized only after its result is source-verified.",
    eventScheduled: "Scheduled",
    eventAwaiting: "Result pending verification",
    eventRealized: "Realized",
    eventCancelled: "Cancelled",
    eventPostponed: "Postponed",
    eventResult: "Realized result",
    eventNoData: "No key events are scheduled this week.",
    signals: "Market-moving News",
    signalsEyebrow: "Market moving news",
    signalsHint: "Direction, exposure and evidence are separated.",
    aiRead: "AI Interpretation",
    impact: "Impact",
    priority: "Priority {value}/5",
    proof: "View evidence",
    remaining: "{count} more signals",
    collapse: "Collapse signals",
    previous: "Other Editions",
    previousEyebrow: "Previous editions",
    previousHint: "Browse by date.",
    overallTone: "Overall {tone}",
    newsCount: "{count} stories",
    newer: "View newer edition",
    older: "View older edition",
    selectDate: "Select report date",
    footerLine: "Facts, prices and interpretation are recorded separately.",
    status: "Service status",
    disclaimer: "For information only. Not investment advice.",
    weeklyTitle: "Weekly Review",
    weeklyEyebrow: "Weekly intelligence",
    weeklyHighlights: "The Week in Context",
    weeklyOutlook: "Next-week Scenarios",
    baseCase: "Base case",
    upsideCase: "Upside case",
    downsideCase: "Downside case",
    upcoming: "Key Events Next Week",
    noWeekly: "The first weekly report will be generated on Sunday evening.",
    noMarketNews: "No verified news is available for this market in this edition.",
  },
} as const;

const categoryLabels: Record<Language, Record<StoryCategory, string>> = {
  zh: { 公司: "公司", 宏观: "宏观", 商品: "商品", 行业: "行业" },
  en: { 公司: "Company", 宏观: "Macro", 商品: "Commodity", 行业: "Sector" },
};

const toneLabels: Record<Language, Record<ImpactTone, string>> = {
  zh: {
    positive: "利好",
    negative: "利空",
    mixed: "分化",
    neutral: "中性",
  },
  en: {
    positive: "Positive",
    negative: "Negative",
    mixed: "Mixed",
    neutral: "Neutral",
  },
};

const marketTrendLabels: Record<Language, Record<MarketTrend, string>> = {
  zh: {
    up: "大盘上涨",
    down: "大盘下跌",
    mixed: "大盘分化",
    flat: "大盘持平",
  },
  en: {
    up: "Indexes up",
    down: "Indexes down",
    mixed: "Indexes mixed",
    flat: "Indexes flat",
  },
};

const marketNames: Record<string, Record<Language, string>> = {
  SPX: { zh: "标普 500", en: "S&P 500" },
  IXIC: { zh: "纳斯达克", en: "NASDAQ" },
  DJI: { zh: "道琼斯", en: "DOW" },
  DGS10: { zh: "美国 10Y", en: "US 10Y" },
  SSE: { zh: "上证指数", en: "SSE Composite" },
  CSI300: { zh: "沪深 300", en: "CSI 300" },
};

export function resolveLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "zh";
}

export function formatTemplate(
  value: string,
  replacements: Record<string, string | number>,
) {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) =>
      result.replace(`{${key}}`, String(replacement)),
    value,
  );
}

export function normalizeOverview(report: DailyReport): MarketOverview {
  if (!Array.isArray(report.overview)) return report.overview;
  return {
    tone: "mixed",
    interpretation: report.overview.join(" "),
    positive: [],
    negative: [],
  };
}

export function localizeDailyReport(report: DailyReport, language: Language) {
  const overview = normalizeOverview(report);
  const translation = language === "en" ? report.translations?.en : undefined;
  const marketViews = Object.fromEntries(
    (["CN", "US"] as MarketRegion[]).map((market) => {
      const view = report.marketViews[market];
      const translatedView = translation?.marketViews?.[market];
      return [
        market,
        {
          headline: translatedView?.headline ?? view.headline,
          summary: translatedView?.summary ?? view.summary,
          overview: {
            tone: view.overview.tone,
            interpretation:
              translatedView?.overview.interpretation ??
              view.overview.interpretation,
            positive:
              translatedView?.overview.positive ?? view.overview.positive,
            negative:
              translatedView?.overview.negative ?? view.overview.negative,
          },
        },
      ];
    }),
  ) as DailyReport["marketViews"];

  return {
    ...report,
    headline: translation?.headline ?? report.headline,
    summary: translation?.summary ?? report.summary,
    overview: {
      tone: overview.tone,
      interpretation:
        translation?.overview.interpretation ?? overview.interpretation,
      positive: translation?.overview.positive ?? overview.positive,
      negative: translation?.overview.negative ?? overview.negative,
    },
    marketViews,
    markets: report.markets.map((market) => ({
      ...market,
      name: marketNames[market.symbol ?? ""]?.[language] ?? market.name,
    })),
    stories: report.stories.map((story, index) => ({
      ...story,
      categoryLabel: categoryLabels[language][story.category],
      title: translation?.stories[index]?.title ?? story.title,
      summary: translation?.stories[index]?.summary ?? story.summary,
      ai: {
        tone: story.ai?.tone ?? "neutral",
        interpretation:
          translation?.stories[index]?.interpretation ??
          story.ai?.interpretation ??
          "",
        sectors:
          translation?.stories[index]?.sectors ?? story.ai?.sectors ?? [],
        tickers: story.ai?.tickers ?? [],
      },
    })),
  };
}

export function localizeWeeklyReport(
  report: WeeklyReport,
  language: Language,
): WeeklyReport {
  const translation = language === "en" ? report.translations?.en : undefined;
  if (!translation) return report;
  return {
    ...report,
    headline: translation.headline,
    summary: translation.summary,
    overview: { ...translation.overview, tone: report.overview.tone },
    highlights: translation.highlights,
    outlook: translation.outlook,
    events: report.events.map((event, index) => ({
      ...event,
      title: translation.events[index]?.title ?? event.title,
      whyItMatters:
        translation.events[index]?.whyItMatters ?? event.whyItMatters,
    })),
  };
}

export function toneLabel(tone: ImpactTone, language: Language) {
  return toneLabels[language][tone];
}

export function marketTrendLabel(trend: MarketTrend, language: Language) {
  return marketTrendLabels[language][trend];
}

export function formatDate(date: string, language: Language) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: language === "zh" ? "long" : "short",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${date}T00:00:00+08:00`));
}

export function formatMarketDate(date: string, language: Language) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: language === "zh" ? "long" : "short",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${date}T00:00:00+08:00`));
}

export function formatMarketAsOfLabel(
  marketAsOf: string,
  reportDate: string,
  market: MarketRegion,
  language: Language,
) {
  const difference =
    (Date.parse(`${reportDate}T12:00:00Z`) -
      Date.parse(`${marketAsOf}T12:00:00Z`)) /
    86_400_000;
  const template =
    difference === 0
      ? copy[language].marketAsOfToday
      : difference === 1
        ? copy[language].marketAsOfYesterday
        : copy[language].marketAsOfLatest;
  const marketLabel =
    language === "zh"
      ? market === "CN"
        ? "A股"
        : "美股"
      : market === "CN"
        ? "China"
        : "U.S.";
  return formatTemplate(template, {
    market: marketLabel,
    date: formatMarketDate(marketAsOf, language),
  });
}

export function formatMarketUpdateTime(date: string, language: Language) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: language === "zh" ? "long" : "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Shanghai",
  }).format(new Date(date));
}

export function formatWeekday(date: string, language: Language) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    weekday: "long",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${date}T00:00:00+08:00`));
}
