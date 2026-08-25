# Codex Native Research V10 Design

## Architecture

```text
launchd
  -> deterministic market snapshot
  -> codex --search exec (read-only, JSON Schema output)
  -> search-audit check
  -> cited-source availability audit
  -> deterministic report validation
  -> Cloudflare D1 publish
  -> production API readback
```

The model owns semantic investigation and synthesis. Code owns time windows,
market data, output shape, invariants, idempotency, publication, and readback.

## Snapshot contract

`work/daily-input.json` becomes `codex-market-research-v10`. It contains market,
sector, AI-chain, and session data plus deterministic leader/laggard summaries.
It no longer imports or executes `news-pipeline.mjs` or the X precollector.

## Agent contract

The runner invokes the global CLI search flag before the subcommand:

```text
codex --search exec --json --output-schema <schema> -o <report>
```

The CLI runs with a read-only sandbox. Its JSONL event stream is written to a
local audit file, while its schema-constrained final message becomes
`work/daily-report.json`.

The report keeps the existing reader model—market views, drivers, AI-chain
views, AI updates, and English translations—but V10 drivers carry direct
evidence rather than indexes into a preselected input array. Internal research
audit fields are stripped before storage.

## Attribution model

- `structural`: deterministic index/sector/representative-constituent rotation.
- `event`: a discrete company, policy, supply, demand, or earnings development.
- `macro`: rates, economic data, currency, commodity, or policy transmission.

Every market has a structural account of what happened. Event and macro drivers
are added only with direct external evidence. A primary driver is the best
supported explanation, not necessarily a news event.

Evidence kinds are `market_data`, `market_wrap`, `event`, and `official`.
Evidence source types are `first_party`, `publisher`, and `expert`. Expert-only
causality is invalid.

## Validation

The V10 validator checks:

- exact market, sector, AI-chain, and market-session counts and dates;
- one to three drivers per market and exactly one primary driver;
- at least one structural driver per market;
- sector symbols and directions against the snapshot;
- driver and view numbers against approved fact fields from their own market and
  relevant cited evidence, matching magnitude, unit, and direction without
  accepting dates, URLs, symbols, metadata, or another market as support;
- direct HTTPS evidence URLs and session-aware publication timestamps;
- public-address resolution, destination pinning, and manual validation of each
  cited-source redirect;
- event/macro drivers include aligned market data plus non-expert external
  evidence;
- external authority is derived from a maintained first-party/publisher domain
  policy, with unknown domains and social posts downgraded to expert evidence;
- structural evidence URLs exist in the snapshot;
- translations map one-to-one to generated drivers and AI updates;
- X attribution handles match the account in the cited status URL, and
  reader-facing copy contains neither raw ISO dates nor implementation terms.

The publication command repeats the search-event and cited-source audits before
constructing completed-run SQL. Validation or audit failures happen outside the
publication error-recording boundary, so they cannot mutate production state.

## Compatibility and rollback

Stored V9 reports remain readable. The website treats both V9 and V10 as market
attribution reports. No database migration is required because report content is
stored as JSON. The V9 publisher code and news pipeline are removed only after
the V10 tests and shadow run pass; rollback remains available through Git.

## Testing

- Contract tests for valid and invalid V10 snapshots/reports.
- Search-audit tests for CN/US coverage, missing search, and failed turns.
- Source-audit tests proving every cited external URL is opened before
  validation and private-network or metadata destinations are rejected.
- Scheduler-source tests confirming `--search`, read-only sandbox, output schema,
  validation-before-publish, and production readback.
- Real shadow run for 2026-08-25 with publication disabled.
- Existing build, full test suite, and automatic Codex review.
- Desktop 1440px and mobile 390px full-page/expanded-driver screenshots.
