# Automation

## Daily

- Full run: `npm run daily:run`
- Close run: `npm run daily:close`
- Evening run: `npm run daily:evening`
- Backfill: `scripts/run-codex-daily.sh --force --date YYYY-MM-DD --update-kind morning|close|evening`
- Stages: `daily:collect`, scheduled `daily:freshness`, `daily:check`, `daily:publish`, `daily:verify`
- Schedule: Beijing 09:00 morning, 15:00 close, and 21:00 evening via `com.stock-daily.codex.plist`
- Persistence: all three updates upsert the same `report_date`; later runs do not create another edition

## Weekly

- Full run: `npm run weekly:run`
- Backfill: `scripts/run-codex-weekly.sh --force --week-end YYYY-MM-DD`
- Stages: `weekly:collect`, `weekly:check`, `weekly:publish`, `weekly:verify`
- Schedule: Sunday Beijing 20:30 via `com.stock-daily.codex-weekly.plist`

Wrappers derive the repository root from their own path. Use `STOCK_DAILY_NODE_BIN_DIR`, `STOCK_DAILY_CODEX_BIN`, or `CLOUDFLARE_ACCOUNT_ID` only as local environment overrides.

Keep wrappers non-interactive, idempotent, locked, and date-gated. A failed validation must not overwrite the last successful report.
