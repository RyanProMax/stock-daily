# Pricing Intelligence V2 Implementation Plan

- [x] 1. Establish V2 contracts and compatibility
  - Add source, metric, reaction, transmission, exposure and checkpoint types.
  - Normalize legacy reports without inventing V2 fields.
  - Add contract fixtures and serialization coverage.
  - _Requirements: 2, 3, 4, 5, 8_

- [x] 2. Add deterministic enrichment and ranking
  - Classify evidence-source tier and canonical source.
  - Resolve listed-company aliases to ticker and exchange.
  - Extract deterministic metrics/reactions from bounded facts.
  - Rank qualified signals and enforce core/supporting limits and floors.
  - _Requirements: 1, 2, 3_

- [x] 3. Upgrade the daily Agent contract and validator
  - Provide enriched candidates to Codex.
  - Require thesis, causal chain, exposure basis, horizon and checkpoint.
  - Reject generic analysis, unsupported entities and investment instructions.
  - Preserve numeric values and bilingual fact identity.
  - _Requirements: 2, 3, 4, 5, 8_

- [x] 4. Add thesis resolution and weekly expectation fields
  - Resolve due checkpoints only from verified observations.
  - Extend weekly events with structured baseline and actual metrics.
  - Preserve same-authority realization rules.
  - _Requirements: 5, 6_

- [x] 5. Implement the pricing-board interface
  - Keep weekly events, pricing thesis, core/supporting signals and ledger in one
    component.
  - Show expectation gap, reaction, causal steps, exposures and checkpoints.
  - Remove duplicate market prose and demote unexplained heat scores.
  - Implement bilingual, keyboard and responsive states.
  - _Requirements: 6, 7, 8_

- [x] 6. Migrate and refresh real content
  - Add additive D1 migration or payload compatibility changes.
  - Generate V2 current daily and weekly records.
  - Publish and verify through production APIs.
  - _Requirements: 9_

- [x] 7. Complete review and release gates
  - Run TypeScript, build, unit, contract, style and security checks.
  - Audit requirements against source, tests, API data and rendered output.
  - Verify desktop and 390-pixel production behavior in both languages/themes.
  - Deploy only after no blocking review issue remains.
  - _Requirements: 7, 8, 9_
