import { readFile, writeFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const reportsPath = new URL("data/reports.json", projectRoot);
const insightsPath = new URL("data/story-insights.json", projectRoot);
const migrationPath = new URL(
  "migrations/0003_compact_reports_and_ingestion.sql",
  projectRoot,
);

const [sourceReports, insights] = await Promise.all([
  readFile(reportsPath, "utf8").then(JSON.parse),
  readFile(insightsPath, "utf8").then(JSON.parse),
]);

function compactMarket(market) {
  return {
    region: market.region,
    name: market.name,
    ...(market.symbol ? { symbol: market.symbol } : {}),
    value: market.value,
    change: market.change,
    direction: market.direction,
    note: market.note,
    ...(market.source ? { source: market.source } : {}),
  };
}

function compactStory(story) {
  const ai = story.ai ?? insights[story.id];
  if (!ai) throw new Error(`Missing AI interpretation for story ${story.id}`);

  return {
    id: story.id,
    regions: story.regions,
    category: story.category,
    importance: story.importance,
    title: story.title,
    summary: story.summary,
    evidence: story.evidence,
    source: story.source,
    sourceLabel: story.sourceLabel,
    ...(story.publishedAt ? { publishedAt: story.publishedAt } : {}),
    ai: {
      tone: ai.tone,
      interpretation: ai.interpretation,
      sectors: ai.sectors,
      tickers: ai.tickers,
    },
  };
}

function compactOverview(report) {
  const overview = report.overview ?? report.thesis ?? report.leadPoints;
  if (!Array.isArray(overview)) return overview;
  return overview.slice(0, 2);
}

for (const report of sourceReports) {
  if (
    typeof report.agentModel !== "string" ||
    report.agentModel.length === 0 ||
    report.isSample
  ) {
    throw new Error(
      `${report.reportDate ?? "unknown date"} is not an audited Agent report`,
    );
  }
}

const reports = sourceReports
  .map((report) => ({
    reportDate: report.reportDate,
    edition: Number(report.edition),
    generatedAt: report.generatedAt,
    dataCut: report.dataCut,
    ...(report.updateKind ? { updateKind: report.updateKind } : {}),
    ...(report.marketAsOf ? { marketAsOf: report.marketAsOf } : {}),
    headline: report.headline,
    summary: report.summary,
    overview: compactOverview(report),
    marketViews: report.marketViews,
    markets: report.markets.map(compactMarket),
    sectorHeat: report.sectorHeat,
    stories: report.stories.map(compactStory),
    agentModel: report.agentModel,
    isSample: Boolean(report.isSample),
    ...(report.translations ? { translations: report.translations } : {}),
  }))
  .sort((a, b) => b.reportDate.localeCompare(a.reportDate));

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const rows = reports.map((report) => {
  const content = JSON.stringify({
    overview: report.overview,
    marketViews: report.marketViews,
    ...(report.updateKind ? { updateKind: report.updateKind } : {}),
    ...(report.marketAsOf ? { marketAsOf: report.marketAsOf } : {}),
    markets: report.markets,
    sectorHeat: report.sectorHeat,
    stories: report.stories,
    isSample: report.isSample,
    ...(report.translations ? { translations: report.translations } : {}),
  });

  return `(
  ${sqlString(report.reportDate)},
  ${report.edition},
  ${sqlString(report.headline)},
  ${sqlString(report.summary)},
  ${sqlString(report.generatedAt)},
  ${sqlString(report.dataCut)},
  ${sqlString(report.agentModel)},
  ${sqlString(content)}
)`;
});

const migration = `PRAGMA foreign_keys = OFF;

CREATE TABLE daily_reports_compact (
  report_date TEXT PRIMARY KEY CHECK (length(report_date) = 10),
  edition INTEGER NOT NULL CHECK (edition > 0),
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  data_cut TEXT NOT NULL,
  agent_model TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO daily_reports_compact (
  report_date,
  edition,
  headline,
  summary,
  generated_at,
  data_cut,
  agent_model,
  content
) VALUES
${rows.join(",\n")};

DROP TABLE daily_reports;
ALTER TABLE daily_reports_compact RENAME TO daily_reports;

CREATE INDEX idx_daily_reports_date_desc
  ON daily_reports (report_date DESC);
CREATE UNIQUE INDEX idx_daily_reports_edition
  ON daily_reports (edition DESC);

CREATE TABLE ingestion_runs (
  run_id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL CHECK (length(report_date) = 10),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  market_count INTEGER NOT NULL DEFAULT 0 CHECK (market_count >= 0),
  news_count INTEGER NOT NULL DEFAULT 0 CHECK (news_count >= 0),
  error TEXT
);

CREATE INDEX idx_ingestion_runs_started_at
  ON ingestion_runs (started_at DESC);

PRAGMA foreign_keys = ON;
`;

await Promise.all([
  writeFile(reportsPath, `${JSON.stringify(reports, null, 2)}\n`),
  writeFile(migrationPath, migration),
]);

console.log(
  `Compacted ${reports.length} reports and generated ${migrationPath.pathname}.`,
);
