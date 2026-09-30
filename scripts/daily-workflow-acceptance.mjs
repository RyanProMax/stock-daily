import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkflowArtifacts } from "./daily-workflow-check.mjs";
import {
  AGENT_FILESYSTEM_ISOLATION,
  WORKFLOW_VERSION,
  marketEnvelope,
  marketInputHash,
  stableHash,
  validateAdjudication,
  validatePlan,
} from "./daily-workflow-core.mjs";
import { validateInput } from "./daily-publish.mjs";

const LABEL_CONTRACT = "stock-daily-replay-labels-v1";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sessionKey(value) {
  return `${value.market}|${value.marketAsOf}`;
}

function validateLabels(value) {
  if (
    !value ||
    value.contractVersion !== LABEL_CONTRACT ||
    !Array.isArray(value.expectedSessions) ||
    !Array.isArray(value.expectedSignals)
  ) {
    throw new Error("回放标注文件契约无效");
  }
  const expectedSessions = value.expectedSessions.map((item, index) => {
    if (
      !["CN", "US"].includes(item?.market) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(item?.marketAsOf ?? "")
    ) {
      throw new Error(`expectedSessions[${index}] 无效`);
    }
    return { market: item.market, marketAsOf: item.marketAsOf };
  });
  if (
    new Set(expectedSessions.map(sessionKey)).size !== expectedSessions.length
  ) {
    throw new Error("expectedSessions 不得重复");
  }
  const expectedSignals = value.expectedSignals.map((item, index) => {
    if (
      typeof item?.id !== "string" ||
      !item.id.trim() ||
      !["CN", "US"].includes(item.market) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(item.marketAsOf ?? "") ||
      typeof item.target !== "string" ||
      !item.target.trim() ||
      !Array.isArray(item.sourceIncludes) ||
      item.sourceIncludes.length === 0 ||
      item.sourceIncludes.some(
        (source) => typeof source !== "string" || !source.trim(),
      )
    ) {
      throw new Error(`expectedSignals[${index}] 无效`);
    }
    if (!expectedSessions.some((session) => sessionKey(session) === sessionKey(item))) {
      throw new Error(`expectedSignals[${index}] 不在验收交易日中`);
    }
    return {
      id: item.id.trim(),
      market: item.market,
      marketAsOf: item.marketAsOf,
      target: item.target.trim(),
      sourceIncludes: item.sourceIncludes.map((source) =>
        source.trim().toLocaleLowerCase(),
      ),
      eventIncludes: Array.isArray(item.eventIncludes)
        ? item.eventIncludes.filter((term) => typeof term === "string" && term.trim()).map((term) => term.trim().toLocaleLowerCase())
        : [],
    };
  });
  if (new Set(expectedSignals.map((item) => item.id)).size !== expectedSignals.length) {
    throw new Error("expectedSignals.id 不得重复");
  }
  return { expectedSessions, expectedSignals };
}

function signalMatched(signal, run) {
  if (run.status !== "ready" || run.validationStatus !== "valid") return false;
  return run.cards.some(
    (card) =>
      card.targets.includes(signal.target) &&
      card.sources.some((source) =>
        signal.sourceIncludes.some((expected) => {
          try {
            const url = new URL(source);
            if (expected.startsWith("https://")) {
              const exact = new URL(expected);
              return url.hostname === exact.hostname && url.pathname === exact.pathname;
            }
            return url.hostname === expected || url.hostname.endsWith(`.${expected}`);
          } catch { return false; }
        }),
      ) &&
      signal.eventIncludes.some((term) =>
        String(card.eventText ?? card.title ?? "").toLocaleLowerCase().includes(term),
      ),
  );
}

export function publishedCardSummary(item) {
  return {
    title: item.title,
    eventText: [item.title, item.summary, item.mechanism, item.implication].filter(Boolean).join(" "),
    targets:
      item.attributionTargets ??
      (item.layer && item.market ? [`AI-${item.market}-${item.layer}`] : []),
    sources: (item.evidence ?? [])
      .map((evidence) => String(evidence.source ?? "").toLocaleLowerCase())
      .filter(Boolean),
  };
}

