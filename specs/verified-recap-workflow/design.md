# Verified Market Recap Workflow Design

## Runtime flow

```text
collect deterministic market data
  -> research Agent: hypotheses + sourced report
  -> search-event audit
  -> source accessibility audit
  -> deterministic report validator
  -> independent review Agent
  -> review-event audit + review score gate
       pass   -> publish -> production readback
       revise -> feedback -> research Agent (maximum three attempts)
```

## Internal hypothesis ledger

`researchAudit.<market>.hypotheses` is stripped before publication. Each item stores:

- stable ID within the report;
- causal category and concise claim;
- affected market, sector, layer or company targets;
- supporting external URLs;
- counter-evidence or the exact missing proof;
- `accepted`, `rejected` or `unresolved` verdict;
- `market_driver`, `ai_update` or `none` publication target;
- exact published title when accepted.
- exact published causal claim when accepted;
- source-level causal-evidence records containing the supported proposition,
  narrowest supported scope and exact targets.

The deterministic validator checks the ledger-to-report edges. It does not attempt
to infer causality from prose.

For a market driver, at least one causal-evidence record must support either the
whole market or an explicitly listed first-level sector. For an AI update, at least
one record must support the named AI layer or a company whose input quote is bound
to that layer. A thematic source that merely mentions the same topic cannot satisfy
this edge.

When evidence supports only a subsector, the driver records `subsector` plus a
reader-facing target such as `券商` or `工业金属`. Its first-level `sectorSymbols`
remain only a placement link; they do not widen the causal claim.

## Independent review contract

The review output is stored locally and never published. It contains:

- global and per-market pass/revise verdicts;
- one or more independently executed queries per market;
- five integer quality scores from 1 to 5;
- concrete issues and revision actions;
- explicit booleans for unsupported claims, fact-restatement, source traceability
  and alternative testing.
- one itemized claim verdict for every published driver and AI update, including
  the source inspected and the narrowest scope that source actually supports.

The reviewer may approve a market with no published cause when the hypothesis ledger
shows a serious but inconclusive search. It must reject a report that simply restates
leaders, laggards or constituent contributions as reasons.

## Retry behavior

The scheduler keeps the prior review JSON and the last deterministic error as
read-only feedback for the next research attempt. Each attempt starts with a fresh
report and event log. The gate is never relaxed. After the third failure the task
exits non-zero and leaves production untouched.

Research and review commands run through a process-group timeout wrapper. Research
defaults to fifteen minutes and review to ten minutes, both configurable for local
operations. In addition, five minutes without research events or four minutes
without review events is treated as a stall. Either timeout sends `SIGTERM` to the
complete spawned group, escalates to `SIGKILL` after five seconds and returns exit
code 124 so the scheduler can distinguish a hang from an ordinary model failure.

Research defaults to low reasoning effort because a real full-input probe reached
file reads and native search promptly at that setting, while medium repeatedly
stalled before the first tool call. The independent reviewer remains at medium
effort, and all deterministic evidence gates remain unchanged.

Every failed gate writes its exact diagnostic to `work/daily-attempt-error.txt`.
The next research attempt must read that file before searching. This makes source
availability failures, unsupported numeric claims and review revisions actionable
instead of repeating the same invalid output across all three attempts.
