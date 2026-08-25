# Attribution Quality Hardening Design

## Closing-wrap authority

`localMarketWrapMatches` becomes session-aware. It first rejects intraday and
foreign-benchmark language, then requires a target-market benchmark and a
publication timestamp between the official close and the existing two-hour wrap
deadline. Sector-name overlap no longer makes a story a local market wrap.

The evidence-gap assessor, anchor retention and report validator all call this one
authority function with the same session context, preventing discovery and
publication from disagreeing.

## Causal evidence

A market driver must cite two distinct evidence roles:

- a verified local closing wrap, which establishes the observed session move;
- a separate causal event containing an announcement, policy/data release,
  earnings/order, supply/demand or similarly specific catalyst.

Market breadth, price action, turnover and fund-flow reports remain useful context
but cannot independently satisfy the causal role.

## Active-discovery fallback

One grouped request per market remains the unit of work. The retriever tries the
GDELT document index first, followed by one bounded direct market hub only when the
first channel errors or yields no eligible candidates: WallstreetCN's A-share feed
for China and AP's financial-markets hub for the United States. Candidates still
need an HTTPS publisher destination, publisher-page publication metadata, hydrated
facts and session eligibility.

Diagnostics retain one market-level result plus a bounded `attempts` array. A
market search is complete when at least one provider responds successfully, even
if the bounded search is inconclusive; it is incomplete only when every attempt
fails.

## Production readback

The exact-report API uses `no-store`. The verifier rejects snapshots older than the
current collection timestamp, then retries with bounded backoff before applying the
existing field-for-field production validation. Retries never recollect, regenerate
or write the report again.

## Close timing

The close checkpoint moves from 15:00 to 16:00 Beijing. The existing launch agent
already has an hourly trigger at 16:00; the runner ignores the 15:00 trigger and the
deterministic close cutoff becomes 08:00 UTC. This retains the completed market
snapshot while allowing one hour for publisher closing wraps.

## Verification strategy

- Unit tests exercise strict wrap authority and causal-event qualification.
- Active-retrieval tests inject primary and fallback providers.
- Readback tests inject stale then current snapshots with a zero-delay waiter.
- The saved August 25 close input is checked against the new validator to prove the
  midday-only driver is rejected.
- Full build, test and security commands run after each repair cycle; submission
  occurs only once after the final clean review.
