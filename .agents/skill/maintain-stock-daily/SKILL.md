---
name: maintain-stock-daily
description: Publish and maintain structured Stock Daily reports through the authenticated report API, and maintain the existing Cloudflare Pages SSR and D1 reader.
---

# Maintain Stock Daily

External dot / Grokbot tasks own research, sources, report composition and scheduling. This repository owns the final content contract, validation, rendering and storage. Do not start the legacy Codex generation wrappers for a new external publication.

## Contract and examples

- Daily: [daily-v1.schema.json](../../../docs/report-contracts/daily-v1.schema.json).
- Weekly: [weekly-v1.schema.json](../../../docs/report-contracts/weekly-v1.schema.json).
- Shared definitions: [common-v1.schema.json](../../../docs/report-contracts/common-v1.schema.json).
- Synthetic examples: [daily](../../../docs/report-contracts/examples/daily-v1.json), [weekly](../../../docs/report-contracts/examples/weekly-v1.json). They demonstrate structure, never actual market facts.
- Read [the publication protocol](../../../docs/report-contracts/README.md) before writing; read [cutover and migration](../../../docs/report-contracts/MIGRATION.md) for operations.

`src/report-contracts.generated.ts` is generated from these schemas. Change schemas first, run `npm run contracts:generate`, then `npm test`. The API and SSR adapters use this shared contract. Historical reports retain their old reader; do not bulk rewrite or delete them.

## Build a report

1. Fetch the existing target report and its `ETag` before preparing an update. Dates use `YYYY-MM-DD`; `reportDate` is a Beijing calendar date, while `marketAsOf.CN/US` are the actual market session dates. A week covers seven dates including both endpoints.
2. Research outside the service. Provide sourced quotes, observations, industry / AI views, and aligned English translations. Do not turn prices alone into causal evidence. Use stable item IDs and retain the other market's verified content when updating one market.
3. Set `cutoffAt` to the latest information allowed into the report, and `generatedAt` after composition and verification. Both require RFC 3339 offsets. Precise source publication times cannot exceed the cutoff. Preserve date-only publication precision instead of inventing a time. Sources use direct HTTPS URLs with no credentials.
4. Mark unverified attribution as partial/unresolved; do not fill missing evidence to claim completeness. A realized event requires the result, first-party result source and verification time, including its English result. Never mark an event realized just because its scheduled date passed.
5. Follow the schema exactly. No SQL, process manifests, agent/model IDs, raw research logs or credentials belong in the payload. The service validates structure and consistency; it does not verify external articles or perform financial analysis.

## Publish and verify

- The operator supplies `STOCK_DAILY_ORIGIN` and a writer token through the Agent's secret store (`STOCK_DAILY_WRITE_TOKEN` in examples). Do not print or persist the token in report JSON, logs, shell history or Git.
- The server requires production `DB` and encrypted `REPORT_WRITE_TOKENS` (a JSON map of stable writer ID to an independently revocable token, 32–256 non-whitespace characters). Never provision credentials or change deployment settings unless the user authorized that work. Agents do not need a Cloudflare management token or SQL access.
- `PUT /api/reports/:reportDate` and `PUT /api/weekly/:weekEnd` require `Authorization: Bearer …`, JSON content, and a stable `Idempotency-Key`.
- Creation: `If-None-Match: *`. Replacement: `If-Match` with the exact ETag returned by the target GET. Do not use wildcard `If-Match`.
- Save the exact payload and request key for retries. Same writer/key/payload returns the original receipt. Reusing the key for changed content or a different resource returns 409. Create a fresh key only for a new intended publication.
- A 412 means the report changed. Read the current report, preserve the other market, merge intentionally, and submit a new payload/key with its current ETag. Never blindly retry an old full report after a conflict.
- For timeouts or 503, first GET the target. Compare `meta.revision` and `meta.contentHash` with the receipt or canonical payload hash. If uncertain, retry the exact request and key. A replay may refer to a revision that a later publication superseded; it does not assert that revision is still current.
- GET the exact target from production after acceptance. Confirm the stored contract/hash and expected market dates. Only then mark the external scheduled task completed. A successful PUT means persisted, not yet end-to-end verified.
- Validation/auth failures do not change the previous report. Correct the issue before retrying. Preview/local remote-data mode is read-only. Do not route a publication through it.

## Repository maintenance

Read [architecture](references/architecture.md) for ownership and [transition operations](references/automation.md) before touching scheduling. Keep quality/security CI and deployment commands. Existing launchd jobs still refer to the legacy main checkout: do not unload them or remove their entry points before a separately authorized, verified cutover. UI work follows AGENTS.md screenshot requirements.
