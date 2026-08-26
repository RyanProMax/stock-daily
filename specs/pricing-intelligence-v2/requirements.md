# Pricing Intelligence V2 Requirements

## Problem

Stock Daily currently verifies facts and renders them cleanly, but the reader-facing
output is still a replaceable news summary. Story order follows collection order,
analysis is mostly a generic positive/negative transmission sentence, named
companies can lose their ticker, upcoming events lack an expectation baseline, and
published judgments are not resolved later.

The product shall become a concise, source-traceable CN/US pricing-intelligence
brief that explains what changed relative to expectations, how the change travels
through markets, and what future observation would confirm or invalidate the view.

## Scope

- Daily collection, ranking, analysis contract, validation, persistence and SSR.
- Weekly event baselines and verified outcomes.
- A compact thesis ledger derived from daily core signals.
- Chinese and English rendering, legacy-report compatibility and production read-through during local development.
- Production migration, current-report refresh and responsive verification.

## Non-goals

- A 7x24 breaking-news terminal.
- Buy, sell, position-size or price-target recommendations.
- Invented consensus data, model-generated market prices or unsupported tickers.
- Authentication, brokerage integration or server-side portfolios in this release.
- Audio, chat or additional distribution channels before the content contract is
  proven.

## User stories and acceptance criteria

### 1. Core-signal selection

As a time-constrained reader, I want only the events that materially change market
expectations.

- When a daily report is assembled, the system shall rank stories by a deterministic
  signal score rather than collection order.
- When a story has importance below 3, the system shall exclude it from the visible
  pricing board.
- When more than five qualified stories exist for one market, the system shall show
  at most three core signals and two supporting signals for that market.
- When fewer than three importance-3-or-higher stories exist for a market, the
  system shall fail the report instead of filling it with low-signal content.
- When a core story is selected, the system shall expose the score inputs and a
  short reason in the persisted payload for auditability.

### 2. Source and entity integrity

As a reader, I want every material fact and affected company to be traceable.

- When an official or first-party URL is available for a story, the system shall
  persist it as the evidence source even if an aggregator discovered the story.
- When only a secondary source is available, the system shall label the source tier
  and shall not present it as first-party evidence.
- When a story names a listed company, the system shall persist its verified ticker
  and exchange or reject the story.
- When the model emits a ticker that is not attributable to the story facts, the
  validator shall reject or remove it.
- When a reader opens evidence, the page shall distinguish observed facts,
  deterministic calculations and model inference.

### 3. Expectation-gap analysis

As a reader, I want to know what was different from the baseline rather than merely
what happened.

- When an event has licensed or official expectation data, the system shall show
  actual, consensus, prior and a deterministic surprise value with units.
- When an earnings story contains expected and actual metrics, the system shall
  preserve the numeric values and calculate the surprise without asking the model
  to perform arithmetic.
- When a policy or company event has no numeric consensus, the system shall use a
  factual baseline such as prior policy, announced range or existing guidance and
  shall label the baseline type.
- When no defensible baseline exists, the system shall omit the expectation-gap
  row rather than generate one.

### 4. Market reaction and transmission

As a reader, I want to see what the market priced and why.

- When a selected event has a directly attributable market reaction in the input,
  the system shall show the instrument, window, change and as-of time.
- When reaction data is not available, the system shall omit it and shall not infer
  a price move from tone.
- When the Agent analyzes a core signal, it shall produce a concise thesis, a
  one-to-three-step causal chain, affected assets with an attribution basis, a time
  horizon and a confidence label.
- When an impact is second-order or conditional, the page shall label it separately
  from direct impact.
- When an interpretation only restates generic valuation, cash-flow or risk-sentiment
  language without a story-specific mechanism, the validator shall reject it.

### 5. Falsifiability and thesis ledger

As a returning reader, I want to see whether earlier judgments were borne out.

- When a core signal is published, the system shall persist a verification
  checkpoint with metric, due date, confirmation condition and invalidation
  condition.
- When a checkpoint becomes due and a verified observation exists, the system shall
  resolve the thesis as confirmed, partial, invalidated or inconclusive.
- When no verified observation exists, the system shall keep the thesis pending and
  shall not mark it successful.
- When a daily page is rendered, the pricing board shall show the most recent
  resolved or pending checkpoints relevant to that market.
- When a resolution is displayed, the page shall link to the result source and show
  the verification timestamp.

### 6. Weekly events

As a reader, I want upcoming events to carry useful baselines and verified results.

- When a weekly event has comparable data, the system shall persist expected and
  prior values with units and source attribution.
- When the event is published, the system shall calculate and display the actual
  result and surprise.
- When a result is not verified from the same authority, the event shall remain
  awaiting rather than realized.
- When daily and weekly content are rendered together, weekly event tiles shall
  remain above the daily core signals in the same pricing-board component.

### 7. Information architecture

As a reader, I want one compact research surface rather than disconnected modules.

- When a daily page is rendered, the system shall place weekly events, today’s
  pricing thesis, core signals, supporting signals and the thesis ledger inside one
  pricing-board component.
- When the market summary repeats values already visible in market cards, the system
  shall not render that duplicate prose.
- When sector leadership is shown, the system shall expose understandable measures
  such as return, relative strength and streak rather than an unexplained score
  alone.
- When the viewport is 390 CSS pixels wide, the page shall have no horizontal
  overflow and all source, expectation and verification content shall remain
  readable.

### 8. Language, accessibility and compatibility

- When English is selected, the system shall translate reader-facing inference and
  labels without changing observed numbers, source URLs, tickers or outcomes.
- When a legacy report lacks V2 fields, the server shall render it safely without
  inventing missing analysis.
- When interactive signal or evidence details are used, they shall remain keyboard
  accessible and preserve visible focus.
- When JavaScript is unavailable, the complete current report shall remain present
  in server-rendered HTML.

### 9. Quality gates and operations

- When code or contracts change, the test suite shall cover selection order, source
  tier, entity resolution, numeric surprise, generic-analysis rejection, thesis
  resolution, legacy rendering and responsive SSR.
- Before production deployment, the system shall pass TypeScript, build, unit,
  contract, style and browser checks.
- When the V2 migration is deployed, the current daily and weekly records shall be
  regenerated or upgraded and verified through the production APIs.
- When production is reviewed at desktop and 390-pixel widths, it shall show real V2
  content rather than fixture-only fields.

## Product quality targets

- Visible importance-below-3 signals: 0%.
- Named listed-company ticker and exchange coverage: 100%.
- Core signals with first-party evidence when available: 100%.
- Applicable numeric-event expectation coverage: at least 80%.
- Core signals with horizon, checkpoint and invalidation: 100%.
- Due theses with a verified resolution or explicit pending state: at least 90%.
