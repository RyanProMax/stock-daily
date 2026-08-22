# Market Attribution V9 Design

## Architecture

Collection remains deterministic and the local Agent remains bounded to supplied
facts. The market-data CLI adds the prior observation date. Stock Daily builds
market sessions, collects all sector returns, discovers event and close-wrap facts,
and asks the Agent for a compact driver set. Validation owns session eligibility,
market isolation, sector alignment and headline grounding before D1 persistence.

## Contracts

```ts
type DriverStatus = "explained" | "partial" | "unattributed";
type DriverRole = "primary" | "secondary";
type DriverEvidenceKind = "event" | "market_wrap";

interface MarketSession {
  market: "CN" | "US";
  asOf: string;
  previousAsOf: string;
  windowStart: string;
  windowEnd: string;
  wrapDeadline: string;
}

interface MarketDriver {
  id: string;
  market: "CN" | "US";
  role: DriverRole;
  title: string;
  summary: string;
  mechanism: string;
  sectorSymbols: string[];
  evidence: DriverEvidence[];
}
```

`DailyReport` adds `contractVersion=market-attribution-v9`, `marketSessions`,
`sectorPerformance` and `drivers`. `DailyMarketView` adds `driverStatus`, leader and
laggard sector symbols, and driver IDs. Existing V8 stories stay readable until the
production history is removed; V9 pages do not render them.

## Selection rules

- Event facts are eligible from the prior close through the current close.
- A `market_wrap` is eligible through `wrapDeadline` only when it contains the same
  session's market or sector move.
- A driver must reference at least one eligible fact and one same-market observed
  sector unless it is a broad macro driver explicitly attributed to the index move.
- Cross-market CN drivers additionally require an eligible local wrap that names
  the transmission and aligned CN sector.
- No driver floor exists. At most three are stored per market.
- Internal scores, horizons, confidence and future checkpoints are not reader-
  facing V9 fields.

## Rendering and compatibility

The daily route renders: causal hero, market/sector snapshot, then driver cards.
Weekly events remain on the weekly route. Archive counts use driver counts for V9
and legacy signal counts for V8. Empty archive markup is omitted.

## Release

After local and browser gates pass, production daily rows are atomically replaced
with the validated 2026-08-22 morning report. Weekly rows and ingestion audit rows
remain untouched.

