# Active Attribution Retrieval Design

## Overview

The fixed-source pass remains the first and primary evidence path. After its
session-filtered evidence is hydrated, a deterministic coverage assessor compares
the evidence with the completed market session and the strongest sector and AI
chain moves. Only missing coverage produces active-search intents.

The active retriever uses the GDELT DOC API as a discovery index. Search results
are not facts: every result must expose an HTTPS publisher URL and publication
time, fit the relevant market session, and survive the existing article hydration,
deduplication, ranking and attribution gates before it reaches report generation.

## Flow

1. Start fixed-source discovery, market data, sector data, AI-chain data and X
   collection concurrently.
2. Hydrate and session-filter the fixed-source candidates.
3. For each market, assess:
   - presence of a local closing wrap;
   - evidence overlap with the largest sector moves;
   - evidence overlap with the largest AI-chain moves.
4. Build at most three intents per market: one market-wrap intent, one combined
   sector-extremes intent and one combined AI-extremes intent.
5. Execute one bounded search request per market, map results back to intents, and
   hydrate a capped result set.
6. Merge eligible active evidence with fixed-source evidence, then apply the
   existing selection caps and attribution validators.
7. Persist an internal coverage diagnostic per market. A market is `adequate` when
   its local wrap exists and all required active searches completed; it is
   `insufficient` when the wrap remains absent or a required search cannot complete.

## Data model

`newsDiagnostics.activeRetrieval` contains:

- `attempted`: whether any gap caused active retrieval;
- `queryCount`, `candidateCount`, `hydratedCount`, `rejectedDuringHydration`;
- `searches`: per-market intent IDs, status, result count and a bounded error;
- `coverageByMarket`: `adequate` or `insufficient`, plus missing intent kinds.

Provider names, queries and operational errors remain internal. Published reports
only use the coverage state to distinguish insufficient evidence from an adequate
but inconclusive attribution pass.

## Failure behavior

- A provider error never discards verified fixed-source evidence and never aborts
  the scheduled run.
- No search snippet is accepted as an evidence fact.
- Empty successful search results can still establish that a bounded query ran,
  but a missing local closing wrap keeps the market coverage insufficient.
- Existing market-session, local-wrap, direction, corroboration and grounding
  checks remain authoritative.

## Testing

Unit tests inject search responses and article hydration so they do not depend on
the live provider. They cover intent derivation, no-gap skipping, session filtering,
source preference, failure degradation and final coverage status. Existing daily
validation tests cover the merged payload and report contract.
