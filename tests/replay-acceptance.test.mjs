import assert from "node:assert/strict";
import test from "node:test";
import { summarizeReplayAcceptance } from "../scripts/daily-workflow-acceptance.mjs";

const session = { market: "US", marketAsOf: "2026-09-11" };
const labels = {
  contractVersion: "stock-daily-replay-labels-v1",
  labelReview: { status: "human-confirmed", reviewedBy: "test-fixture", reviewedAt: "2026-09-14T12:00:00Z" },
  expectedSessions: [session],
  expectedSignals: [{ ...session, id: "inflation", target: "IXIC", sourceIncludes: ["https://apnews.com/article/current"], eventIncludes: ["inflation"] }],
};
function ready() {
  return {
    ...session, status: "ready", deliveryMode: "shadow", validationStatus: "valid", completedAtMs: 100,
    durationMs: 20 * 60_000,
    cards: [{ targets: ["IXIC"], sources: ["https://apnews.com/article/current"], eventText: "Inflation near expectations supported the rebound" }],
    scores: [{ factualAccuracy: 5, causalLogic: 5, evidenceDirectness: 5, readerUtility: 5 }],
  };
}

test("acceptance matches the event and publisher rather than URL substrings", () => {
  assert.equal(summarizeReplayAcceptance([ready()], labels).passed, true);
  for (const source of ["https://evil-apnews.com/article/current", "https://evil.example/apnews.com/article/current"]) {
    const run = ready(); run.cards[0].sources = [source];
    assert.equal(summarizeReplayAcceptance([run], labels).quality.recall, 0);
  }
  const unrelated = ready(); unrelated.cards[0].eventText = "Earnings drove a rally";
  assert.equal(summarizeReplayAcceptance([unrelated], labels).quality.recall, 0);
  const weak = structuredClone(labels); delete weak.expectedSignals[0].eventIncludes;
  const result = summarizeReplayAcceptance([ready()], weak);
  assert.equal(result.passed, false);
  assert.deepEqual(result.quality.weakLabels, ["inflation"]);
});

test("later failure supersedes old success and retry time counts toward latency", () => {
  const earlier = ready(); earlier.status = "failed"; earlier.validationStatus = "invalid"; earlier.cards = [];
  const latest = { ...ready(), completedAtMs: 200 };
  const result = summarizeReplayAcceptance([earlier, latest], labels);
  assert.equal(result.totals.attempts, 2);
  assert.equal(result.sessions[0].attemptCount, 2);
  assert.equal(result.sessions[0].durationMs, 40 * 60_000);
  assert.equal(result.passed, false);
  const failed = { ...earlier, completedAtMs: 300 };
  const failure = summarizeReplayAcceptance([latest, failed], labels);
  assert.equal(failure.totals.completedSessions, 0);
  assert.equal(failure.quality.recall, 0);
});

test("all four review dimensions and known timing are required", () => {
  for (const dimension of ["factualAccuracy", "causalLogic", "evidenceDirectness", "readerUtility"]) {
    const run = ready(); run.scores[0][dimension] = 3;
    assert.equal(summarizeReplayAcceptance([run], labels).passed, false);
  }
  const run = ready(); run.durationMs = null;
  assert.equal(summarizeReplayAcceptance([run], labels).passed, false);
});

test("replay evaluation retains reference-label provenance and distinguishes unfinished runs from invalid reports", () => {
  const referenceLabels = { ...labels, labelReview: { status: "source-reviewed-human-confirmation-pending" } };
  const unconfirmed = summarizeReplayAcceptance([ready()], referenceLabels);
  assert.equal(unconfirmed.quality.recall, 1);
  assert.equal(unconfirmed.quality.labelsHumanConfirmed, false);
  assert.equal(unconfirmed.passed, false);
  const publisherOnly = structuredClone(labels);
  publisherOnly.expectedSignals[0].sourceIncludes = ["apnews.com"];
  assert.equal(summarizeReplayAcceptance([ready()], publisherOnly).passed, false);
  const unfinished = { ...ready(), status: "running", validationStatus: "invalid", cards: [] };
  const pending = summarizeReplayAcceptance([unfinished], referenceLabels);
  assert.equal(pending.quality.labelReviewStatus, referenceLabels.labelReview.status);
  assert.equal(pending.totals.invalidRuns, 1);
  assert.equal(pending.totals.invalidReportRuns, 0);
  assert.equal(pending.passed, false);
  const invalid = summarizeReplayAcceptance([{ ...ready(), validationStatus: "invalid" }], referenceLabels);
  assert.equal(invalid.totals.invalidReportRuns, 1);
  assert.equal(invalid.quality.recall, 0);
});
