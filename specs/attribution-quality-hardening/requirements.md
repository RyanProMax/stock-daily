# Attribution Quality Hardening Requirements

## Problem

The first active-retrieval run exposed four correctness and reliability gaps: an
intraday China wrap and a Canada close story were accepted as local closing wraps,
descriptive market-flow evidence was accepted as a causal driver, both active
search requests failed without a fallback, and immediate production readback saw
the previous report after the database write.

## Scope

- Make a local closing wrap specific to the completed target-market session.
- Require independent causal-event evidence before publishing a market driver.
- Add a bounded second active-discovery channel and useful internal attempt
  diagnostics.
- Make publication readback tolerate short propagation delays without treating an
  unverified write as complete.
- Add CI and deterministic regressions for the observed failure modes.

## Non-goals

- Forcing a driver when no causal evidence survives validation.
- Treating search snippets, intraday commentary, fund-flow summaries or foreign
  market wraps as local closing attribution.
- Exposing search providers, failures, scoring or workflow language to readers.
- Publishing, deploying or overwriting a report before all local gates pass.

## Acceptance criteria

1. When evidence is labelled as a local closing wrap, the system shall require an
   explicit target-market benchmark, completed-close wording and a publication
   time at or after that market's close and no later than its wrap deadline.
2. When a China item's title identifies it as `午间`, `半日`, `早盘` or `盘中`
   coverage, the system shall not accept it as the completed China closing wrap;
   a completed close recap may still describe price action that occurred intraday.
3. When an item is primarily about Canada, Toronto, the TSX or another foreign
   benchmark, the system shall not accept it as a U.S. closing wrap merely because
   it mentions the United States or a sector name.
4. When a report publishes a market driver, the system shall require both a valid
   local closing wrap and a different URL containing a specific causal event; a
   price, breadth, turnover or fund-flow observation alone shall not qualify.
5. When the primary active-discovery channel errors or returns no eligible result,
   the system shall try one bounded fallback channel for that market and preserve
   per-attempt internal diagnostics.
6. When all active-discovery channels fail, the system shall preserve verified
   passive evidence and publish an insufficient-evidence state instead of inventing
   a cause or aborting collection.
7. When a daily report has been written, the verifier shall retry stale production
   snapshots for a bounded period and shall complete only after the expected report
   is read back successfully.
8. When the exact-report API is requested, the production worker shall prevent CDN
   caching from serving a prior edition during verification.
9. Before submission, tests shall cover the observed China midday, Canada/US,
   non-causal-flow, primary-search failure/fallback success, all-channel failure and
   stale-readback scenarios.
10. Before submission, the current close input shall be revalidated and shall not
    retain a driver whose only closing evidence is the midday wrap.
11. The repository shall run build, full tests and the public-repository safety gate
    on GitHub pushes and pull requests.
12. When the China close checkpoint runs, collection shall wait until 16:00 Beijing
    so that completed closing wraps can enter the one-hour post-close evidence pass.
