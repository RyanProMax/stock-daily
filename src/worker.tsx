import { Hono } from "hono";
import { renderToReadableStream } from "react-dom/server.edge";
import Document, {
  type DailyPageData,
  type PageData,
  type WeeklyPageData,
} from "./App";
import {
  resolveLanguage,
} from "./lib/i18n";
import type { MarketRegion } from "./types";
import {
  buildSectorHeatView,
  getDailyArchive,
  getDailyHeatHistory,
  getDailyReport,
  getWeeklyArchive,
  getWeeklyEventTimeline,
  getWeeklyReport,
} from "./server/reports";

type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const cacheHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=60, must-revalidate",
  "Content-Type": "text/html; charset=UTF-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function canonicalUrl(requestUrl: string) {
  const url = new URL(requestUrl);
  return `https://stock-daily-4ip.pages.dev${url.pathname}${url.search}`;
}

function resolveMarket(value: string | null): MarketRegion {
  return value?.toUpperCase() === "US" ? "US" : "CN";
}

async function renderPage(data: PageData) {
  const stream = await renderToReadableStream(<Document data={data} />, {
    onError(error) {
      console.error("SSR render failed", error);
    },
  });
  return new Response(stream, { headers: cacheHeaders });
}

async function dailyPage(
  requestUrl: string,
  db: D1Database,
): Promise<Response> {
  const url = new URL(requestUrl);
  const language = resolveLanguage(url.searchParams.get("lang"));
  const market = resolveMarket(url.searchParams.get("market"));
  const requestedDate = url.searchParams.get("date");
  const validDate =
    requestedDate && datePattern.test(requestedDate) ? requestedDate : null;

  let archive;
  let marketHistory;
  let report;
  try {
    [archive, marketHistory, report] = await Promise.all([
      getDailyArchive(db),
      getDailyHeatHistory(db, validDate),
      getDailyReport(db, validDate),
    ]);
  } catch (error) {
    console.error("D1 daily read failed; using bundled fallback", error);
    [archive, marketHistory, report] = await Promise.all([
      getDailyArchive(undefined),
      getDailyHeatHistory(undefined, validDate),
      getDailyReport(undefined, validDate),
    ]);
  }

  if (!report) {
    try {
      report = await getDailyReport(db);
    } catch {
      report = await getDailyReport(undefined);
    }
  }
  if (!report) {
    return new Response("No daily report is available.", { status: 503 });
  }
  if (marketHistory[0]?.reportDate !== report.reportDate) {
    try {
      marketHistory = await getDailyHeatHistory(db, report.reportDate);
    } catch {
      marketHistory = await getDailyHeatHistory(
        undefined,
        report.reportDate,
      );
    }
  }
  if (marketHistory.length === 0 && report.sectorHeat.length > 0) {
    marketHistory = [
      { reportDate: report.reportDate, sectors: report.sectorHeat },
    ];
  }
  let weekEvents = null;
  try {
    weekEvents = await getWeeklyEventTimeline(db, report.reportDate);
  } catch (error) {
    console.error("D1 weekly event read failed; hiding event timeline", error);
  }

  const data: DailyPageData = {
    kind: "daily",
    language,
    market,
    requestUrl: canonicalUrl(requestUrl),
    report,
    archive,
    sectorHeat: buildSectorHeatView(report.sectorHeat, marketHistory),
    weekEvents,
  };
  return renderPage(data);
}

async function weeklyPage(
  requestUrl: string,
  db: D1Database,
): Promise<Response> {
  const url = new URL(requestUrl);
  const language = resolveLanguage(url.searchParams.get("lang"));
  const requestedWeek = url.searchParams.get("week");
  const validWeek =
    requestedWeek && datePattern.test(requestedWeek) ? requestedWeek : null;
  const [archive, report] = await Promise.all([
    getWeeklyArchive(db),
    getWeeklyReport(db, validWeek),
  ]);
  const data: WeeklyPageData = {
    kind: "weekly",
    language,
    requestUrl: canonicalUrl(requestUrl),
    report,
    archive,
  };
  return renderPage(data);
}

app.get("/api/health", async (c) => {
  try {
    const [row, latestRun, latestWeekly] = await Promise.all([
      c.env.DB.prepare(
        "SELECT COUNT(*) AS reportCount FROM daily_reports",
      ).first<{ reportCount: number }>(),
      c.env.DB.prepare(
        `SELECT report_date AS reportDate, finished_at AS finishedAt, status
         FROM ingestion_runs
         ORDER BY finished_at DESC, started_at DESC
         LIMIT 1`,
      ).first(),
      c.env.DB.prepare(
        `SELECT week_end AS weekEnd, generated_at AS generatedAt
         FROM weekly_reports
         ORDER BY week_end DESC
         LIMIT 1`,
      ).first(),
    ]);
    c.header("Cache-Control", "no-store");
    return c.json({
      data: {
        status: "ok",
        render: "ssr",
        database: "connected",
        reportCount: row?.reportCount ?? 0,
        latestIngestion: latestRun ?? null,
        latestWeekly: latestWeekly ?? null,
      },
    });
  } catch {
    c.header("Cache-Control", "no-store");
    return c.json(
      { error: { message: "Database health check failed.", status: 503 } },
      503,
    );
  }
});

app.get("/api/reports", async (c) => {
  const requestedLimit = Number(c.req.query("limit") ?? "30");
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 30;
  try {
    const data = await getDailyArchive(c.env.DB, limit);
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    return c.json({ data, meta: { total: data.length, limit } });
  } catch {
    return c.json(
      { error: { message: "Daily archive is unavailable.", status: 503 } },
      503,
    );
  }
});

app.get("/api/reports/:date", async (c) => {
  const date = c.req.param("date");
  if (!datePattern.test(date)) {
    return c.json(
      { error: { message: "Date must be YYYY-MM-DD.", status: 400 } },
      400,
    );
  }
  try {
    const data = await getDailyReport(c.env.DB, date);
    if (!data) {
      return c.json(
        { error: { message: "Daily report not found.", status: 404 } },
        404,
      );
    }
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    return c.json({ data });
  } catch {
    return c.json(
      { error: { message: "Daily report is unavailable.", status: 503 } },
      503,
    );
  }
});

app.get("/api/weekly/:weekEnd", async (c) => {
  const weekEnd = c.req.param("weekEnd");
  if (!datePattern.test(weekEnd)) {
    return c.json(
      { error: { message: "Week end must be YYYY-MM-DD.", status: 400 } },
      400,
    );
  }
  const data = await getWeeklyReport(c.env.DB, weekEnd);
  if (!data) {
    return c.json(
      { error: { message: "Weekly report not found.", status: 404 } },
      404,
    );
  }
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ data });
});

app.get("/", (c) => dailyPage(c.req.url, c.env.DB));
app.get("/weekly", (c) => weeklyPage(c.req.url, c.env.DB));
app.get("/weekly/", (c) => weeklyPage(c.req.url, c.env.DB));

app.notFound((c) =>
  c.json({ error: { message: "Not found.", status: 404 } }, 404),
);

export default app;
