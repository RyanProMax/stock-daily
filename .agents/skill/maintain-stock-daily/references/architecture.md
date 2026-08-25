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
- `scripts/daily-policy.mjs`: shared morning/close/evening cutoffs, market dates, and material-advance policy.
- `scripts/daily-collect.mjs`: deterministic index, sector, representative-stock, AI-chain, session, and market-brief collection; the daily input contains no preselected news pool.
- `scripts/daily-agent-audit.mjs`: verifies that the completed Codex JSONL run performed distinct CN and US native searches and declared only queries that actually ran.
- `scripts/daily-source-audit.mjs`: opens every cited external source through pinned, public-address-only HTTPS requests before validation or publication.
- `scripts/daily-publish.mjs`: validates the V10 report contract, evidence/session alignment, reader copy, and market-scoped numeric grounding before constructing D1 content.
- `scripts/check-public-repo.mjs`: pre-push privacy and sensitive-file guard; CI uses Gitleaks for credential history.
- `scripts/`: remaining deterministic validation, publishing, verification, and launchd wrappers.
- `docs/codex-*-task.md`: Agent output contracts and fact boundaries.

Production flow: local deterministic market snapshot → read-only Codex native research → search and cited-source audits → report validator → Wrangler D1 write → production API readback → Hono/React SSR read.
