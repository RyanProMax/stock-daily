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
    dataCut: "数据截止",
    copy: "复制摘要",
    copied: "已复制",
    agentOverview: "盘面结论",
    favorable: "主要利好",
    adverse: "主要利空",
    market: "市场状态",
    sectorHeat: "高波动板块",
    heatRange: "按当日绝对涨跌幅排序",
    heatStreak: "连续大幅波动",
    heatStreakDays: "连续 {count} 个交易日",
    noHeatStreak: "暂无连续两个交易日大幅波动的板块",
    currentMarkets: "主要指数",
    marketUpdatedAt: "更新：{time}（北京）",
    marketAsOfToday: "{market}数据截至今天（{date}）收盘",
    marketAsOfYesterday: "{market}数据截至昨天（{date}）收盘",
    marketAsOfLatest: "{market}数据截至最近交易日（{date}）收盘",
    weekEvents: "本周关键事件",
    eventScheduled: "待公布",
    eventAwaiting: "待公布",
    eventCancelled: "已取消",
    eventPostponed: "已延期",
    eventAssessment: "判断",
    eventNext: "下一步",
    eventNoData: "本周暂无关键事件。",
    hotspotIndex: "定价信号板",
    hotspotTop: "核心信号",
    hotspotSupporting: "辅助信号",
    hotspotMacro: "政策与宏观",
    hotspotCompany: "公司与财报",
    hotspotIndustry: "行业与商品",
    hotspotSource: "来源",
    signalFacts: "事实",
    signalLogic: "影响逻辑",
    impact: "影响",
    priority: "优先级 {value}/5",
    proof: "核验依据",
    pricingThesis: "盘面结论",
    expectationGap: "预期差",
    actual: "实际",
    expected: "预期",
    prior: "前值",
    surprise: "差异",
    marketReaction: "市场反应",
    transmission: "传导链",
    exposure: "影响对象",
    checkpoint: "核验点",
    confirmIf: "支持条件",
    invalidateIf: "失效条件",
    verifyBy: "核验期限",
    confidence: "置信度",
    coreSignal: "核心",
    supportingSignal: "辅助",
    horizonIntraday: "日内",
    horizonShort: "1–5日",
    horizonMedium: "1–4周",
    confidenceLow: "低",
    confidenceMedium: "中",
    confidenceHigh: "高",
    sourceFirstParty: "一手来源",
    sourceWire: "通讯社",
    sourceSecondary: "二手来源",
    statusPending: "待核验",
    statusConfirmed: "已验证",
    statusPartial: "部分验证",
    statusInvalidated: "已失效",
    statusInconclusive: "证据不足",
    observation: "后续观察",
    previous: "往期日报",
    overallTone: "整体{tone}",
    newsCount: "{count} 条有效信号",
    newer: "查看更新一期",
    older: "查看更早一期",
    selectDate: "选择日报日期",
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
    dataCut: "Data through",
    copy: "Copy summary",
    copied: "Copied",
    agentOverview: "Market Read",
    favorable: "Favorable for",
    adverse: "Adverse for",
    market: "Market Pulse",
    sectorHeat: "High-Volatility Sectors",
    heatRange: "Ranked by absolute daily price move",
    heatStreak: "Sustained Large Moves",
    heatStreakDays: "{count} trading days",
    noHeatStreak: "No sector has made a large move for two trading days.",
    currentMarkets: "Key Indexes",
    marketUpdatedAt: "Updated {time} (Beijing)",
    marketAsOfToday: "{market} data through today's close ({date})",
    marketAsOfYesterday: "{market} data through yesterday's close ({date})",
    marketAsOfLatest: "{market} data through the latest trading-day close ({date})",
    weekEvents: "This Week's Key Events",
    eventScheduled: "Pending",
    eventAwaiting: "Pending",
    eventCancelled: "Cancelled",
    eventPostponed: "Postponed",
    eventAssessment: "Read",
    eventNext: "Next",
    eventNoData: "No key events are scheduled this week.",
    hotspotIndex: "Pricing Signal Board",
    hotspotTop: "Core Signals",
    hotspotSupporting: "Supporting Signals",
    hotspotMacro: "Policy & Macro",
    hotspotCompany: "Companies & Earnings",
    hotspotIndustry: "Sectors & Commodities",
    hotspotSource: "Source",
    signalFacts: "Facts",
    signalLogic: "Impact logic",
    impact: "Impact",
    priority: "Priority {value}/5",
    proof: "Evidence",
    pricingThesis: "Market Read",
    expectationGap: "Expectation Gap",
    actual: "Actual",
    expected: "Expected",
    prior: "Prior",
    surprise: "Gap",
    marketReaction: "Market Reaction",
    transmission: "Transmission",
    exposure: "Exposures",
    checkpoint: "Checkpoint",
    confirmIf: "Confirmation",
    invalidateIf: "Invalidation",
    verifyBy: "Verify by",
    confidence: "Confidence",
    coreSignal: "Core",
    supportingSignal: "Supporting",
    horizonIntraday: "Intraday",
    horizonShort: "1–5 days",
    horizonMedium: "1–4 weeks",
    confidenceLow: "Low",
    confidenceMedium: "Medium",
    confidenceHigh: "High",
    sourceFirstParty: "First party",
    sourceWire: "Wire",
    sourceSecondary: "Secondary",
    statusPending: "Pending",
    statusConfirmed: "Confirmed",
    statusPartial: "Partially confirmed",
    statusInvalidated: "Invalidated",
    statusInconclusive: "Inconclusive",
    observation: "Follow-up observation",
    previous: "Other Editions",
    overallTone: "Overall {tone}",
    newsCount: "{count} qualified signals",
    newer: "View newer edition",
    older: "View older edition",
    selectDate: "Select report date",
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
  SZSE: { zh: "深证成指", en: "SZSE Component" },
  CSI300: { zh: "沪深 300", en: "CSI 300" },
  CSI500: { zh: "中证 500", en: "CSI 500" },
  CHINEXT: { zh: "创业板指", en: "ChiNext" },
  STAR50: { zh: "科创 50", en: "STAR 50" },
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
    stories: report.stories.map((story, index) => {
      const translatedStory = translation?.stories[index];
      const translatedSignal = translatedStory?.signal;
      const signal = story.signal
        ? {
            ...story.signal,
            thesis: translatedSignal?.thesis ?? story.signal.thesis,
            scoreReason:
              translatedSignal?.scoreReason ?? story.signal.scoreReason,
            metrics: story.signal.metrics.map((metric) => ({
              ...metric,
              label:
                language === "en"
                  ? metric.labelEn ?? metric.label
                  : metric.label,
            })),
            reactions: story.signal.reactions.map((reaction) => ({
              ...reaction,
              window:
                language === "en"
                  ? reaction.windowEn ?? reaction.window
                  : reaction.window,
            })),
            transmission: story.signal.transmission.map((step, stepIndex) => ({
              ...step,
              from:
                translatedSignal?.transmission[stepIndex]?.from ?? step.from,
              to: translatedSignal?.transmission[stepIndex]?.to ?? step.to,
              mechanism:
                translatedSignal?.transmission[stepIndex]?.mechanism ??
                step.mechanism,
            })),
            exposures: story.signal.exposures.map(
              (exposure, exposureIndex) => ({
                ...exposure,
                name:
                  translatedSignal?.exposures[exposureIndex]?.name ??
                  exposure.name,
                basis:
                  translatedSignal?.exposures[exposureIndex]?.basis ??
                  exposure.basis,
              }),
            ),
            checkpoint: {
              ...story.signal.checkpoint,
              metric:
                translatedSignal?.checkpoint.metric ??
                story.signal.checkpoint.metric,
              confirmIf:
                translatedSignal?.checkpoint.confirmIf ??
                story.signal.checkpoint.confirmIf,
              invalidateIf:
                translatedSignal?.checkpoint.invalidateIf ??
                story.signal.checkpoint.invalidateIf,
              observation:
                translatedSignal?.checkpoint.observation ??
                story.signal.checkpoint.observation,
            },
          }
        : undefined;
      return {
        ...story,
        ...(signal ? { signal } : {}),
        categoryLabel: categoryLabels[language][story.category],
        title: translatedStory?.title ?? story.title,
        summary: translatedStory?.summary ?? story.summary,
        ai: {
          tone: story.ai?.tone ?? "neutral",
          interpretation:
            translatedStory?.interpretation ??
            story.ai?.interpretation ??
            "",
          sectors: translatedStory?.sectors ?? story.ai?.sectors ?? [],
          tickers: story.ai?.tickers ?? [],
        },
      };
    }),
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
      expectation:
        translation.events[index]?.expectation ?? event.expectation,
      result: translation.events[index]?.result ?? event.result,
      assessment:
        translation.events[index]?.assessment ?? event.assessment,
      nextWatch:
        translation.events[index]?.nextWatch ?? event.nextWatch,
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