export function selectLatestReplayRuns(runs) {
  const newest = new Map();
  for (const run of runs) {
    const key = sessionKey(run);
    const previous = newest.get(key);
    if (
      !previous ||
      run.completedAtMs >= previous.completedAtMs
    ) {
      newest.set(key, run);
    }
  }
  return [...newest.values()];
}

export function summarizeReplayAcceptance(rawRuns, rawLabels) {
  const labels = validateLabels(rawLabels);
  const runsBySession = new Map(selectLatestReplayRuns(rawRuns).map((run) => [sessionKey(run), run]));
  const sessions = labels.expectedSessions.map((expected) => {
    const run = runsBySession.get(sessionKey(expected));
    if (!run) return { ...expected, status: "missing", durationMs: null, attemptCount: 0, cards: [], scores: [] };
    const attempts = rawRuns.filter((item) => sessionKey(item) === sessionKey(expected));
    const timingKnown = attempts.every((item) => Number.isFinite(item.durationMs) && item.durationMs >= 0);
    return {
      ...run,
      attemptCount: attempts.length,
      latestAttemptDurationMs: run.durationMs,
      durationMs: timingKnown ? attempts.reduce((sum, item) => sum + item.durationMs, 0) : null,
      ...(!timingKnown ? { validationStatus: "invalid", validationError: "存在无法核实耗时的尝试" } : {}),
    };
  });
  const signalResults = labels.expectedSignals.map((signal) => {
    const run = runsBySession.get(sessionKey(signal));
    return { ...signal, matched: Boolean(run && signalMatched(signal, run)) };
  });
  const completed = sessions.filter((run) =>
    ["ready", "no_claims"].includes(run.status),
  );
  const withinThirty = completed.filter((run) => Number.isFinite(run.durationMs) && run.durationMs <= 30 * 60_000);
  const withinThirtyRate =
    completed.length === 0 ? 0 : withinThirty.length / completed.length;
  const maxDurationMs = completed.reduce(
    (maximum, run) => Math.max(maximum, run.durationMs),
    0,
  );
  const matchedSignals = signalResults.filter((item) => item.matched).length;
  const recall =
    signalResults.length === 0 ? 0 : matchedSignals / signalResults.length;
  const scoreFailures = completed.flatMap((run) =>
    run.scores
      .filter((score) => ["factualAccuracy", "causalLogic", "evidenceDirectness", "readerUtility"].some((key) => !Number.isFinite(score[key]) || score[key] < 4))
      .map((score) => ({ ...score, market: run.market, marketAsOf: run.marketAsOf })),
  );
  const invalidRuns = sessions.filter(
    (run) =>
      run.status === "missing" ||
      run.deliveryMode !== "shadow" ||
      run.validationStatus === "invalid",
  );
  const labelsHumanConfirmed = rawLabels.labelReview?.status === "human-confirmed" &&
    typeof rawLabels.labelReview?.reviewedBy === "string" && rawLabels.labelReview.reviewedBy.trim().length > 0 &&
    Number.isFinite(Date.parse(rawLabels.labelReview?.reviewedAt ?? ""));
  const weakLabels = labels.expectedSignals.filter((item) => item.eventIncludes.length === 0 || item.sourceIncludes.some((source) => {
    try { const url = new URL(source); return url.protocol !== "https:" || url.pathname === "/"; } catch { return true; }
  })).map((item) => item.id);
  const passed =
    labelsHumanConfirmed && weakLabels.length === 0 &&
    completed.length === sessions.length &&
    invalidRuns.length === 0 &&
    recall >= 0.9 &&
    scoreFailures.length === 0 &&
    withinThirtyRate >= 0.9 &&
    maxDurationMs <= 45 * 60_000;
  return {
    contractVersion: "stock-daily-replay-acceptance-v1",
    passed,
    totals: {
      expectedSessions: sessions.length,
      completedSessions: completed.length,
      readySessions: completed.filter((run) => run.status === "ready").length,
      noClaimSessions: completed.filter((run) => run.status === "no_claims").length,
      publishedCards: completed.reduce((sum, run) => sum + run.cards.length, 0),
      attempts: rawRuns.length,
      failedOrUnfinishedAttempts: rawRuns.filter((run) => !["ready", "no_claims"].includes(run.status)).length,
      invalidRuns: invalidRuns.length,
      invalidReportRuns: invalidRuns.filter(
        (run) => run.status === "ready" && run.validationStatus === "invalid",
      ).length,
    },
    quality: {
      labelReviewStatus: rawLabels.labelReview?.status ?? "unspecified",
      labelsHumanConfirmed,
      expectedSignals: signalResults.length,
      matchedSignals,
      recall,
      scoreFailures,
      weakLabels,
    },
    latency: {
      withinThirtyMinutes: withinThirty.length,
      withinThirtyRate,
      maxDurationMs,
      allWithinFortyFiveMinutes: maxDurationMs <= 45 * 60_000,
    },
    sessions,
    signalResults,
    invalidRuns,
  };
}

