# Workflow validation — 2026-09-14

The previous statement that the v22 weekly replay passed is withdrawn. Its evaluator preferred a successful attempt over a later failure, omitted retry time and matched event labels using only a target and publisher substring. Those results do not establish current workflow reliability or 100% event recall.

## Reproducible checks

```sh
npm test
npm run security:check
node scripts/daily-workflow-check.mjs --manifest work/runs/RUN_KEY/manifest.json
node scripts/daily-workflow-check.mjs --manifest work/runs/RUN_KEY/manifest.json --production
```

The regression suite covers source timing, exact excerpts, typed numbers and directions, grounded targets, isolated role provenance, query-budget recovery, immutable publication artifacts, inactive-market preservation, interrupted readback, batch completion and date-bounded archive reads. Manual publication now uses the same persistent recovery path as scheduled publication and restricts writes to the requested manifest.

The latest full run passed **274 Node tests and 6 Python tests**, TypeScript checking and both production builds. The public-repository check and whitespace/shell-syntax checks passed.

UI validation covers CN/US in Chinese/English at 1440px and 390px, complete pages and all signal content. Current signal cards are displayed inline. The date menu was opened and dismissed, publication dates were checked for localized formatting, and core content was checked for hidden overflow and off-canvas elements. Mobile company names wrap in full. Historical navigation retains its subordinate single-line titles. Browser plugin was unavailable; validation used bundled Playwright and Chrome.

## Live-run findings

The frozen sample contains CN 2026-09-14 and US 2026-09-11 closing data. Early v26/v27 shadow attempts are retained under `work/review-2026-09-14/`; they failed validation or ended without publishable claims. They are diagnostic failures, not successful report publication.

The review reproduced and corrected false source rejections caused by missing Chinese article publication metadata, undecoded punctuation entities, hyphenated financial units, natural-language dates, redundant market-marker requirements, and movement verbs/calendar numbers. A transport retry can try at most three already-validated public addresses. An unchanged verified source is reused during the same run's targeted repair, preventing a later publisher outage from deleting a previously verified claim. Changed facts or excerpts must be checked again.

Formal publication candidates are separate immutable `publish` runs in `work/review-2026-09-14/publish-prepared/`. They stop before writing so the generated report and rendered page can be inspected. Publication is complete only when the report passes its artifact gate, is written, and its exact market content is read back from production.

The CN September 14 candidate passed the final review (factual accuracy 5, causality 4, evidence directness 5, reader utility 4), artifact validation and four fresh-report UI checks. It published successfully on September 14 at 16:08 UTC. A separate production readback confirmed CN September 14 while retaining the previous US September 1 slice; production health returned `ok`, `connected` and completed ingestion. The confirmed CN date was then persisted to the scheduler checkpoint. The report explains the verified AI hardware pressure; broad-market attribution remains explicitly insufficient.

After the final source-reader fixes, both news sources actually attached to the published CN card were reopened and reverified successfully (`cn-source-reaudit.json`). The four current CN production UI combinations passed separately from the local preview.

The US September 11 candidate passed a fresh final review with all four dimensions scoring 5/5, the complete artifact gate and four fresh-report UI checks. Its 40 stage executions include retained failed/repair attempts; they are not 40 independent successful reviews. The approved card connects lower oil prices and in-line inflation to the Dow rebound. It does not extend that claim to AI hardware. Five source records passed verification and one was rejected; three distinct news pages are actually attached to the card, alongside its deterministic price source.

US publication and ingestion finalization completed on September 14 at 17:26 UTC. A separate readback at 17:33 UTC confirmed both active market hashes: CN `9b2cf4957c69fe4cb087e26cddd2058c2b096b1dbd12a9cb8a73040011ebf1c7`, US `3ddd43bc73b929ae7bd7ad9676846ad0b4d083a835e27eddac55c17f71abd8bd`. Production health returned `ok`, database `connected`, and latest ingestion `completed`. Only then was the scheduler checkpoint advanced to CN September 14 and US September 11. The complete evidence is in `final-production-check.json`.

