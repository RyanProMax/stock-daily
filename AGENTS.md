# Stock Daily repository rules

## Reader-facing quality

- Reader-facing copy must contain only information that helps a reader understand the market, the evidence, or the report state.
- Never expose implementation or debugging terms in the website UI, metadata intended for readers, or market labels. This includes `API Skill`, internal provider or operation IDs, agent/model names, schema or contract names, pipeline stages, debug flags, and internal scoring terminology.
- Do not add helper prose that merely explains the page structure or the generation process.
- Prefer integrating related information into the component where it is used. Do not create a separate section that makes readers jump back to the corresponding signal when the status or result can live inside that signal.
- All dates and timestamps shown to readers must use localized, human-readable formatting. Never render raw ISO timestamps.

## Data status

- Scheduled publication is complete only after the current report passes validation, publishes, and is read back successfully from production.
- A completed scheduled event must move to a realized state promptly after its result is verified against the event authority’s first-party source.
- Deterministic facts such as supported company tickers must be derived in code from verified source text rather than relying on generated output to copy them.

## UI acceptance

- Every reader-facing UI change requires screenshots at 1440px desktop and 390px mobile widths.
- Screenshot review must cover the full page and all expanded core-signal states, not only the top of the page.
- Expanded content must have no clipped text, hidden overflow, horizontal page overflow, or off-canvas cards. Mobile layouts must present complete content without requiring a horizontal swipe inside an analysis card.
- Historical navigation must remain visually subordinate to current market data and analysis.
- Do not approve or commit a UI change until automated layout checks and visual screenshot review both pass.
