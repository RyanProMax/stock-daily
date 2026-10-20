# Local implementation and later cutover

## Recorded baseline

Inspection on 2026-10-20 found a clean local main at `b9dc78aee6f595a4c819d94d7b16892bacdf9418` (2026-10-03T04:46:21Z). GitHub main was `a4f619809888812676107d95cc082f9847dcdf8f` (2026-08-29T13:59:37Z). Git ancestry, not timestamp ordering, establishes that local main contains GitHub main and is ahead by 57 commits with no divergence. Those commits include the complete recap and failed-research recovery work and are retained.

This change is prepared on `codex/external-report-api` in an independent local clone. The active main checkout and loaded launchd jobs are not changed. No production D1 writes, credentials, schedules, push or deployment are part of this stage.

## Database and historical compatibility

Migration 0009 adds `revision` (default 0) to each existing report table and creates `report_writes` for per-writer idempotency receipts. It does not transform content, drop tables, reseed history or alter existing identities/editions. It must be applied before deploying the new exact-target read/write APIs. Tests execute historical migrations, insert legacy reports, apply 0009 and verify unchanged content/metadata and successful reads/upgrades.

New reports store the full final contract in `content`; selected existing scalar columns are maintained for archive compatibility. New daily editions use the next available identifier, not an instruction to reorder/renumber older reports. Historical rendering uses the legacy normalizer; new versioned content is schema-validated and passed directly to the existing display adapter. The legacy ingestion log is not a completion indicator for new external publications.

## Cutover order (requires later authorization)

1. Confirm the actual Pages deployment, production D1 binding and accepted origin in Cloudflare. The repository declares Pages `stock-daily`, D1 `stock-daily-db`, and `stock-daily-8k4.pages.dev`; this local change does not verify their live bindings or deployed revision.
2. Back up D1 and inspect migration status. Apply 0009 once through the existing deployment/admin process. Do not rerun seed/replacement scripts or rewrite historical payloads. Preserve the backup for rollback; additive columns can remain if the application is rolled back.
3. Deploy the new service with production `DB` and encrypted `REPORT_WRITE_TOKENS`; preview/local stay read-only. Credential creation, storage and rotation are a separate authorized operational step. Never distribute SQL or Cloudflare management permissions to the reporting Agent.
4. Under cutover authorization, pause the old writers for a controlled publication window. Publish a real externally generated daily and weekly report; verify production GET hash/content and existing desktop/mobile rendering. Resume old writers if cutover is abandoned; do not leave both writers active.
5. Once end-to-end acceptance passes, permanently disable the old daily/weekly launchd jobs and enable the external scheduler with explicitly chosen timezone/session policy. The target task is complete only after production readback.
6. Remove the old generation chain in a separate review: `run-codex-{daily,weekly}.sh`, their generation npm commands, collector/research/orchestration/publish scripts and transitive provider-only dependencies, process contracts/prompts under `docs/daily-agents/`, old Codex task instructions, research-only data and associated tests. Do a dependency/reference audit before deleting any shared display/read helper. Keep schema/type generation, API/SSR/compatibility tests, security checks, quality/security CI, historical migrations and deployment ability.

The old pipeline is intentionally retained in this first-stage branch while the main checkout's launchd references remain active. Its entry points and dependency closure are not broken by this change. Do not migrate the large old research framework into the new API or Skill.
