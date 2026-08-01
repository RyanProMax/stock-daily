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
  buildWeeklyEventTimeline,
  buildSectorHeatView,
  deriveThesisLedger,
  getDailyArchive,
  getDailyHeatHistory,
  getDailyReport,
  getThesisLedger,
  getWeeklyArchive,
  getWeeklyEventTimeline,
  getWeeklyReport,
} from "./server/reports";

type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const productionOrigin = "https://stock-daily-4ip.pages.dev";
const cacheHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=60, must-revalidate",
  "Content-Type": "text/html; charset=UTF-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function canonicalUrl(requestUrl: string, pathname: string) {
  const url = new URL(requestUrl);
  return `${productionOrigin}${pathname}${url.search}`;
}

export function isLocalDevelopmentUrl(requestUrl: string) {
  const hostname = new URL(requestUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function productionDataUrl(requestUrl: string, pathname: string) {
  const source = new URL(requestUrl);
  const target = new URL(pathname, productionOrigin);
  for (const [key, value] of source.searchParams) {
    target.searchParams.set(key, value);
  }
  return target.toString();
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

async function fetchProductionApi<T>(
  requestUrl: string,
  pathname: string,
): Promise<T> {
  const response = await fetch(productionDataUrl(requestUrl, pathname), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Production data request failed with ${response.status}.`);
  }
  const payload = (await response.json()) as { data?: T };
  if (payload.data === undefined) {
    throw new Error("Production API response is empty.");
  }
  return payload.data;
}

function precedingSunday(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday - 1);
  return value.toISOString().slice(0, 10);
}

async function fetchProductionDailyPageData(
  requestUrl: string,
): Promise<DailyPageData | null> {
  const url = new URL(requestUrl);
  const language = resolveLanguage(url.searchParams.get("lang"));
  const market = resolveMarket(url.searchParams.get("market"));
  const requestedDate = url.searchParams.get("date");
  const archive = await fetchProductionApi<DailyPageData["archive"]>(
    requestUrl,
    "/api/reports?limit=100",
  );
  const selectedDate =
    requestedDate && datePattern.test(requestedDate)
      ? archive.find((item) => item.reportDate === requestedDate)?.reportDate
      : archive[0]?.reportDate;
  const reportDate = selectedDate ?? archive[0]?.reportDate;
  if (!reportDate) return null;

  const report = await fetchProductionApi<DailyPageData["report"]>(
    requestUrl,
    `/api/reports/${reportDate}`,
  );
  const relatedDates = [
    ...new Set([
      ...archive
        .filter((item) => item.reportDate <= report.reportDate)
        .slice(0, 30)
        .map((item) => item.reportDate),
      ...archive
        .filter((item) => item.reportDate >= report.reportDate)
        .slice(0, 30)
        .map((item) => item.reportDate),
    ]),
  ].filter((date) => date !== report.reportDate);
  const relatedReports = await Promise.all(
    relatedDates.map((date) =>
      fetchProductionApi<DailyPageData["report"]>(
        requestUrl,
        `/api/reports/${date}`,
      ),
    ),
  );
  const reports = [report, ...relatedReports];
  const marketHistory = reports
    .filter((item) => item.reportDate <= report.reportDate)
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
    .slice(0, 30)
    .map((item) => ({
      reportDate: item.reportDate,
      sectors: item.sectorHeat,
    }));

  let weekEvents = null;
  try {
    const weekly = await fetchProductionApi<NonNullable<WeeklyPageData["report"]>>(
      requestUrl,
      `/api/weekly/${precedingSunday(report.reportDate)}`,
    );
    weekEvents = buildWeeklyEventTimeline(
      weekly,
      report.reportDate,
      reports.filter((item) => item.reportDate <= report.reportDate),
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("404")) throw error;
  }

  return {
    kind: "daily",
    language,
    market,
    requestUrl: canonicalUrl(requestUrl, "/"),
    report,
    archive,
    sectorHeat: buildSectorHeatView(report.sectorHeat, marketHistory),
    weekEvents,
    thesisLedger: deriveThesisLedger(
      reports,
      archive[0]?.reportDate ?? report.reportDate,
      market,
      report.reportDate,
    ),
  };
}

async function fetchProductionWeeklyPageData(
  requestUrl: string,
): Promise<WeeklyPageData> {
  const url = new URL(requestUrl);
  const language = resolveLanguage(url.searchParams.get("lang"));
  const requestedWeek = url.searchParams.get("week");
  const health = await fetchProductionApi<{
    latestWeekly: { weekEnd?: string } | null;
  }>(requestUrl, "/api/health");
  const weekEnd =
    requestedWeek && datePattern.test(requestedWeek)
      ? requestedWeek
      : health.latestWeekly?.weekEnd;
  if (!weekEnd) {
    return {
      kind: "weekly",
      language,
      requestUrl: canonicalUrl(requestUrl, "/weekly"),
      report: null,
      archive: [],
    };
  }
  const report = await fetchProductionApi<NonNullable<WeeklyPageData["report"]>>(
    requestUrl,
    `/api/weekly/${weekEnd}`,
  );
  return {
    kind: "weekly",
    language,
    requestUrl: canonicalUrl(requestUrl, "/weekly"),
    report,
    archive: [
      {
        weekStart: report.weekStart,
        weekEnd: report.weekEnd,
        headline: report.headline,
        summary: report.summary,
        headlineEn: report.translations?.en?.headline,
        summaryEn: report.translations?.en?.summary,
        generatedAt: report.generatedAt,
      },
    ],
  };
}

async function buildDailyPageData(
  requestUrl: string,
  db: D1Database,
): Promise<DailyPageData | null> {
  const url = new URL(requestUrl);
  const language = resolveLanguage(url.searchParams.get("lang"));
  const market = resolveMarket(url.searchParams.get("market"));
  const requestedDate = url.searchParams.get("date");
  const validDate =
    requestedDate && datePattern.test(requestedDate) ? requestedDate : null;

  let [archive, marketHistory, report] = await Promise.all([
    getDailyArchive(db),
    getDailyHeatHistory(db, validDate),
    getDailyReport(db, validDate),
  ]);

  if (!report) {
    report = await getDailyReport(db);
  }
  if (!report) return null;
  if (marketHistory[0]?.reportDate !== report.reportDate) {
    marketHistory = await getDailyHeatHistory(db, report.reportDate);
  }
  if (marketHistory.length === 0 && report.sectorHeat.length > 0) {
    marketHistory = [
      { reportDate: report.reportDate, sectors: report.sectorHeat },
    ];
  }
  const [weekEvents, thesisLedger] = await Promise.all([
    getWeeklyEventTimeline(db, report.reportDate),
    getThesisLedger(db, report.reportDate, market),
  ]);

  return {
    kind: "daily",
    language,
    market,
    requestUrl: canonicalUrl(requestUrl, "/"),
    report,
    archive,
    sectorHeat: buildSectorHeatView(report.sectorHeat, marketHistory),
    weekEvents,
    thesisLedger,
  };
}

async function buildWeeklyPageData(
  requestUrl: string,
  db: D1Database,
): Promise<WeeklyPageData> {
  const url = new URL(requestUrl);
  const language = resolveLanguage(url.searchParams.get("lang"));
  const requestedWeek = url.searchParams.get("week");
  const validWeek =
    requestedWeek && datePattern.test(requestedWeek) ? requestedWeek : null;
  const [archive, report] = await Promise.all([
    getWeeklyArchive(db),
    getWeeklyReport(db, validWeek),
  ]);
  return {
    kind: "weekly",
    language,
    requestUrl: canonicalUrl(requestUrl, "/weekly"),
    report,
    archive,
  };
}

async function dailyPage(requestUrl: string, db: D1Database) {
  try {
    const data = isLocalDevelopmentUrl(requestUrl)
      ? await fetchProductionDailyPageData(requestUrl)
      : await buildDailyPageData(requestUrl, db);
    if (!data) {
      return new Response("No daily report is available.", { status: 503 });
    }
    return renderPage(data);
  } catch (error) {
    console.error("Daily page data read failed", error);
    return new Response("Daily report is unavailable.", { status: 503 });
  }
}

async function weeklyPage(requestUrl: string, db: D1Database) {
  try {
    const data = isLocalDevelopmentUrl(requestUrl)
      ? await fetchProductionWeeklyPageData(requestUrl)
      : await buildWeeklyPageData(requestUrl, db);
    return renderPage(data);
  } catch (error) {
    console.error("Weekly page data read failed", error);
    return new Response("Weekly report is unavailable.", { status: 503 });
  }
}

app.use("/api/*", async (c, next) => {
  if (!isLocalDevelopmentUrl(c.req.url)) return next();
  const url = new URL(c.req.url);
  return fetch(productionDataUrl(c.req.url, url.pathname), {
    method: c.req.method,
    headers: { Accept: c.req.header("Accept") ?? "application/json" },
  });
});

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
