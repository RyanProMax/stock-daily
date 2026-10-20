# Transition operations

The new report service has no scheduler, model runner or Agent orchestration framework. An external dot / Grokbot task reads the Skill, builds a final report, conditionally PUTs it, then verifies production GET before marking completion.

The legacy main checkout is still referenced by loaded `com.stock-daily.codex` and `com.stock-daily.codex-weekly` launchd jobs. Their entry points are `scripts/run-codex-daily.sh` and `scripts/run-codex-weekly.sh`. The scripts gate on Beijing dates/times and have local lock/checkpoint logic. The daily intent is morning 09:00, CN close 15:00 and evening 21:00; weekly intent is Sunday 20:30. Actual launchd calendar entries include compensation windows in the host timezone, so do not copy those hours into another scheduler verbatim.

Do not change active main, launchd configuration, production D1 or real credentials during the local implementation phase. Keep the old entry points and npm tasks until the new route, migrated database, writer credential and an external report have passed end-to-end readback. Then, under explicit cutover authorization, stop the old writers before enabling the new writer. Never run both paths concurrently as a normal update strategy.

After cutover, remove legacy generation entry points and their transitive collector/research/publish modules, process-only contracts/prompts/data and corresponding tests together. Retain final schemas, generated declarations, API/SSR tests, historical compatibility, quality/security CI, migrations and deployment commands. See `docs/report-contracts/MIGRATION.md` for the ordered checklist.
