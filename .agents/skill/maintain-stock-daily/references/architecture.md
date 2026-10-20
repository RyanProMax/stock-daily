# Architecture

- `docs/report-contracts/`: authoritative final daily/weekly JSON Schemas, shared definitions, synthetic examples and the publication protocol.
- `scripts/report-contract-types.mjs`: deterministic schema-to-TypeScript declarations; `contracts:check` prevents drift.
- `src/contracts/reports.ts`: Workers-compatible JSON Schema validation, structural/date/reference consistency, and compile-time checked adapters to the existing renderer.
- `src/server/report-writes.ts`: scoped report authentication, GET metadata, conditional PUT, canonical hashes, atomic D1 content + idempotency receipts.
- `src/worker.tsx`: Hono Pages entry, SSR and report APIs. Local/preview remote-data mode remains GET-only.
- `src/server/reports.ts`: D1 reads. Versioned reports use the final contract directly; old reports keep legacy normalization and historical presentation helpers.
- `src/App.tsx`, `src/components/`, `src/lib/i18n.ts`, `src/styles.css`: existing bilingual CN/US, industry/AI and weekly presentation. No research or model calls.
- `src/types.ts`: legacy reader and presentation types; `src/report-contracts.generated.ts`: final contract types derived from schemas.
- `migrations/0009_report_writes.sql`: additive revision columns and write receipts; no historical content conversion.
- `.github/workflows/quality.yml`, `security.yml`: build/test and repository safety, not generation or scheduling.

Target flow: external Agent research → final report JSON → authenticated PUT → D1 transaction → production GET/readback → existing SSR.

Legacy collectors, research scripts and launchd wrappers remain temporarily for safe cutover. They are not dependencies of the new report API or runtime validator. Do not move them into the Skill or add financial analysis to the service.
