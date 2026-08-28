# Verified Market Recap Workflow Research

## Objective

Build a free, local-Codex-driven daily recap that explains why markets moved without
turning price changes into fake causes. The workflow must prefer a shorter or empty
attribution section over unsupported narrative, while still proving that it actively
tested plausible explanations.

## Community patterns reviewed

1. [FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) separates data
   processing, financial-concept interpretation and thesis/report synthesis. Its
   companion paper evaluates reports on factual accuracy, logical coherence and
   storytelling rather than schema validity alone.
2. [TradingAgents](https://github.com/TauricResearch/TradingAgents) separates news,
   market and technical analysts from bullish/bearish researchers and a final
   decision layer. The useful pattern here is adversarial review of candidate
   explanations, not the trading recommendation machinery.
3. [LangGraph evaluator-optimizer](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/workflows-agents.mdx)
   uses a generator, a structured evaluator and feedback-driven regeneration until
   explicit success criteria pass.
4. [OpenBB](https://docs.openbb.co/) treats normalized market data and research data
   access as a separate layer that can be reused by agents and applications.
5. The local `stock-kol-intel` evidence rules reinforce the same boundary: record a
   source ledger, separate facts from inference, preserve uncertainty, cross-check
   claims, and omit weak or unverifiable claims rather than padding the report.

## Diagnosis of the existing workflow

- It audits the number and market classification of search queries, not whether the
  searches tested competing causal hypotheses.
- It validates evidence URLs and numerical consistency, but the URL audit only
  proves that a page responds; it does not independently judge whether the page
  supports the causal claim.
- It asks one Agent to research and write the final report in one pass. The same
  model that formed a claim also decides whether that claim is good enough.
- A failed source or validation check aborts the scheduled run. The error is not fed
  back into a bounded rewrite loop.
- The final schema does not retain an internal claim-to-source ledger, so a valid
  final driver does not prove that alternatives were tested or rejected.

## Adopted design

Use a lightweight, two-role evaluator-optimizer while keeping all market data and
Cloudflare behavior unchanged:

1. Deterministic collection produces the move map.
2. The research Agent creates at least three causal hypotheses per market, searches
   for support and counter-evidence, and records accepted, rejected and unresolved
   hypotheses in an internal ledger.
3. Only an accepted hypothesis may become a reader-facing market driver or AI-chain
   update. Its published title and at least one external source must trace back to
   the ledger.
4. Existing deterministic validation and source accessibility checks run.
5. A separate review Agent independently opens every cited external source, runs a
   fresh targeted query for each market, and grades factual accuracy, causal logic,
   evidence directness, alternative testing and reader utility.
6. A deterministic review gate accepts only all-pass reviews with every dimension
   at least 4/5. Otherwise feedback is supplied to a fresh research attempt.
7. The scheduler performs at most three attempts. A third failure ends without
   publication; it never weakens the gate or publishes the best-looking failure.

This design deliberately does not add a paid feed, a hosted model, an unrestricted
web crawler or reader-facing process metadata.
