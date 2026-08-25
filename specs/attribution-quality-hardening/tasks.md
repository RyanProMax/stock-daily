# Attribution Quality Hardening Tasks

- [x] 1. Harden completed local-wrap authority.
  - Reject intraday and foreign-market wraps.
  - Pass market-session context through gap, anchor and publication gates.
  - _Requirements: 1, 2, 3_

- [x] 2. Require an independent causal event for every market driver.
  - Reject price, breadth, turnover and fund-flow-only support.
  - _Requirement: 4_

- [x] 3. Add bounded active-search failover and attempt diagnostics.
  - Keep publisher hydration and session validation authoritative.
  - _Requirements: 5, 6_

- [x] 4. Add stale-readback retry and exact-report no-store behavior.
  - _Requirements: 7, 8_

- [x] 4a. Move close collection to the one-hour post-close checkpoint.
  - _Requirement: 12_

- [x] 5. Add deterministic regressions and current-input validation.
  - _Requirements: 9, 10_

- [x] 6. Add the GitHub quality workflow.
  - _Requirement: 11_

- [x] 7. Complete up to three implementation-review cycles and submit once.
  - Run full tests, security review and final diff audit.
  - _Requirements: 1-12_
