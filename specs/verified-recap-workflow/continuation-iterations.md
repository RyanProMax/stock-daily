# Continued Optimization Iterations

## Round 1

- Change: added source-level causal propositions, explicit scope/target binding,
  itemized independent claim reviews and a Treasury-tenor grounding fix.
- Automated result: 93/93 tests passed; strict output schemas passed.
- Shadow result: failed before independent review.
- Failure evidence: the generated US inflation driver used `mixed` because yields
  rose while equities fell, although its only listed sector was down. The contract
  also ambiguously required partial evidence for unresolved hypotheses to appear in
  the final supporting-source list.
- Round 2 direction: define driver direction as the explained sector direction,
  allow partial-source records on non-accepted hypotheses, and require one source
  proposition to exactly cover the final published causal claim.

## Round 2 startup note

- The first launch produced no research events because Homebrew Codex CLI 0.145.0
  could not parse the current model catalog and remained on `turn.started`.
- The stalled process was stopped without producing or publishing a report.
- The scheduler now prefers the newer Codex binary bundled with ChatGPT and keeps
  the existing environment override/fallback behavior.

## Round 2

- Change: clarified driver direction, permitted partial-source records for rejected
  and unresolved hypotheses, and required one source proposition to exactly equal
  the published causal claim.
- Automated result: 94/94 tests passed.
- Shadow result: generation, search audit, source audit and deterministic report
  validation passed; independent review returned `revise`.
- Substantive review: the US inflation/yield claim passed. The CN sources supported
  brokers and industrial metals, but the report widened them to the entire financial
  and materials first-level sectors.
- Additional audit issue: one US reviewer query omitted the exact `U.S. stocks`
  marker even though the reviewer still produced a useful substantive verdict.
- Round 3 direction: model subsector attribution explicitly, require review scope to
  match it, harden per-query market markers, and recover safely from stale locks.

## Round 3 startup note

- The first launch produced only `turn.started` while the remote plugin catalog
  returned service errors; no report or search was produced.
- A minimal local CLI probe completed after disabling plugin discovery while keeping
  the same Codex model and native web-search capability.
- Both research and review invocations now disable unrelated plugin discovery, and
  the PID lock recovers from interrupted owners without overlapping active runs.

## Round 3

- Change: added explicit subsector attribution and target binding, required itemized
  review scope to match the published scope, hardened reviewer market markers,
  added a recoverable PID lock, and made AI-search auditing recognize the tracked
  companies in the current input.
- Mechanical validation fixes: equivalent ISO timestamps now compare by instant,
  reader-facing market aliases remain bound to their market, and the Los Angeles
  Times is classified as an established publisher.
- Automated result: 97/97 tests passed; strict report and review schemas passed.
- Shadow result: generation, search audit, source availability audit and the initial
  deterministic report validation passed. The independent review returned `revise`,
  so no publication, commit or deployment occurred.
- Accepted by review: the broker earnings/dividend catalyst for the broker subsector,
  and the above-expected US inflation to higher yields to weaker broad-market chain.
- Rejected by review: the industrial-metals source placed copper, earnings and the
  market move together but did not directly establish the published causal mechanism.
  The report also widened subsector evidence in its overall headline/summary and
  leaked an unresolved Nvidia earnings-wait explanation into a US driver summary.
- Post-review guardrail: an accepted ledger claim must now exactly equal its final
  published mechanism. The generation prompt also forbids scope widening in overall
  copy and any reader-facing leakage from rejected or unresolved hypotheses.
- Final disposition: the third report remains unpublished and is intentionally
  rejected by the tightened contract. A further content attempt would be a fourth
  round and is outside this three-round run.

## Runtime reliability follow-up

- A later scheduled run exposed an operational hang before the first search:
  Codex repeatedly retried model-catalog refresh failures and never returned from
  attempt one, so the three-attempt cap could not advance.
- The scheduler now disables unbounded connection retries and unrelated desktop
  update/app-server features for these isolated runs. Each research process is
  bounded to fifteen minutes and each review to ten minutes, with full process-tree
  cleanup and a distinct timeout result. A second bound terminates research after
  five minutes without events and review after four minutes without events.
- The previous gate error is now mandatory input to the next research attempt.
  Unreachable source URLs and unsupported numeric claims must be replaced or
  removed instead of being rediscovered in every attempt.
- A full-input research probe at low reasoning effort completed eleven native
  searches and passed search/source audits in roughly four minutes. Its report was
  still rejected by the unchanged deterministic contract, confirming that low
  effort restores progress without bypassing quality gates. Research now defaults
  to low effort while the independent reviewer remains at medium.
- A single feedback retry read the exact hypothesis/source mismatch from the first
  low-effort report, corrected it, completed eleven audited searches and passed the
  source and deterministic report gates. The medium-effort independent reviewer
  then returned a global pass, opened both published sources, passed all four
  itemized claims and scored every CN/US dimension at least four out of five.
- The accepted run remained shadow-only. It did not write Cloudflare state or
  replace the production report.
