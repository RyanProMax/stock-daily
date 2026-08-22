# Market Attribution V9 Implementation Plan

- [x] 1. Extend the market-data contract and session normalization.
  - Add and test `previous_as_of` in the internal daily pack.
  - Build deterministic CN/US session windows.
  - _Requirements: 1, 3_
- [x] 2. Collect full sector performance and attribution candidates.
  - Retain all eleven sectors per market while preserving legacy heat views.
  - Classify event versus close-wrap facts without penalizing recaps.
  - _Requirements: 2, 3, 4_
- [x] 3. Implement V9 generation, validation and persistence.
  - Generate zero to three grounded drivers per market.
  - Enforce market isolation, sector alignment and causal headlines.
  - _Requirements: 4, 5, 6, 7_
- [x] 4. Replace the daily reader surface with the attribution layout.
  - Render leaders, laggards and compact driver evidence.
  - Remove general news, daily weekly-events integration and thesis ledger.
  - _Requirements: 8, 9_
- [x] 5. Validate and release the 2026-08-21 market-session sample.
  - Pass automated, desktop and mobile expanded-state checks.
  - Replace production daily history with the single validated report and read it
    back successfully.
  - _Requirements: 10_
