import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContent,
  validateWeeklyInput,
  validateWeeklyReport,
} from "../scripts/weekly-publish.mjs";

const input = {
  schemaVersion: 1,
  contractVersion: "codex-weekly-v1",
  runId: "weekly-test",
  weekStart: "2026-07-20",
  weekEnd: "2026-07-26",
  collectedAt: "2026-07-26T12:30:00.000Z",
  dailyReports: [{ reportDate: "2026-07-24" }, { reportDate: "2026-07-25" }],
  upcomingEvents: [
    {
      id: "fed-fomc-2026-07-29",
      date: "2026-07-29",
      title: "Federal Open Market Committee decision",
      source: "https://www.federalreserve.gov/",
      sourceLabel: "Federal Reserve",
      baselineKind: "consensus",
      expectation: "市场预期维持政策利率不变。",
      expectationEn: "Markets expected the policy rate to remain unchanged.",
      expectationSource: "https://www.reuters.com/markets/rates-bonds/",
      expectationSourceLabel: "Reuters",
      verifiedOutcome: {
        result: "维持政策利率不变，三名委员主张加息。",
        resultEn: "The policy rate was held; three members preferred a hike.",
        assessment: "结果符合基准预期，但投票结构偏鹰。",
        assessmentEn: "The result matched the base case, but the vote was hawkish.",
        nextWatch: "后续利率方向取决于通胀和就业。",
        nextWatchEn: "The next rate move depends on inflation and employment.",
        source:
          "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
        sourceLabel: "Federal Reserve",
        verifiedAt: "2026-07-29T18:00:00.000Z",
      },
      metrics: [
        {
          id: "policy-rate",
          label: "政策利率",
          labelEn: "Policy rate",
          expected: 4.5,
          unit: "%",
          source: {
            url: "https://www.federalreserve.gov/",
            label: "Federal Reserve",
            tier: "first_party",
          },
        },
      ],
    },
  ],
};

const report = {
  headline: "利率约束与中美市场分化延续",
  summary:
    "本周美股风险偏好承压而A股相对走强，下周关键变量集中在政策信号与增长数据。",
  overview: {
    tone: "mixed",
    interpretation:
      "美债收益率上行抬高折现率，对高估值成长股形成利空；A股走强则支撑中国大盘股风险偏好。",
    positive: ["A股", "中国大盘股"],
    negative: ["高估值成长股", "利率敏感资产"],
  },
  highlights: [
    "美股主要指数承压，长期利率上行进一步压低高估值资产的估值容忍度。",
    "上证与沪深指数相对走强，中美风险偏好出现较明显的阶段性分化。",
    "能源与通胀相关消息增加成本端不确定性，市场重新评估政策宽松空间。",
  ],
  outlook: {
    base: "政策信号保持谨慎，市场延续分化，高估值资产仍受折现率约束，资金更偏好现金流稳定板块。",
    upside: "若增长数据温和且政策措辞偏宽松，风险偏好可能获得阶段性修复并扩散至成长板块。",
    downside: "若通胀或政策信号偏鹰，长端利率上行将继续压制高估值资产并加大市场波动。",
  },
  events: [
    {
      sourceIndex: 0,
      title: "美联储公布利率决议",
      whyItMatters:
        "政策措辞将影响降息路径、长期利率与全球风险资产的估值预期。",
    },
  ],
  translations: {
    en: {
      headline: "Rate Pressure and U.S.-China Divergence Continue",
      summary:
        "U.S. risk appetite weakened while Chinese equities held up, leaving policy signals and growth data as the next key variables.",
      overview: {
        interpretation:
          "Higher Treasury yields raise discount rates and weigh on growth valuations, while stronger Chinese equities support large-cap risk appetite.",
        positive: ["Chinese equities", "Chinese large caps"],
        negative: ["Growth stocks", "Rate-sensitive assets"],
      },
      highlights: [
        "Major U.S. indexes weakened as higher long-term rates reduced valuation tolerance for expensive assets.",
        "Shanghai and CSI indexes held up better, creating a visible divergence in U.S. and Chinese risk appetite.",
        "Energy and inflation news increased cost uncertainty and narrowed expectations for easier policy.",
      ],
      outlook: {
        base: "Cautious policy signals keep markets divided and leave growth valuations constrained.",
        upside:
          "Moderate growth data and softer policy language could support a temporary recovery in risk appetite.",
        downside:
          "Hawkish policy or stronger inflation could lift long yields and deepen pressure on expensive assets.",
      },
      events: [
        {
          title: "Federal Reserve rate decision",
          whyItMatters:
            "Policy language will shape rate expectations, long yields, and global asset valuations.",
        },
      ],
    },
  },
};

test("weekly contract validates scenarios, impact labels and event sources", () => {
  const checkedInput = validateWeeklyInput(input);
  const checkedReport = validateWeeklyReport(report, checkedInput);
  assert.equal(checkedReport.overview.tone, "mixed");
  assert.equal(checkedReport.highlights.length, 3);
  assert.equal(checkedReport.events[0].sourceIndex, 0);
  assert.equal(checkedReport.translations.en.events.length, 1);
  const stored = JSON.parse(buildContent(checkedInput, checkedReport));
  assert.equal(stored.events[0].id, "fed-fomc-2026-07-29");
  assert.equal(stored.events[0].status, "realized");
  assert.equal(stored.events[0].baselineKind, "consensus");
  assert.equal(stored.events[0].metrics[0].expected, 4.5);
  assert.match(stored.events[0].expectation, /维持政策利率/);
  assert.match(stored.events[0].result, /三名委员主张加息/);
  assert.match(stored.events[0].assessment, /偏鹰/);
  assert.match(stored.events[0].nextWatch, /通胀和就业/);
  assert.match(stored.translations.en.events[0].result, /three members/);
});

test("weekly contract rejects investment instructions", () => {
  assert.throws(
    () =>
      validateWeeklyReport(
        {
          ...report,
          outlook: {
            ...report.outlook,
            base: "政策信号保持谨慎，建议加仓高估值成长股并等待风险偏好修复，同时降低其他资产配置。",
          },
        },
        input,
      ),
    /不得包含投资建议/,
  );
});

test("weekly contract rejects event outcomes from a different authority", () => {
  const unsafe = structuredClone(input);
  unsafe.upcomingEvents[0].verifiedOutcome.source =
    "https://example.com/unverified";
  const checkedReport = validateWeeklyReport(report, unsafe);
  assert.throws(
    () => buildContent(unsafe, checkedReport),
    /必须由事件一手来源核验/,
  );
});

test("weekly contract requires a source for event expectations", () => {
  const incomplete = structuredClone(input);
  delete incomplete.upcomingEvents[0].expectationSource;
  assert.throws(
    () => buildContent(incomplete, validateWeeklyReport(report, incomplete)),
    /预期信息必须同时提供内容与来源/,
  );
});
