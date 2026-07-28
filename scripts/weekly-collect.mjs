import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const wranglerPath = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return isoDate(next);
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function defaultWeekEnd() {
  const today = shanghaiDate();
  const date = new Date(`${today}T12:00:00Z`);
  const daysToSunday = (7 - date.getUTCDay()) % 7;
  return addDays(today, daysToSunday);
}

function parseArgs(args) {
  const weekIndex = args.indexOf("--week-end");
  const outputIndex = args.indexOf("--output");
  const weekEnd = weekIndex >= 0 ? args[weekIndex + 1] : defaultWeekEnd();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
    throw new Error("--week-end 必须是 YYYY-MM-DD");
  }
  return {
    weekEnd,
    outputPath: resolve(
      outputIndex >= 0 ? args[outputIndex + 1] : "work/weekly-input.json",
    ),
  };
}

async function queryDailyReports(weekStart, weekEnd) {
  const sql = `SELECT
    report_date AS reportDate,
    edition,
    headline,
    summary,
    generated_at AS generatedAt,
    data_cut AS dataCut,
    agent_model AS agentModel,
    content
  FROM daily_reports
  WHERE report_date BETWEEN '${weekStart}' AND '${weekEnd}'
  ORDER BY report_date ASC`;
  const result = await execFileAsync(
    wranglerPath,
    [
      "d1",
      "execute",
      "stock-daily-db",
      "--remote",
      "--command",
      sql,
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const payload = JSON.parse(result.stdout);
  const rows = payload[0]?.results ?? [];
  return rows.map(({ content, ...metadata }) => ({
    ...metadata,
    ...JSON.parse(content),
  }));
}

function decodeHtml(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFedEvents(startDate, endDate) {
  const months = new Set([startDate.slice(0, 7), endDate.slice(0, 7)]);
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const events = [];
  for (const month of months) {
    const [year, monthNumber] = month.split("-");
    const monthName = monthNames[Number(monthNumber) - 1];
    const source = `https://www.federalreserve.gov/newsevents/${year}-${monthName}.htm`;
    const response = await fetch(source, {
      headers: { "User-Agent": "StockDaily/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) continue;
    const html = await response.text();
    const blocks = html.match(
      /<div class="panel border panel-unstyled[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g,
    );
    for (const block of blocks ?? []) {
      if (!/FOMC Meeting/i.test(block)) continue;
      const day = block.match(/<div class="col-xs-3">\s*<p>(\d{1,2})<\/p>/)?.[1];
      if (!day) continue;
      const date = `${month}-${String(day).padStart(2, "0")}`;
      if (date < startDate || date > endDate) continue;
      events.push({
        date,
        title: "Federal Open Market Committee decision",
        source,
        sourceLabel: "Federal Reserve",
      });
    }
  }
  return events;
}

async function fetchBeaEvents(startDate, endDate) {
  const source = "https://apps.bea.gov/API/signup/release_dates.json";
  const response = await fetch(source, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  const events = [];
  for (const [title, entry] of Object.entries(payload)) {
    if (
      !/^(Gross Domestic Product|Personal Income and Outlays|U\.S\. International Trade in Goods and Services|Corporate Profits)$/i.test(
        title,
      )
    ) {
      continue;
    }
    for (const timestamp of entry.release_dates ?? []) {
      const date = String(timestamp).slice(0, 10);
      if (date >= startDate && date <= endDate) {
        events.push({
          date,
          title,
          source,
          sourceLabel: "U.S. Bureau of Economic Analysis",
        });
      }
    }
  }
  return events;
}

function parseIcs(ics, startDate, endDate) {
  const events = [];
  for (const block of ics.split("BEGIN:VEVENT").slice(1)) {
    const rawDate = block.match(/DTSTART[^:]*:(\d{8})/)?.[1];
    const title = block.match(/SUMMARY:(.+)/)?.[1]?.trim();
    if (!rawDate || !title) continue;
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`;
    if (date < startDate || date > endDate) continue;
    events.push({
      date,
      title: decodeHtml(title.replace(/\\,/g, ",")),
      source: "https://www.bls.gov/schedule/news_release/bls.ics",
      sourceLabel: "U.S. Bureau of Labor Statistics",
    });
  }
  return events;
}

async function fetchBlsEvents(startDate, endDate) {
  const source = "https://www.bls.gov/schedule/news_release/bls.ics";
  const response = await fetch(source, {
    headers: {
      Accept: "text/calendar",
      "User-Agent": "Mozilla/5.0 StockDaily/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return [];
  return parseIcs(await response.text(), startDate, endDate);
}

async function fetchUpcomingEvents(weekEnd) {
  const startDate = addDays(weekEnd, 1);
  const endDate = addDays(weekEnd, 7);
  const results = await Promise.allSettled([
    fetchFedEvents(startDate, endDate),
    fetchBeaEvents(startDate, endDate),
    fetchBlsEvents(startDate, endDate),
  ]);
  const seen = new Set();
  return results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((event) => {
      const key = `${event.date}:${event.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
    .slice(0, 12);
}

export async function collectWeeklyInput(weekEnd) {
  const weekStart = addDays(weekEnd, -6);
  const [dailyReports, upcomingEvents] = await Promise.all([
    queryDailyReports(weekStart, weekEnd),
    fetchUpcomingEvents(weekEnd),
  ]);
  if (dailyReports.length < 2) {
    throw new Error(
      `周报至少需要 2 份日报，当前 ${weekStart}–${weekEnd} 只有 ${dailyReports.length} 份`,
    );
  }
  return {
    schemaVersion: 1,
    contractVersion: "codex-weekly-v1",
    runId: randomUUID(),
    weekStart,
    weekEnd,
    collectedAt: new Date().toISOString(),
    dailyReports,
    upcomingEvents,
  };
}

async function main() {
  const { weekEnd, outputPath } = parseArgs(process.argv.slice(2));
  const input = await collectWeeklyInput(weekEnd);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        status: "collected",
        weekStart: input.weekStart,
        weekEnd: input.weekEnd,
        reportCount: input.dailyReports.length,
        eventCount: input.upcomingEvents.length,
        outputPath,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