The independent readback exposed a normalization mismatch: publication removed optional null mechanism fields, while recovery hashed the raw draft. Recovery and idempotent publication now validate and normalize the approved report before hashing, matching the actual stored representation. The production report itself was correct and required no rewrite. A regression exercises publication, separate readback and a second publication attempt, asserting identical hashes and exactly one write; altered active content remains detectable.

Source-page publication metadata is authoritative. The attached Kiplinger CPI page reports September 9, overriding the research output's incorrect September 11 timestamp. It is used within the permitted 72-hour factual context window; the causal market reaction is separately supported by September 11 reporting. This distinction is retained in the ledger and the localized reader timestamps.

Historical replay identified an additional CLS page format: the article's Unix publication time appears in its embedded page data. The reader now accepts it only when the route, query ID and article ID all match the requested article. A real-page audit recovered August 21 at 12:33:38 UTC for article 2461050. Tests reject recommendation dates, different article IDs, unrelated domains, malformed JSON and millisecond values in the seconds field. The in-flight week was started before this additive reader change; its existing rejections are retained rather than relabeled as successful verification.

The live standalone publication command revealed an ESM circular-import deadlock not covered by imported-function tests. A separate-process regression now confirms that this CLI reaches production-readback initialization before any network write. Manual publication subsequently completed through the actual Wrangler and production API paths.

Research repair now supplements unchanged, verified old passages instead of replacing the entire anomaly's evidence with the new search output. Old rejected candidates are dropped for the repaired role. A changed fact or excerpt is never carried forward using the old candidate hash. This corrects a reproduced US failure where blocked supplemental sources erased valid original oil-price evidence. Exact verified passages may support qualitative background facts omitted by the shorter fact summary; numeric grounding and causal-scope requirements remain enforced.

The reader removes matching complete style/script blocks, including CSS with embedded SVG closing tags. Exact excerpt fragments must all be located in source order, including short sentences; article sections are not rejected merely because navigation or other article paragraphs separate them. Same-input retries receive inaccessible URLs only from hash-verified prior ledgers. Two distinct article refusals can exclude that publisher from the same input's research list. Access hints do not carry to a different market/input and do not blacklist passages rejected for fixable excerpt or numeric formatting. US discovery no longer requires naming AP, Reuters or Yahoo Finance in every broad-market query; source registry and article-level verification remain mandatory.

Access hints are frozen per run so a newly rejected source cannot invalidate that run's completed research prompts during a reader-only recovery. A final-gate regression covers `25-basis-point` versus Chinese basis-point units. Resuming reader work returns the manifest to running and clears the old approval until a fresh review passes.

Full-page visual inspection caught a financial-label issue that layout assertions did not: Chinese cards inherited English research labels, and an English translation contained a replacement character. Writer output now supplies Chinese metric labels and notes for independent review, with all numeric values and tone attached from the verified comparison by code. English translation uses the approved labels, both publication gates reject replacement characters, and the UI localizes percentage-point/basis-point display units without changing the canonical numeric values. Browser assertions now check metric-label language and replacement characters as well as layout.

Review also reproduced two recovery defects. Adjudication's alternative explanations could leak into Writer and Reviewer input as if they were accepted facts; those alternatives are now excluded from both reader-facing inputs while remaining in the adjudication artifact. The research clock previously kept running through writing and translation. It now starts only after a genuine research checkpoint miss and stops after the last concurrent research process finishes. Old recorded consumption is retained conservatively: an exhausted research budget still prevents a new search, but cannot block reuse of an unchanged, hash-verified research checkpoint for reader-only recovery. Tests exercise both boundaries.

The final numeric gate also recognizes an implied point unit in explicit English index closing statements, including relative clauses, so “Dow rose ... to 52,573” agrees with its Chinese point value. Company prices retain their own unit classification. A complete assembled-report regression passed before restarting the fresh reader review; that regression file is not a publication-approved artifact.

