# Codex Native Research V10 Requirements

## Problem

The scheduled daily report currently gives the local Codex agent a preselected
news pool and explicitly forbids network access. When that pool misses the
session's close wrap or a sector catalyst, the agent can only publish an empty
attribution. The replacement must let the already-authenticated local Codex run
research the observed market moves itself without adding a paid search service.

## Scope

- Keep scheduling, market-data collection, validation, publication, and
  production readback on the local machine.
- Replace the fixed-feed/GDELT daily news pipeline with Codex native web search.
- Keep Cloudflare limited to report storage and website/API serving.
- Preserve historical V9 reports while publishing new reports under a V10
  contract.
- Do not change the weekly workflow.

## Requirements

### R1 — Deterministic market snapshot

When a scheduled run starts, the system shall collect the ten market metrics,
all eleven sectors per market, all eight AI-chain baskets per market, and the
corresponding market-session windows before invoking Codex.

The snapshot shall contain no preselected news pool or news-provider diagnostics.

### R2 — Native active research

When Codex receives a valid snapshot, the scheduled run shall enable Codex's
native live web-search tool and require separate, move-specific research for CN
and US.

For each market, Codex shall search at least the local close, the leading and
lagging sectors, and material AI-chain extremes. It shall open direct sources
instead of treating search-result snippets as evidence.

### R3 — Evidence-led attribution

When Codex asserts an event or macro cause, the report shall include direct,
timestamped evidence and a market-data source that demonstrates the aligned
move. First-party sources and established publishers shall outrank expert or
social commentary; expert commentary alone shall never support a causal driver.
External source authority shall be derived from the cited URL rather than
trusted from generated metadata; unknown domains and social posts shall be
treated as expert evidence.

When no discrete cause is adequately supported, the report shall still provide
a concrete structural explanation based on the deterministic market snapshot.

### R4 — Stable machine contract

When Codex completes research, it shall return JSON conforming to a versioned
JSON Schema. Each market shall contain at least one driver, exactly one primary
driver, and at most three drivers.

The reader-facing report shall never expose search queries, provider names,
model names, schemas, scores, or pipeline terminology.

### R5 — Deterministic safety boundary

While Codex is running, it shall have read-only repository access and shall not
publish, deploy, or modify source files. A deterministic validator shall verify
the snapshot, report schema, market/session alignment, evidence rules, and
numeric grounding before a separate script may publish. Numeric grounding shall
use approved fact fields only and must match magnitude, unit, and stated market
direction; dates, URLs, symbols, and internal metadata are not numeric evidence.

Before validation and publication, the system shall open every cited external
source through standard HTTPS. Model-controlled URLs and every redirect target
shall resolve only to verified public addresses, and each request shall remain
pinned to the verified destination so the audit cannot reach local, private, or
cloud-metadata services.

When validation fails, the run shall stop without changing production.

Any manual whole-history replacement path shall run the same native-search and
cited-source audits before constructing or executing destructive database SQL.
The ordinary publication command shall independently enforce those audits so it
cannot bypass the scheduler's checks.

### R6 — Search audit and failure behavior

When the native-search run finishes, the system shall retain a local JSONL audit
and verify that successful web-search activity covered both markets. Because the
event stream does not expose a reliable URL for every page interaction, it shall
not claim per-source visit proof from opaque interaction counts; the separate
source audit shall open the exact cited URLs before publication.

When search or authentication is unavailable, the run shall fail safely before
publication. A subsequent scheduled trigger may retry. Search-provider failure
shall never cause unsupported causal text to be published.

### R7 — Publication completion

When validation succeeds and publication is enabled, the system shall write the
report to Cloudflare and read it back from the production API. The scheduled run
shall be considered complete only when the readback matches the input snapshot
and the generated V10 report.

### R8 — Acceptance

Before production cutover, the implementation shall pass unit and integration
tests, a real native-search shadow run, report validation, automated code review,
and reader-facing desktop/mobile checks when the V10 report is rendered.

For the 2026-08-25 shadow fixture, the report shall produce non-empty CN and US
analysis, distinguish structural rotation from discrete events, and cite direct
sources relevant to each completed market session.

## Non-goals

- Adding Brave, NewsAPI, Alpha Vantage, or another paid search API.
- Letting Codex write directly to Cloudflare or edit application source during a
  scheduled research run.
- Forcing every trading session to have a single news catalyst.
