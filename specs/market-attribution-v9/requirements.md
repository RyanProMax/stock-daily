# Market Attribution V9 Requirements

## Problem

The daily report ranks generally important news instead of explaining the completed
market session. It can therefore show US stories as CN core signals, omit the
sectors that led or lagged, and generate archive headlines that repeat the market
direction without naming a cause.

## Scope

- Completed-session boundaries for CN and US.
- Full eleven-sector performance for each market.
- Evidence-backed market drivers, causal headlines, persistence, SSR and bilingual
  rendering.
- A single audited 2026-08-22 morning report whose CN and US market dates are both
  2026-08-21.

## Non-goals

- Index-weighted sector contribution in this release.
- A general-news feed inside the daily report.
- Investment recommendations, inferred facts or forced explanations.

## Acceptance criteria

1. When a daily input is collected, the system shall persist the latest and prior
   completed trading dates and an attribution window for CN and US independently.
2. When sector performance is collected, the system shall retain all eleven first-
   level sectors per market and derive leaders and laggards from observed returns.
3. When an event is considered as a driver, the system shall require its facts to
   fall inside the matching market session; a same-session market wrap may arrive
   no later than two hours after the close.
4. When a US or global event is proposed for CN, the system shall require a sourced
   local transmission and a directionally aligned CN sector; otherwise it shall be
   excluded from CN.
5. When no qualified driver exists, the report shall publish an unattributed market
   view rather than fail or fill the page with unrelated news.
6. When a market has qualified drivers, the report shall publish at most one
   primary and two secondary drivers and shall persist only their bounded evidence.
7. When a headline is generated, it shall name a grounded driver or observed sector
   and the market result; generic direction-only headlines shall be rejected.
8. When the daily page renders, it shall show the causal headline, completed market
   move, sector leaders and laggards, and no more than three driver cards.
9. When no earlier report is available, the page shall omit historical navigation
   and the archive section.
10. Before release, automated layout checks and full-page 1440px and 390px expanded-
    state screenshots shall pass without clipping or horizontal overflow.