The loaded local task `com.stock-daily.codex` points to the updated project script and includes compensation windows around the scheduled editions. Its most recent completed trigger exited successfully. The code uses the compatible bundled CLI by default and evaluates the A-share closing threshold from 15:00 Beijing time.

Runtime evidence is retained under `work/review-2026-09-14/`, including frozen inputs, all failed attempts, immutable publish manifests, CLI publication/readback results, test logs and the Playwright scripts used for review. Full-page and per-signal screenshots are in the task's `review-2026-09-14/` visualization directory. The final `production-final/checks.json` records eight passing CN/US, Chinese/English, desktop/mobile combinations; all eight full-page screenshots were visually reviewed after both markets were published. The deployed site is https://stock-daily-8k4.pages.dev and the reviewed deployment is https://676c92aa.stock-daily-8k4.pages.dev.

## Weekly benchmark status

Independent review of the Salesforce sample found an important omission despite arithmetically correct EPS comparisons: the source discloses a substantial investment gain within reported non-GAAP EPS. The [issuer release](https://investor.salesforce.com/news/news-details/2026/Salesforce-Delivers-Record-Second-Quarter-Fiscal-2027-Results/default.aspx) and the [same cited article](https://finance.sina.com.cn/stock/usstock/c/2026-08-27/doc-iniptxky0859513.shtml) both distinguish this gain from operating performance. The new source check rejects an EPS excerpt omitting such nearby qualifications; old EPS evidence must receive the new check before publication. The real-page rejection is recorded in `earnings-context-reaudit.json`. Facts research and review now explicitly preserve this distinction, and the historical sample subsequently passed a fresh review with all dimensions at 5/5. This does not affect the two published current reports, which contain no EPS comparison.

The replay exposed a false causal interpretation on CN August 26: the copied article only listed an index gain and semiconductor constituent gains. Adjudication and review now explicitly reject this as a root cause. A necessary lexical passage guard is enforced again against the hash-verified ledger at artifact checking, publication and independent readback. The guard does not prove causation; independent semantic review remains required. The sample was re-adjudicated to `no_claims`; the old failed attempt and its consumed time remain recorded. Both live reports passed the added gate without changing their content.

US August 24 planning also exposed a chronological error: a later CN August 25 close was supplied as a lead for the already-finished US session. New research payloads and artifacts exclude such leads, and the deterministic priority rule applies the same session ordering. The raw collection hash remains unchanged so approved reports retain their valid input identity. Tests cover same-day CN-before-US ordering, prior-day US-before-CN ordering and later/unknown session rejection. Existing in-flight initial attempts used the earlier research envelope; their provenance is retained rather than described as fresh runs of every later fix.

CN August 28 recovery reproduced both an unrecognized `AI软件` query alias and a batch restart with too little budget after Planner inputs changed. Research preflight now checks actual prompt, schema, output and event hashes for the whole group. Parallel errors wait for already-started siblings before persisting final failure, preventing work from continuing after the CLI reports completion. A later trigger creates a separate bounded attempt for an exhausted failure; it never erases the earlier failure or its time from acceptance. Publication-time parsing now also supports the 21jingji author line and NBD's article-identified Cambrian metadata. Publication-metadata parsing failures do not blacklist an otherwise accessible URL on a new attempt.

All ten historical sessions have completed under `work/review-2026-09-14/replay-runs/`; the full benchmark **did not pass**. Some initial attempts predate the later fixes, as noted above. Five reference events now include event-specific terms and exact article links checked separately against publisher reporting before replay results. Their `labelReview` status explicitly remains `source-reviewed-human-confirmation-pending`; they must not be presented as human-labeled recall ground truth.

The corrected evaluator selects the latest attempt for each market session, sums all attempt durations, rejects missing timing, requires every review dimension to score at least 4/5, and requires both a specific event and an exact source hostname/path match. A `no_claims` result is safe non-publication; it is not a completed scheduled report.

The completed benchmark command was:

```sh
node scripts/daily-workflow-acceptance.mjs \
  --runs-root work/review-2026-09-14/replay-runs \
  --labels specs/verified-recap-workflow/acceptance-labels.json \
  --output work/review-2026-09-14/replay-acceptance.json \
  --require-pass
```

It returned exit status 1, as required for unmet acceptance. Ten sessions reached validated terminal states: five publishable shadow reports and five safe no-claim outcomes. All five generated cards passed the current artifact checks and every review dimension scored at least 4/5. No invalid generated report passed the final gate. Sixteen attempts are retained, including four failed attempts preceding later outcomes. A no-claim outcome preserves prior production content and stays pending for the scheduler; it is not a newly published daily report.

| Market session | Outcome | Attempts | Cumulative minutes |
| --- | --- | ---: | ---: |
| CN August 24 | Ready | 1 | 5.63 |
| CN August 25 | No claims | 1 | 8.16 |
| CN August 26 | No claims | 1 | 10.23 |
| CN August 27 | No claims | 1 | 8.27 |
| CN August 28 | Ready | 2 | 43.12 |
| US August 24 | Ready | 1 | 11.13 |
| US August 25 | Ready | 1 | 10.04 |
| US August 26 | No claims | 2 | 12.74 |
| US August 27 | Ready | 3 | 26.02 |
| US August 28 | No claims | 3 | 28.16 |

Nine of ten sessions finished within 30 minutes, and all finished within 45 minutes after adding retained retry time. The timing thresholds passed. This measures the retained diagnostic run history, not a clean prospective week entirely on the final code.

Strict event-and-reference-article matching found **3/5 (60%)**, below the 90% threshold. CN August 28 did cover the Salesforce-to-A-share-software event using independently verified Sina and 21jingji articles, but none was one of the frozen reference article URLs. This is a reference-source mismatch; the labels were not expanded after seeing the result. US August 28 was an actual coverage miss: the research recovered the official policy speech, but its causal worker's excerpt did not explicitly connect that speech to the 10-year yield increase. Final adjudication rejected the claim. Therefore neither the strict 60% result nor the separately identified equivalent CN event establishes human-labeled 90% recall. Reference labels still require human confirmation, and the evaluator now explicitly prevents formal success without a reviewer and review time.

Later replay fixes addressed additional reproducible issues. Comparison notes are now verified numerically against their source excerpt and included in public evidence facts, so a legitimate growth rate cannot pass Writer but disappear from final grounding. Earnings-context verification is marked for both company-matched and event-only evidence. Company-name numerals such as “360 Security” are distinguished from quantitative percentages. Tests still reject invented numeric notes and percentages.

The Federal Reserve speech page supplies a date but no exact time. The reader now checks the official speeches RSS feed and accepts only the exact speech's link/GUID and a publication date consistent with the article header and URL. The real-page audit recovered August 28 at 14:00 UTC (`fed-publication-reaudit.json`). Missing, unrelated or unzoned feed entries remain unverified.

Completed supplemental research now retains its invocation input and resumes only when the current plan, session, prompt/schema and output/event hashes agree; its queries are not spent again. The older US August 28 diagnostic stage was migrated only after reconstructing and matching its exact original prompt, schema, output and event hashes (`US-2026-08-28-legacy-input-migration.json`). Its explicit diagnostic resume retained all existing budgets and produced no production writes. This migration did not change any source text or agent output. New runs record the required invocation metadata directly.

The final verdict is: production generation, validation, publication and exact readback are verified for the current CN and US reports; automated checks and all eight production layouts pass. General weekly signal coverage remains below the acceptance target. The next coverage evaluation needs independently confirmed event labels and a new frozen replay cohort; this report does not claim unattended publication succeeds on every trading day.
