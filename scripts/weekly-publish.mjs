import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AGENT_MODEL = "openai/codex-weekly";
const tones = new Set(["positive", "negative", "mixed"]);
const eventImpactTones = new Set(["positive", "negative", "neutral"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

function text(value, label, min, max, terminator = "") {
  if (typeof value !== "string") throw new Error(`${label} 缺失`);
  let normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${label} 长度必须为 ${min}–${max}`);
  }
  if (terminator && !/[。！？.!?]$/.test(normalized)) {
    if (normalized.length === max) throw new Error(`${label} 句子未写完`);
    normalized += terminator;
  }
  return normalized;
}

function strings(value, label, min, max, itemMax) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} 数量必须为 ${min}–${max}`);
  }
  return value.map((item, index) =>
    text(item, `${label}[${index}]`, 2, itemMax),
  );
}

function optionalText(value, label, min, max) {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, label, min, max);
}

function sourceAuthority(value) {
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

function verifiedEventFields(source, index) {
  const fields = {
    expectation: optionalText(
      source.expectation,
      `upcomingEvents[${index}].expectation`,
      6,
      180,
    ),
    expectationSource: source.expectationSource,
    expectationSourceLabel: optionalText(
      source.expectationSourceLabel,
      `upcomingEvents[${index}].expectationSourceLabel`,
      2,
      60,
    ),
  };
  const hasExpectationFields = Boolean(
    fields.expectation ||
      fields.expectationSource ||
      fields.expectationSourceLabel,
  );
  if (
    hasExpectationFields &&
    (!fields.expectation ||
      !fields.expectationSource ||
      !fields.expectationSourceLabel)
  ) {
    throw new Error(
      `upcomingEvents[${index}] 预期信息必须同时提供内容与来源`,
    );
  }
  if (hasExpectationFields) {
    if (!sourceAuthority(fields.expectationSource)) {
      throw new Error(`upcomingEvents[${index}].expectationSource 无效`);
    }
  }

  if (!source.verifiedOutcome) {
    return Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
  }

  const outcome = object(
    source.verifiedOutcome,
    `upcomingEvents[${index}].verifiedOutcome`,
  );
  const resultSource = optionalText(
    outcome.source,
    `upcomingEvents[${index}].verifiedOutcome.source`,
    12,
    500,
  );
  const resultVerifiedAt = optionalText(
    outcome.verifiedAt,
    `upcomingEvents[${index}].verifiedOutcome.verifiedAt`,
    10,
    40,
  );
  if (
    !resultSource ||
    sourceAuthority(resultSource) !== sourceAuthority(source.source) ||
    !resultVerifiedAt ||
    !Number.isFinite(Date.parse(resultVerifiedAt))
  ) {
    throw new Error(
      `upcomingEvents[${index}].verifiedOutcome 必须由事件一手来源核验`,
    );
  }
  if (!eventImpactTones.has(outcome.impact)) {
    throw new Error(
      `upcomingEvents[${index}].verifiedOutcome.impact 必须为 positive、negative 或 neutral`,
    );
  }
  return {
    ...fields,
    status: "realized",
    result: text(
      outcome.result,
      `upcomingEvents[${index}].verifiedOutcome.result`,
      12,
      240,
    ),
    assessment: text(
      outcome.assessment,
      `upcomingEvents[${index}].verifiedOutcome.assessment`,
      8,
      180,
    ),
    nextWatch: text(
      outcome.nextWatch,
      `upcomingEvents[${index}].verifiedOutcome.nextWatch`,
      8,
      180,
    ),
    impactTone: outcome.impact,
    resultSource,
    resultSourceLabel: text(
      outcome.sourceLabel,
      `upcomingEvents[${index}].verifiedOutcome.sourceLabel`,
      2,
      60,
    ),
    resultVerifiedAt,
  };
}

function validateOverview(value, label, english = false) {
  const overview = object(value, label);
  if (!tones.has(overview.tone)) throw new Error(`${label}.tone 无效`);
  const positive = strings(
    overview.positive,
    `${label}.positive`,
    overview.tone === "negative" ? 0 : 1,
    4,
    english ? 48 : 18,
  );
  const negative = strings(
    overview.negative,
    `${label}.negative`,
    overview.tone === "positive" ? 0 : 1,
    4,
    english ? 48 : 18,
  );
  return {
    tone: overview.tone,
    interpretation: text(
      overview.interpretation,
      `${label}.interpretation`,
      english ? 30 : 36,
      english ? 420 : 190,
      english ? "." : "。",
    ),
    positive,
    negative,
  };
}

export function validateWeeklyInput(value) {
  const input = object(value, "weekly-input");
  if (
    input.schemaVersion !== 1 ||
    input.contractVersion !== "codex-weekly-v1" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.weekEnd) ||
    !Array.isArray(input.dailyReports) ||
    input.dailyReports.length < 2 ||
    !Array.isArray(input.upcomingEvents)
  ) {
    throw new Error("weekly-input 结构无效");
  }
  return input;
}

