PRAGMA foreign_keys = OFF;

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
  content,
  created_at,
  updated_at
)
SELECT
  report_date,
  edition,
  title,
  summary,
  generated_at,
  COALESCE(json_extract(payload, '$.dataCut'), ''),
  COALESCE(json_extract(payload, '$.agentModel'), 'legacy'),
  json_remove(
    payload,
    '$.reportDate',
    '$.edition',
    '$.headline',
    '$.title',
    '$.summary',
    '$.generatedAt',
    '$.dataCut',
    '$.agentModel'
  ),
  created_at,
  updated_at
FROM daily_reports;

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
