# Implementation Plan

- [x] 1. Replace the daily input with a deterministic V10 market snapshot.
  - Remove daily news and X collection dependencies.
  - Add deterministic CN/US market briefs.
  - _Requirements: R1, R3_

- [x] 2. Add the native-search agent contract.
  - Add the V10 JSON Schema and evidence-first task prompt.
  - Invoke `codex --search exec` in read-only mode and capture JSONL events.
  - _Requirements: R2, R4, R5_

- [x] 3. Replace V9 publication validation with V10 validation.
  - Validate structural and event/macro attribution separately.
  - Strip internal research fields from reader-facing storage.
  - Preserve deterministic Cloudflare publication and readback.
  - _Requirements: R3, R4, R5, R7_

- [x] 4. Add search-audit and scheduling safeguards.
  - Require completed native searches covering CN and US.
  - Open every cited external source through a public-address-pinned HTTPS audit.
  - Ensure any failure occurs before publication.
  - _Requirements: R5, R6_

- [x] 5. Remove the legacy daily news pool and replace its tests.
  - Delete the unused daily news pipeline.
  - Add V10 snapshot, contract, audit, and scheduler tests.
  - _Requirements: R1, R6, R8_

- [x] 6. Run acceptance and review.
  - Run build and the complete automated test suite.
  - Run a real 2026-08-25 native-search shadow report and inspect its evidence.
  - Render and review required desktop/mobile views.
  - Run automatic code review and resolve findings.
  - _Requirements: R8_