export function validateWeeklyReport(value, input) {
  const report = object(value, "weekly-report");
  const overview = validateOverview(report.overview, "overview");
  const highlights = strings(report.highlights, "highlights", 3, 5, 120).map(
    (item, index) => text(item, `highlights[${index}]`, 20, 120, "。"),
  );
  const outlookValue = object(report.outlook, "outlook");
  const outlook = {
    base: text(outlookValue.base, "outlook.base", 30, 180, "。"),
    upside: text(outlookValue.upside, "outlook.upside", 24, 150, "。"),
    downside: text(outlookValue.downside, "outlook.downside", 24, 150, "。"),
  };
  if (!Array.isArray(report.events) || report.events.length > 6) {
    throw new Error("events 最多 6 项");
  }
  const events = report.events.map((eventValue, index) => {
    const event = object(eventValue, `events[${index}]`);
    const sourceIndex = Number(event.sourceIndex);
    const source = input.upcomingEvents[sourceIndex];
    if (!source) throw new Error(`events[${index}].sourceIndex 无效`);
    return {
      sourceIndex,
      title: text(event.title, `events[${index}].title`, 6, 60),
      whyItMatters: text(
        event.whyItMatters,
        `events[${index}].whyItMatters`,
        18,
        120,
        "。",
      ),
    };
  });

  const translationsValue = object(report.translations, "translations");
  const english = object(translationsValue.en, "translations.en");
  const englishOverview = validateOverview(
    { ...english.overview, tone: overview.tone },
    "translations.en.overview",
    true,
  );
  const englishOutlook = object(
    english.outlook,
    "translations.en.outlook",
  );
  const englishEvents = english.events;
  if (!Array.isArray(englishEvents) || englishEvents.length !== events.length) {
    throw new Error("translations.en.events 必须对应 events");
  }
  const translations = {
    en: {
      headline: text(
        english.headline,
        "translations.en.headline",
        8,
        110,
      ),
      summary: text(
        english.summary,
        "translations.en.summary",
        20,
        260,
        ".",
      ),
      overview: {
        interpretation: englishOverview.interpretation,
        positive: englishOverview.positive,
        negative: englishOverview.negative,
      },
      highlights: strings(
        english.highlights,
        "translations.en.highlights",
        highlights.length,
        highlights.length,
        300,
      ),
      outlook: {
        base: text(
          englishOutlook.base,
          "translations.en.outlook.base",
          25,
          420,
          ".",
        ),
        upside: text(
          englishOutlook.upside,
          "translations.en.outlook.upside",
          20,
          360,
          ".",
        ),
        downside: text(
          englishOutlook.downside,
          "translations.en.outlook.downside",
          20,
          360,
          ".",
        ),
      },
      events: englishEvents.map((eventValue, index) => {
        const event = object(
          eventValue,
          `translations.en.events[${index}]`,
        );
        return {
          title: text(
            event.title,
            `translations.en.events[${index}].title`,
            5,
            120,
          ),
          whyItMatters: text(
            event.whyItMatters,
            `translations.en.events[${index}].whyItMatters`,
            12,
            300,
            ".",
          ),
        };
      }),
    },
  };

  const generatedText = [
    report.headline,
    report.summary,
    overview.interpretation,
    ...highlights,
    ...Object.values(outlook),
  ].join(" ");
  if (/建议|应当买|应该买|卖出|目标价|仓位/.test(generatedText)) {
    throw new Error("周报不得包含投资建议或仓位指令");
  }

  return {
    headline: text(report.headline, "headline", 8, 26),
    summary: text(report.summary, "summary", 24, 100, "。"),
    overview,
    highlights,
    outlook,
    events,
    translations,
  };
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function eventId(source) {
  if (typeof source.id === "string" && source.id.trim()) {
    return source.id.trim();
  }
  const authority = String(source.sourceLabel ?? "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const title = String(source.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${authority || "event"}-${title || "release"}-${source.date}`;
}

export function buildContent(input, report) {
  const events = report.events.map((event) => {
    const source = input.upcomingEvents[event.sourceIndex];
    return {
      id: eventId(source),
      date: source.date,
      title: event.title,
      whyItMatters: event.whyItMatters,
      source: source.source,
      sourceLabel: source.sourceLabel,
      status: "scheduled",
      ...(source.baselineKind
        ? { baselineKind: source.baselineKind }
        : {}),
      ...(Array.isArray(source.metrics) && source.metrics.length > 0
        ? { metrics: source.metrics }
        : {}),
      ...verifiedEventFields(source, event.sourceIndex),
    };
  });
  const englishEvents = report.translations.en.events.map(
    (event, index) => {
      const source =
        input.upcomingEvents[report.events[index].sourceIndex];
      const outcome = source.verifiedOutcome;
      return {
        ...event,
        ...(source.expectationEn
          ? {
              expectation: text(
                source.expectationEn,
                `upcomingEvents[${report.events[index].sourceIndex}].expectationEn`,
                6,
                320,
              ),
            }
          : {}),
        ...(outcome
          ? {
              result: text(
                outcome.resultEn,
                `upcomingEvents[${report.events[index].sourceIndex}].verifiedOutcome.resultEn`,
                12,
                420,
              ),
              assessment: text(
                outcome.assessmentEn,
                `upcomingEvents[${report.events[index].sourceIndex}].verifiedOutcome.assessmentEn`,
                8,
                320,
              ),
              nextWatch: text(
                outcome.nextWatchEn,
                `upcomingEvents[${report.events[index].sourceIndex}].verifiedOutcome.nextWatchEn`,
                8,
                320,
              ),
            }
          : {}),
      };
    },
  );
  return JSON.stringify({
    overview: report.overview,
    highlights: report.highlights,
    outlook: report.outlook,
    events,
    translations: {
      ...report.translations,
      en: {
        ...report.translations.en,
        events: englishEvents,
      },
    },
  });
}

async function publish(input, report) {
  const generatedAt = new Date().toISOString();
  const sql = `INSERT INTO weekly_reports (
    week_end, week_start, headline, summary, generated_at, agent_model, content
  ) VALUES (
    ${sqlText(input.weekEnd)},
    ${sqlText(input.weekStart)},
    ${sqlText(report.headline)},
    ${sqlText(report.summary)},
    ${sqlText(generatedAt)},
    ${sqlText(AGENT_MODEL)},
    ${sqlText(buildContent(input, report))}
  )
  ON CONFLICT(week_end) DO UPDATE SET
    week_start = excluded.week_start,
    headline = excluded.headline,
    summary = excluded.summary,
    generated_at = excluded.generated_at,
    agent_model = excluded.agent_model,
    content = excluded.content,
    updated_at = CURRENT_TIMESTAMP;`;

  const wranglerPath = resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  await execFileAsync(
    wranglerPath,
    [
      "d1",
      "execute",
      "stock-daily-db",
      "--env",
      "production",
      "--remote",
      "--yes",
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const paths = process.argv.slice(2).filter((item) => item !== "--check");
  const input = validateWeeklyInput(
    JSON.parse(await readFile(resolve(paths[0] ?? "work/weekly-input.json"))),
  );
  const report = validateWeeklyReport(
    JSON.parse(await readFile(resolve(paths[1] ?? "work/weekly-report.json"))),
    input,
  );
  if (!checkOnly) await publish(input, report);
  console.log(
    JSON.stringify(
      {
        status: checkOnly ? "valid" : "published",
        weekStart: input.weekStart,
        weekEnd: input.weekEnd,
        dailyCount: input.dailyReports.length,
        eventCount: report.events.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