async function loadRun(runDir) {
  const manifestPath = resolve(runDir, "manifest.json");
  const manifest = await readJson(manifestPath);
  const startedAt = Date.parse(manifest.startedAt);
  const completedAt = Date.parse(manifest.completedAt);
  const fallbackAt = [manifest.updatedAt, manifest.failedAt, manifest.completedAt, manifest.startedAt]
    .map((value) => Date.parse(value))
    .find(Number.isFinite) ?? 0;
  const terminal = ["ready", "no_claims"].includes(manifest.status);
  const timingValid =
    Number.isFinite(startedAt) &&
    Number.isFinite(completedAt) &&
    completedAt >= startedAt;
  const common = {
    market: manifest.market,
    marketAsOf: manifest.marketAsOf,
    status: manifest.status,
    deliveryMode: manifest.deliveryMode,
    durationMs: Number.isFinite(manifest.workflowElapsedMs)
      ? manifest.workflowElapsedMs
      : timingValid ? completedAt - startedAt : null,
    completedAtMs: Math.max(Number.isFinite(completedAt) ? completedAt : 0, fallbackAt),
    workflowVersion: manifest.workflowVersion,
    cards: [],
    scores: manifest.approval?.scores ?? [],
    manifestPath,
    validationStatus: terminal && timingValid ? "valid" : "invalid",
    ...(!terminal || !timingValid
      ? {
          validationError: !terminal
            ? `运行尚未完成：${manifest.status ?? "unknown"}`
            : `${manifest.runKey ?? manifestPath}.completedAt 时间无效`,
        }
      : {}),
  };
  if (!terminal || !timingValid) return common;
  if (manifest.status === "no_claims") {
    try {
      const input = validateInput(await readJson(manifest.inputPath));
      const envelope = marketEnvelope(input, manifest.market);
      if (
        manifest.workflowVersion !== WORKFLOW_VERSION ||
        manifest.inputHash !== marketInputHash(input, manifest.market) ||
        manifest.marketInputHash !== manifest.inputHash ||
        manifest.marketAsOf !== envelope.marketAsOf
      ) {
        throw new Error("no-claim 运行清单与确定性市场输入不一致");
      }
      const [planValue, ledger, adjudicationValue] = await Promise.all([
        readJson(resolve(runDir, "artifacts/plan.json")),
        readJson(resolve(runDir, "artifacts/evidence-ledger.json")),
        readJson(resolve(runDir, "artifacts/adjudication.json")),
      ]);
      const plan = validatePlan(planValue, envelope);
      const decisionIds = new Set(
        (adjudicationValue.decisions ?? []).map((item) => item.anomalyId),
      );
      const researchedPlan = {
        ...plan,
        anomalies: plan.anomalies.filter((item) => decisionIds.has(item.id)),
      };
      const adjudication = validateAdjudication(
        adjudicationValue,
        researchedPlan,
        ledger,
        envelope,
      );
      if (adjudication.claimCards.length !== 0) {
        throw new Error("no-claim 运行仍包含可发布归因卡片");
      }
      const agentRuns = manifest.agentRuns ?? [];
      const agentRunIds = agentRuns.map((item) => item.agentRunId);
      const roles = new Set(agentRuns.map((item) => item.role));
      if (
        agentRuns.length < 6 ||
        new Set(agentRunIds).size !== agentRunIds.length ||
        ["planner", "facts", "causal", "adjudicator"].some(
          (role) => !roles.has(role),
        ) ||
        agentRuns.some(
          (item) =>
            item.ephemeral !== true ||
            item.filesystemIsolation !== AGENT_FILESYSTEM_ISOLATION ||
            item.status !== "completed" ||
            !item.promptHash ||
            !item.outputHash,
        )
      ) {
        throw new Error("no-claim 运行缺少隔离 Agent 的完整记录");
      }
      const stages = Object.values(manifest.stages ?? {});
      const planHash = stableHash(plan);
      const ledgerHash = stableHash(ledger);
      const adjudicationHash = stableHash(adjudication);
      const hasAdjudicatorCheckpoint = agentRuns.some(
        (item) =>
          item.role === "adjudicator" &&
          item.status === "completed" &&
          item.outputHash === adjudicationHash,
      );
      const hasDeterministicNoClaimCheckpoint = stages.some(
        (stage) =>
          stage.role === "deterministic_no_claims_finalization" &&
          stage.status === "completed" &&
          stage.outputHash === adjudicationHash,
      );
      if (
        !stages.some(
          (stage) =>
            stage.role === "deterministic_plan_checkpoint" &&
            stage.status === "completed" &&
            stage.outputHash === planHash,
        ) ||
        !stages.some(
          (stage) =>
            stage.role === "deterministic_source_verification" &&
            stage.status === "completed" &&
            stage.outputHash === ledgerHash,
        ) ||
        (!hasAdjudicatorCheckpoint && !hasDeterministicNoClaimCheckpoint) ||
        manifest.evidence?.verifiedSourceCount !== ledger.sources?.length ||
        manifest.evidence?.rejectedSourceCount !== ledger.rejected?.length
      ) {
        throw new Error("no-claim 运行的阶段产物或证据计数校验失败");
      }
      return common;
    } catch (error) {
      return {
        ...common,
        validationStatus: "invalid",
        validationError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (manifest.status !== "ready") return { ...common, validationStatus: "invalid" };
  try {
    await checkWorkflowArtifacts({
      inputPath: manifest.inputPath,
      reportPath: manifest.reportPath,
      manifestPath,
    });
    const report = await readJson(manifest.reportPath);
    const cards = [...(report.drivers ?? []), ...(report.aiChainUpdates ?? [])]
      .filter((item) => item.market === manifest.market)
      .map(publishedCardSummary);
    return { ...common, cards };
  } catch (error) {
    return {
      ...common,
      validationStatus: "invalid",
      validationError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function evaluateReplayAcceptance({ runsRoot, labelsPath }) {
  const entries = await readdir(resolve(runsRoot), { withFileTypes: true });
  const loaded = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadRun(resolve(runsRoot, entry.name))),
  );
  return summarizeReplayAcceptance(
    loaded,
    await readJson(resolve(labelsPath)),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const runsIndex = args.indexOf("--runs-root");
  const labelsIndex = args.indexOf("--labels");
  const outputIndex = args.indexOf("--output");
  if (runsIndex < 0 || labelsIndex < 0) {
    throw new Error("usage: daily-workflow-acceptance --runs-root DIR --labels FILE [--output FILE] [--require-pass]");
  }
  const result = await evaluateReplayAcceptance({
    runsRoot: args[runsIndex + 1],
    labelsPath: args[labelsIndex + 1],
  });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputIndex >= 0) {
    const outputPath = resolve(args[outputIndex + 1]);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, text, "utf8");
  }
  process.stdout.write(text);
  if (args.includes("--require-pass") && !result.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
