# Verified Market Recap Workflow Requirements

## Functional requirements

1. Each researched market must record at least three distinct causal hypotheses.
2. Each hypothesis must record a claim, category, affected targets, supporting
   source URLs, counter-evidence or missing-proof note, verdict and verdict reason.
3. At least one hypothesis per market must be rejected or unresolved so the ledger
   demonstrates alternative testing rather than post-hoc confirmation.
4. Every published driver and AI update must map to exactly one accepted hypothesis
   by title and share at least one non-market-data evidence URL with it.
5. Rejected and unresolved hypotheses must never appear in reader-facing drivers or
   AI updates.
6. A separate review run must independently search both markets and open every cited
   external source before it can pass the report.
7. Review must grade factual accuracy, causal logic, evidence directness,
   alternative testing and reader utility on a five-point scale.
8. Publication requires a global pass, a pass for both markets, all five dimensions
   at least 4/5, no unresolved review issue, and all deterministic quality checks.
9. Failed generation, search audit, source audit, report validation or review must
   feed a concise error or structured review back into the next attempt.
10. The scheduled workflow must stop after at most three attempts. Exhaustion exits
    without publishing or marking the schedule complete.
11. Every accepted hypothesis must state, for each supporting source, the exact
    causal proposition it supports and the narrowest supported scope (market,
    sector, subsector, AI layer or company).
12. The published mechanism must exactly match the accepted hypothesis claim that
    was checked against those causal-evidence records.
13. The independent reviewer must return one itemized verdict for every published
    driver and AI update; a report cannot pass on aggregate scores alone.
14. A subsector catalyst may be attached to its parent first-level sector for page
    placement, but all causal copy and review scope must remain at the subsector.
15. Every research and review model invocation must have a bounded wall-clock
    duration and terminate its spawned process tree when the bound is exceeded.
16. Every retry after generation, search, source, report or review failure must read
    the exact prior failure and avoid repeating the rejected URL, number or claim.

## Acceptance requirements

1. Automated tests cover hypothesis traceability, rejected-hypothesis leakage,
   independent review-event auditing, review score gates and the three-attempt cap.
2. A real current-report shadow run must complete generation, deterministic checks
   and independent review without writing Cloudflare state.
3. Human acceptance inspects the resulting CN and US recap and confirms that each
   published reason adds causal information beyond the already-visible price facts.
4. If the first real run fails acceptance, the failure must be classified and used
   to revise the workflow before a second run. The same applies once more before the
   third and final run.
5. Weekly reports and unrelated Cloudflare resources remain unchanged.
6. A hung model invocation exits with a distinct timeout result, advances the
   bounded retry loop and leaves no child process or publication behind.
6. Numeric grounding must accept the deterministic ten-year Treasury tenor while
   continuing to reject ungrounded market numbers.
