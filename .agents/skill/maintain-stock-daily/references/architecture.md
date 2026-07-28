# Architecture

- `src/worker.tsx`: Hono Pages entry, D1-backed SSR routes, and JSON APIs.
- `src/App.tsx`: React document plus daily and weekly server-rendered views.
- `src/client.tsx`: hydration entry; it receives embedded SSR data and does not fetch reports.
- `src/components/`: reusable React Aria controls and report presentation.
- `src/server/reports.ts`: D1 reads, legacy normalization, local fallback, and trading-day sector-heat streak aggregation.
- `src/lib/i18n.ts`: UI copy and report localization.
- `src/styles.css`: shared editorial visual system and responsive rules.
- `src/types.ts`: persisted and rendered report contracts.
- `migrations/`: D1 schema history.
- `scripts/news-pipeline.mjs`: declarative CN/US source adapters, structured feed parsing, article fact extraction, Unicode deduplication, relevance ranking, dynamic budgets, and source diagnostics.
- `scripts/daily-policy.mjs`: shared morning/close/evening cutoffs, market dates, and material-advance policy.
- `scripts/daily-collect.mjs`: market and sector collection plus orchestration of the news pipeline.
- `scripts/check-public-repo.mjs`: pre-push privacy and sensitive-file guard; CI uses Gitleaks for credential history.
- `scripts/`: remaining deterministic validation, publishing, verification, and launchd wrappers.
- `docs/codex-*-task.md`: Agent output contracts and fact boundaries.

Production flow: local collector (market facts plus deterministic CN/US sector heat) + Codex interpretation JSON → validator → Wrangler D1 write → Hono/React SSR read.
