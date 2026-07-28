CREATE TABLE IF NOT EXISTS weekly_reports (
  week_end TEXT PRIMARY KEY CHECK (length(week_end) = 10),
  week_start TEXT NOT NULL CHECK (length(week_start) = 10),
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  agent_model TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_week_end_desc
  ON weekly_reports (week_end DESC);
