CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL UNIQUE CHECK (length(report_date) = 10),
  edition INTEGER NOT NULL CHECK (edition > 0),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  signal_count INTEGER NOT NULL DEFAULT 0 CHECK (signal_count >= 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_date_desc
  ON daily_reports (report_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_reports_edition
  ON daily_reports (edition DESC);
