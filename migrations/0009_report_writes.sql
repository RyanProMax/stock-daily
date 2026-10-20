-- Additive: legacy content and report identity remain unchanged.
ALTER TABLE daily_reports ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE weekly_reports ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);

CREATE TABLE report_writes (
  writer_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  report_kind TEXT NOT NULL CHECK (report_kind IN ('daily', 'weekly')),
  report_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (writer_id, idempotency_key)
);
