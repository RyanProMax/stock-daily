import { Hono } from "hono";
import { renderToReadableStream } from "react-dom/server.edge";
import Document, {
  publicPageData,
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
  getThesisHistory,
  getThesisLedger,
  getWeeklyArchive,
  getWeeklyEventTimeline,
  getWeeklyReport,
} from "./server/reports";

type Bindings = {
  DB?: D1Database;
  REMOTE_DATA_ORIGIN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const productionOrigin = "https://stock-daily-8k4.pages.dev";
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

function resolveMarket(value: string | null): MarketRegion {
  return value?.toUpperCase() === "US" ? "US" : "CN";
}

function remoteDataOrigin(env: Bindings) {
  const configured = env.REMOTE_DATA_ORIGIN?.trim();
  if (!configured) return null;
  const url = new URL(configured);
  if (url.protocol !== "https:") {
    throw new Error("REMOTE_DATA_ORIGIN must use HTTPS.");
  }
  return url.origin;
}

function database(env: Bindings) {
  if (!env.DB) throw new Error("Production D1 binding is unavailable.");
  return env.DB;
}

function remoteUrl(origin: string, requestUrl: string, pathname?: string) {
  const request = new URL(requestUrl);
  const target = new URL(pathname ?? request.pathname, origin);
  target.search = request.search;
  return target;
}

async function fetchRemotePageData<T>(
  origin: string,
  pathname: string,
  requestUrl: string,
): Promise<T> {
  const response = await fetch(remoteUrl(origin, requestUrl, pathname), {
    headers: { Accept: "application/json" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { data?: T };
  if (!Object.prototype.hasOwnProperty.call(payload, "data")) {
    throw new Error(`${pathname} returned an invalid payload.`);
  }
  return payload.data as T;
}

async function proxyRemoteApi(request: Request, origin: string) {
  const response = await fetch(remoteUrl(origin, request.url), {
    headers: { Accept: request.headers.get("Accept") ?? "application/json" },
    redirect: "follow",
  });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function renderPage(data: PageData) {
  const stream = await renderToReadableStream(<Document data={data} />, {
    onError(error) {
      console.error("SSR render failed", error);
    },
  });
  return new Response(stream, { headers: cacheHeaders });
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
  const [weekEvents, thesisLedger, thesisHistory] =
    [
      "market-attribution-v9",
      "codex-market-research-v10",
      "codex-market-research-v11",
    ].includes(
      report.contractVersion ?? "",
    )
      ? [null, [], []]
      : await Promise.all([
          getWeeklyEventTimeline(db, report.reportDate),
          getThesisLedger(db, report.reportDate, market),
          getThesisHistory(db, report.reportDate, market),
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
    thesisHistory,
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

async function dailyPage(requestUrl: string, env: Bindings) {
  try {
    const origin = remoteDataOrigin(env);
    const data = origin
      ? await fetchRemotePageData<DailyPageData>(
          origin,
          "/api/page/daily",
          requestUrl,
        )
      : await buildDailyPageData(requestUrl, database(env));
    if (!data) {
      return new Response("No daily report is available.", { status: 503 });
    }
    return renderPage(data);
  } catch (error) {
    console.error("Daily page data read failed", error);
    return new Response("Daily report is unavailable.", { status: 503 });
  }
}

async function weeklyPage(requestUrl: string, env: Bindings) {
  try {
    const origin = remoteDataOrigin(env);
    const data = origin
      ? await fetchRemotePageData<WeeklyPageData>(
          origin,
          "/api/page/weekly",
          requestUrl,
        )
      : await buildWeeklyPageData(requestUrl, database(env));
    return renderPage(data);
  } catch (error) {
    console.error("Weekly page data read failed", error);
    return new Response("Weekly report is unavailable.", { status: 503 });
  }
}

app.use("/api/*", async (c, next) => {
  const origin = remoteDataOrigin(c.env);
  if (!origin) return next();
  if (c.req.method !== "GET") {
    return c.json(
      { error: { message: "Local API access is read-only.", status: 405 } },
      405,
    );
  }
  return proxyRemoteApi(c.req.raw, origin);
});

app.get("/api/page/daily", async (c) => {
  try {
    const data = await buildDailyPageData(c.req.url, database(c.env));
    if (!data) {
      return c.json(
        { error: { message: "Daily report not found.", status: 404 } },
        404,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json({ data: publicPageData(data) });
  } catch {
    return c.json(
      { error: { message: "Daily page data is unavailable.", status: 503 } },
      503,
    );
  }
});

app.get("/api/page/weekly", async (c) => {
  try {
    const data = await buildWeeklyPageData(c.req.url, database(c.env));
    c.header("Cache-Control", "no-store");
    return c.json({ data });
  } catch {
    return c.json(
      { error: { message: "Weekly page data is unavailable.", status: 503 } },
      503,
    );
  }
});

app.get("/api/health", async (c) => {
  try {
    const db = database(c.env);
    const [row, latestRun, latestWeekly] = await Promise.all([
      db.prepare(
        "SELECT COUNT(*) AS reportCount FROM daily_reports",
      ).first<{ reportCount: number }>(),
      db.prepare(
        `SELECT report_date AS reportDate, finished_at AS finishedAt, status
         FROM ingestion_runs
         ORDER BY finished_at DESC, started_at DESC
         LIMIT 1`,
      ).first(),
      db.prepare(
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
    const data = await getDailyArchive(database(c.env), limit);
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
    const data = await getDailyReport(database(c.env), date);
    if (!data) {
      return c.json(
        { error: { message: "Daily report not found.", status: 404 } },
        404,
      );
    }
    c.header("Cache-Control", "no-store");
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
  const data = await getWeeklyReport(database(c.env), weekEnd);
  if (!data) {
    return c.json(
      { error: { message: "Weekly report not found.", status: 404 } },
      404,
    );
  }
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ data });
});

app.get("/", (c) => dailyPage(c.req.url, c.env));
app.get("/weekly", (c) => weeklyPage(c.req.url, c.env));
app.get("/weekly/", (c) => weeklyPage(c.req.url, c.env));

app.notFound((c) =>
  c.json({ error: { message: "Not found.", status: 404 } }, 404),
);

export default app;
