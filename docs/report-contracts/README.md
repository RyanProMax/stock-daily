# Final report contract and publication protocol

The external Agent supplies a complete daily or weekly report. Cloudflare only validates, stores and renders it. The existing bilingual CN/US, industry, AI-chain and weekly components are retained. There is no model, search, causal inference or scheduling inside these new endpoints.

## Contract

- `daily-v1.schema.json` and `weekly-v1.schema.json` reference `common-v1.schema.json` by its URN. Register the shared schema when using a standalone JSON Schema validator; no network resolver is required.
- The schemas are authoritative; `npm run contracts:generate` creates TypeScript declarations. `npm run check` detects declaration drift.
- `examples/` contains deliberately synthetic, reduced reports with example.com sources. Never publish them as real reports. Production coverage belongs to the Agent's brief; the service does not require invented items to fill a fixed count.
- Every report has `schemaVersion`, `headline`, `summary`, `generatedAt`, `cutoffAt`, and aligned English translations. Sources live with the observations/claims that use them.
- Daily identity is `reportDate` (Beijing calendar date). Keep CN and US `marketAsOf` independently equal to the actual session dates; quotes, industry/AI metrics, constituents and recap dates must match their market. Keep the other market's verified fields when updating one market. English arrays align by position with the original items, so reorder both together. Item IDs must be unique and view driver references must resolve within their market.
- Weekly identity is `weekEnd`; `weekStart` is six days earlier. Events can describe the following week. A realized event requires result/source/verification fields and an English result. The Agent must verify first-party provenance; the service checks the submitted contract, not the article.
- RFC 3339 timestamps include an offset. `cutoffAt <= generatedAt`; precise source publication times must be at or before cutoff, and verification at or before generation. Retain date-only publication precision when no exact time is available; the Agent must resolve session availability before using such evidence. Source URLs must be direct HTTPS without credentials.
- Unknown fields and unsupported schema versions are rejected. `edition`, writer identity, revision and storage time are service metadata; do not submit them. No research manifests, logs, model names, SQL or secrets belong in the report.

New payloads are validated by the same module for PUT and SSR, with TypeScript-checked adapters to the existing components. Old payloads keep the old reader without bulk conversion.

## API

| Resource | GET | PUT |
| --- | --- | --- |
| `/api/reports/YYYY-MM-DD` | Daily content + revision/hash/ETag | Full daily replacement |
| `/api/weekly/YYYY-MM-DD` | Weekly content + revision/hash/ETag | Full weekly replacement |

The existing daily archive endpoint remains available for a weekly Agent to discover dates and fetch each report. GET is public. The exact-target GET uses `Cache-Control: no-store`; new versioned `data` is the canonical submitted payload. Legacy `data` remains normalized for compatibility, so its storage hash is not a hash of that transformed response.

PUT requires production D1 and encrypted `REPORT_WRITE_TOKENS`, a JSON object mapping stable writer IDs to distinct independently revocable tokens (32–256 non-whitespace characters). Store its value only in Cloudflare Secrets and the corresponding token in the Agent secret store. It is an application credential, not a Cloudflare API token. Empty/malformed/missing configuration fails closed with 503; absent or wrong authentication returns 401. No real credential is included or provisioned in this repository. Local/preview `REMOTE_DATA_ORIGIN` mode rejects writes with 405.

Request headers:

- `Authorization: Bearer <writer token>`
- `Content-Type: application/json`
- `Idempotency-Key: <stable request key>` (1–128 letters, digits, `.`, `_`, `:`, `-`)
- Creation: `If-None-Match: *`; update: `If-Match: <exact ETag from GET>`. Missing preconditions return 428; wildcard `If-Match` is not supported.

A successful PUT returns `data` containing `kind`, `key`, `revision`, `contentHash`, `etag`, `acceptedAt`. It means persisted. GET the same target from production, verify revision/hash/content/session dates, and only then mark the scheduled event complete. A healthy database or HTTP 200 alone is not sufficient.

The content hash is lowercase SHA-256 over canonical JSON: object keys sorted lexicographically, compact JSON, array order preserved, no trailing newline. Both the PUT receipt and GET `meta` expose it; do not hash pretty-printed JSON bytes. `ETag` includes revision and hash.

## Safe update sequence

1. GET the target. On 200 retain its exact ETag; on 404 prepare creation. A 503 is not evidence of absence.
2. Generate and validate the final report externally. Save the exact payload and a fresh intended-publication key in the Agent's durable task state.
3. PUT with the headers above. The report write and receipt commit in one D1 transaction. A failed conditional write forces transaction rollback; no placeholder or partial report is accepted.
4. Read back the exact target without a cache. Compare `meta.revision/contentHash`, the contract and market dates. If the current version superseded your receipt, reconcile it; do not report the old version as current.

Retry rules:

- Same writer + key + payload/resource returns the original receipt without another write, even after a later revision. This does not assert that receipt is still the current version. An unchanged current payload with a fresh key keeps the current revision after its condition passes.
- 409: reused key with a different payload/resource, older generated time, or a market date moving backwards. Correct the intended publication and use a new key.
- 412: a competing write changed the report. Fetch the new version, intentionally merge/preserve the other market, and submit the new payload/key and ETag. Never blindly replay old content against a new ETag.
- Timeout/503: outcome may be uncertain. First GET the target, then retry the exact request/key if needed. Never create a fresh key merely because the response was lost.
- 400/415/422/428: correct JSON, content type, schema or preconditions. Validation failures preserve the previous report. Payloads over 1 MiB return 413.

Historical backfills target their own date and do not rewrite other reports or renumber their editions. Report dates, not revisions/editions, determine the archive's latest entry. Old generation `ingestion_runs` are legacy audit records: `/api/health.latestIngestion` does not certify new API publications. Use each target's receipt and readback metadata.

## Client shape (no credential literals)

The Agent runtime provides `STOCK_DAILY_ORIGIN` and `STOCK_DAILY_WRITE_TOKEN` securely. The following JavaScript illustrates the header shape; do not print request headers or put secrets in a command argument:

```js
const headers = {
  Authorization: `Bearer ${process.env.STOCK_DAILY_WRITE_TOKEN}`,
  "Content-Type": "application/json",
  "Idempotency-Key": savedRequestKey,
  ...savedPrecondition, // { "If-Match": etag } or { "If-None-Match": "*" }
};
const response = await fetch(`${process.env.STOCK_DAILY_ORIGIN}/api/reports/${report.reportDate}`, {
  method: "PUT", headers, body: JSON.stringify(report)
});
// Save the receipt, then GET and verify. Never log headers or the token.
```
