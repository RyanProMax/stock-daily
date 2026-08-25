# Active Attribution Retrieval Requirements

## Problem

The daily pipeline discovers evidence from a fixed set of feeds, ranks a bounded
candidate pool and then asks an offline Agent to choose qualified drivers. When the
pool lacks a local closing wrap or evidence aligned with the observed leaders and
laggards, the pipeline does not search again. It currently collapses inadequate
evidence coverage and a genuinely unattributed session into the same reader-facing
result.

## Scope

- Detect evidence gaps after the existing passive collection pass.
- Derive targeted search queries from completed-session index, sector, AI-layer and
  representative-constituent moves.
- Run a bounded active retrieval pass for only the markets and layers with gaps.
- Hydrate, deduplicate, time-bound and validate active results through the existing
  attribution quality gates.
- Distinguish adequate research with no qualified driver from insufficient evidence
  coverage in internal diagnostics and reader-facing report state.
- Preserve scheduled publication, production readback and deterministic audit data.

## Non-goals

- Giving the report-writing Agent unrestricted browser or network access.
- Forcing at least one driver when no causal evidence survives validation.
- Treating search snippets, unsourced reposts or out-of-window events as facts.
- Adding a general-news feed or exposing provider, query, model or pipeline details
  to readers.
- Replacing the existing market-session, market-isolation or sector-direction gates.

## User stories

1. As a reader, I want the report to actively investigate unusual market and sector
   moves before concluding that no reliable cause was found.
2. As an operator, I want to know whether a zero-driver result reflects a completed
   but inconclusive search or inadequate evidence coverage.
3. As a maintainer, I want active retrieval to be bounded, reproducible and covered
   by deterministic tests rather than delegated to unrestricted model browsing.

## Acceptance criteria

1. After passive evidence collection, when a market lacks an eligible local closing
   wrap, the system shall execute a bounded targeted search for that market and
   completed session before report generation.
2. After passive evidence collection, when observed sector or AI-layer extremes lack
   directionally relevant event evidence, the system shall derive targeted queries
   from the market date, extreme names and representative constituents.
3. When active retrieval runs, the system shall record query intent, result counts,
   source outcomes and stop reasons in internal diagnostics without exposing those
   implementation details to readers.
4. When an active result is considered, the system shall require an HTTPS source,
   an auditable publication time, matching market-session eligibility and hydrated
   facts before it can enter the Agent input.
5. When search results include primary or first-party sources, the system shall
   prefer them over publishers and shall reject snippets or low-information pages
   that cannot be hydrated into verifiable facts.
6. When a result proposes a market driver, the existing local-wrap, market-isolation,
   sector-direction, evidence-count and causal-grounding gates shall remain in force.
7. When bounded active retrieval completes with adequate coverage but no qualified
   driver, the report shall retain an unattributed conclusion and shall not invent or
   force a cause.
8. When bounded active retrieval cannot establish adequate coverage, the report
   shall represent the state as insufficient evidence rather than claiming that a
   comprehensive search found no dominant cause.
9. When the active search provider is unavailable or times out, the scheduled run
   shall degrade to the verified passive evidence, record the coverage limitation and
   continue through validation and production readback.
10. When no evidence gap exists, the system shall skip active retrieval and preserve
    the current bounded input size and publication behavior.
11. Before release, automated tests shall cover query derivation, gap detection,
    source ranking, session filtering, provider failure, adequate-but-unattributed
    output and insufficient-coverage output.
12. Before release, the current daily workflow shall pass validation, publication to
    the configured test target where available, and production-format readback checks
    without changing weekly reports or unrelated Cloudflare resources.
