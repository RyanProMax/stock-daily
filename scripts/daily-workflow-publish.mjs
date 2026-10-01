import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  auditWorkflowManifest,
  AGENT_FILESYSTEM_ISOLATION,
  hasCausalPassage,
  hasEarningsPerShareComparison,
  assertComparisonNotesInExcerpt,
  marketInputHash,
  researchMarketEnvelope,
  stableHash,
  trimReaderSummary,
} from "./daily-workflow-core.mjs";
import { fetchComparisonReport } from "./daily-freshness.mjs";
import { fetchFreshDailySnapshot } from "./daily-readback.mjs";
import { marketAsOfFromInput } from "./daily-policy.mjs";
import { validateCompleteRecap, validateRecapReview, recapTargets, completeRecapPlan } from "./complete-recap.mjs";
import { validateRecapTradingData } from "./recap-market-data.mjs";
import { validateRecapMacroData } from "./recap-macro-data.mjs";
import { validateRecapAttribution } from "./recap-attribution.mjs";
import { validateRecapTransmissionData } from "./recap-transmission-data.mjs";
import { validateRecapCompanyBackgroundData } from "./recap-company-background-data.mjs";
import { validateRecapPbocNewsData, auditRecapPbocNewsSources } from "./recap-pboc-news-data.mjs";
import { auditLedgerSourceSnapshots } from "./evidence-source-snapshots.mjs";
import { auditNativeAgentAttempt } from "./native-agent-receipts.mjs";
import {
  buildReportContent,
  validateInput,
  validateReport,
} from "./daily-publish.mjs";

const execFileAsync = promisify(execFile);

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function evidenceCount(report) {
  return new Set(
    [...report.drivers, ...report.aiChainUpdates].flatMap((item) =>
      item.evidence.map((evidence) => evidence.source),
    ),
  ).size;
}

export function workflowCompletedSql(
  input,
  report,
  contentOverride = null,
  { ingestionStatus = "running" } = {},
) {
  if (!["running", "completed"].includes(ingestionStatus)) {
    throw new Error(`Invalid ingestion status: ${ingestionStatus}`);
  }
  const finishedAt = new Date().toISOString();
  const content = contentOverride ?? JSON.parse(buildReportContent(input, report));
  const marketAsOf = content.marketAsOf ?? marketAsOfFromInput(input);
  const dataCut = `CN ${marketAsOf.CN} · US ${marketAsOf.US}`;
  return `
UPDATE daily_reports
SET edition = edition + 10000
WHERE report_date > ${sqlText(input.reportDate)}
  AND NOT EXISTS (
    SELECT 1 FROM daily_reports WHERE report_date = ${sqlText(input.reportDate)}
  );

UPDATE daily_reports
SET edition = edition - 9999
WHERE edition >= 10000;

INSERT INTO daily_reports (
  report_date, edition, headline, summary, generated_at,
  data_cut, agent_model, content
) VALUES (
  ${sqlText(input.reportDate)},
  COALESCE(
    (SELECT edition FROM daily_reports WHERE report_date = ${sqlText(input.reportDate)}),
    (
      SELECT COUNT(*) + 1
      FROM daily_reports
      WHERE report_date < ${sqlText(input.reportDate)}
    )
  ),
  ${sqlText(report.headline)},
  ${sqlText(report.summary)},
  ${sqlText(finishedAt)},
  ${sqlText(dataCut)},
  'openai/codex-multi-agent',
  ${sqlText(JSON.stringify(content))}
)
ON CONFLICT(report_date) DO UPDATE SET
  headline = excluded.headline,
  summary = excluded.summary,
  generated_at = excluded.generated_at,
  data_cut = excluded.data_cut,
  agent_model = excluded.agent_model,
  content = excluded.content,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO ingestion_runs (
  run_id, report_date, started_at, finished_at, status,
  market_count, news_count, error
) VALUES (
  ${sqlText(input.runId)},
  ${sqlText(input.reportDate)},
  ${sqlText(input.collectedAt)},
  ${sqlText(finishedAt)},
  ${sqlText(ingestionStatus)},
  ${input.markets.length},
  ${evidenceCount(report)},
  NULL
)
ON CONFLICT(run_id) DO UPDATE SET
  finished_at = excluded.finished_at,
  status = excluded.status,
  market_count = excluded.market_count,
  news_count = excluded.news_count,
  error = NULL;

DELETE FROM ingestion_runs
WHERE julianday(started_at) < julianday('now', '-90 days');
`;
}

export function workflowIngestionCompletedSql(input) {
  const finishedAt = new Date().toISOString();
  return `
INSERT INTO ingestion_runs (
  run_id, report_date, started_at, finished_at, status,
  market_count, news_count, error
) VALUES (
  ${sqlText(input.runId)},
  ${sqlText(input.reportDate)},
  ${sqlText(input.collectedAt)},
  ${sqlText(finishedAt)},
  'completed',
  ${input.markets.length},
  0,
  NULL
)
ON CONFLICT(run_id) DO UPDATE SET
  finished_at = excluded.finished_at,
  status = 'completed',
  market_count = excluded.market_count,
  error = NULL;
`;
}

export function workflowIngestionFailedSql(input, error) {
  const finishedAt = new Date().toISOString();
  return `
INSERT INTO ingestion_runs (
  run_id, report_date, started_at, finished_at, status,
  market_count, news_count, error
) VALUES (
  ${sqlText(input.runId)},
  ${sqlText(input.reportDate)},
  ${sqlText(input.collectedAt)},
  ${sqlText(finishedAt)},
  'failed',
  ${input.markets.length},
  0,
  ${sqlText(error)}
)
ON CONFLICT(run_id) DO UPDATE SET
  finished_at = excluded.finished_at,
  status = 'failed',
  market_count = excluded.market_count,
  error = excluded.error;
`;
}

export async function finalizeWorkflowIngestion(
  input,
  { execute = executeRemoteSql } = {},
) {
  const result = await execute(
    workflowIngestionCompletedSql(validateInput(input)),
  );
  return { status: "completed", wrangler: result };
}

export async function failWorkflowIngestion(
  input,
  error,
  { execute = executeRemoteSql } = {},
) {
  const result = await execute(
    workflowIngestionFailedSql(validateInput(input), error),
  );
  return { status: "failed", wrangler: result };
}

async function executeRemoteSql(sql) {
  const wranglerPath = resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = await execFileAsync(
    wranglerPath,
    [
      "d1",
      "execute",
      "stock-daily-db",
      "--config",
      "wrangler.data.jsonc",
      "--remote",
      "--yes",
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function reportAtOrBeforeDate(report, reportDate) {
  if (!report || !/^\d{4}-\d{2}-\d{2}$/u.test(report.reportDate ?? "")) {
    return null;
  }
  return report.reportDate <= reportDate ? report : null;
}

function marketSlice(report, market) {
  const driverIndexes = (report.drivers ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.market === market)
    .map(({ index }) => index);
  const updateIndexes = (report.aiChainUpdates ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.market === market)
    .map(({ index }) => index);
  return {
    ...(report.recaps?.[market] ? { recap: report.recaps[market] } : {}),
    marketAsOf: report.marketAsOf?.[market],
    marketView: report.marketViews?.[market],
    aiChainView: report.aiChainViews?.[market],
    markets: (report.markets ?? []).filter((item) => item.region === market),
    sectorPerformance: (report.sectorPerformance ?? []).filter(
      (item) => item.market === market,
    ),
    aiChainPerformance: (report.aiChainPerformance ?? []).filter(
      (item) => item.market === market,
    ),
    sectorHeat: (report.sectorHeat ?? []).filter(
      (item) => item.market === market,
    ),
    drivers: driverIndexes.map((index) => report.drivers[index]),
    aiChainUpdates: updateIndexes.map(
      (index) => report.aiChainUpdates[index],
    ),
    translation: {
      marketView: report.translations?.en?.marketViews?.[market],
      aiChainView: report.translations?.en?.aiChainViews?.[market],
      drivers: driverIndexes.map(
        (index) => report.translations?.en?.drivers?.[index],
      ),
      aiChainUpdates: updateIndexes.map(
        (index) => report.translations?.en?.aiChainUpdates?.[index],
      ),
    },
  };
}

export function workflowMarketContentHash(report, market) {
  return stableHash(canonical(marketSlice(report, market)));
}

function seededInactiveSlice(manifest, productionBefore, expectedContent) {
  if (productionBefore) return null;
  const inactiveMarket = manifest.market === "CN" ? "US" : "CN";
  if (!expectedContent.marketAsOf?.[inactiveMarket]) {
    return null;
  }
  return {
    market: inactiveMarket,
    marketAsOf: expectedContent.marketAsOf?.[inactiveMarket],
    marketContentHash: workflowMarketContentHash(
      expectedContent,
      inactiveMarket,
    ),
  };
}

async function readCurrentProductionSnapshot(input) {
  const report = await fetchComparisonReport(input);
  if (!report || report.reportDate !== input.reportDate) {
    throw new Error(`生产环境没有 ${input.reportDate} 的可回读日报`);
  }
  return { report };
}

async function readPublishingProductionSnapshot(input) {
  return fetchFreshDailySnapshot(input, {
    acceptedIngestionStatuses: ["running", "completed"],
  });
}

function replaceMarketRows(candidateRows, productionRows, market, field) {
  const kept = (candidateRows ?? []).filter((item) => item?.[field] !== market);
  const replacement = (productionRows ?? []).filter(
    (item) => item?.[field] === market,
  );
  return [...kept, ...replacement].sort((left, right) =>
    String(left?.[field] ?? "").localeCompare(String(right?.[field] ?? "")),
  );
}

function readerView(view, { ai = false } = {}) {
  const result = {
    headline: view?.headline,
    summary: view?.summary,
    driverStatus: view?.driverStatus,
  };
  if (ai && typeof view?.mechanism === "string" && view.mechanism.trim()) {
    result.mechanism = view.mechanism;
  }
  return result;
}

function translatedRows(report, field, market) {
  const sourceRows = report?.[field] ?? [];
  const translations = report?.translations?.en?.[field] ?? [];
  return sourceRows
    .map((item, index) => ({ item, translation: translations[index] }))
    .filter(({ item }) => item.market === market)
    .map(({ translation }) => translation);
}

function trimCharacters(value, max) {
  return [...String(value)].slice(0, max).join("").trim();
}

function activeOverviewText(combined, inactiveText, separator) {
  const value = String(combined ?? "").trim();
  const suffix = `${separator}${String(inactiveText ?? "").trim()}`;
  return value.endsWith(suffix)
    ? value.slice(0, -suffix.length).trim()
    : value;
}

export function refreshInactiveAnalysis(
  preparedReport,
  productionReport,
  activeMarket,
) {
  if (!productionReport) return preparedReport;
  const inactiveMarket = activeMarket === "CN" ? "US" : "CN";
  if (
    !productionReport.marketViews?.[inactiveMarket] ||
    !productionReport.aiChainViews?.[inactiveMarket] ||
    !productionReport.translations?.en?.marketViews?.[inactiveMarket] ||
    !productionReport.translations?.en?.aiChainViews?.[inactiveMarket]
  ) {
    throw new Error(`生产报告缺少 ${inactiveMarket} 市场切片，禁止覆盖`);
  }
  const activeOverview =
    preparedReport.workflowOverview?.market === activeMarket
      ? preparedReport.workflowOverview
      : null;
  const activeHeadline = activeOverview?.headline ?? activeOverviewText(
    preparedReport.headline,
    preparedReport.marketViews[inactiveMarket]?.headline,
    "；",
  );
  const activeSummary = activeOverview?.summary ?? activeOverviewText(
    preparedReport.summary,
    preparedReport.marketViews[inactiveMarket]?.summary,
    " ",
  );
  const activeHeadlineEn = activeOverview?.headlineEn ?? activeOverviewText(
    preparedReport.translations.en.headline,
    preparedReport.translations.en.marketViews[inactiveMarket]?.headline,
    "; ",
  );
  const activeSummaryEn = activeOverview?.summaryEn ?? activeOverviewText(
    preparedReport.translations.en.summary,
    preparedReport.translations.en.marketViews[inactiveMarket]?.summary,
    " ",
  );
  const report = structuredClone(preparedReport);
  if (report.recaps || productionReport.recaps) report.recaps = {
    ...(report.recaps?.[activeMarket] ? { [activeMarket]: report.recaps[activeMarket] } : {}),
    ...(productionReport.recaps?.[inactiveMarket] ? { [inactiveMarket]: productionReport.recaps[inactiveMarket] } : {}),
  };
  report.marketViews[inactiveMarket] = readerView(
    productionReport.marketViews[inactiveMarket],
  );
  report.aiChainViews[inactiveMarket] = readerView(
    productionReport.aiChainViews[inactiveMarket],
    { ai: true },
  );
  report.drivers = [
    ...report.drivers.filter((item) => item.market === activeMarket),
    ...(productionReport.drivers ?? []).filter(
      (item) => item.market === inactiveMarket,
    ),
  ];
  report.aiChainUpdates = [
    ...report.aiChainUpdates.filter((item) => item.market === activeMarket),
    ...(productionReport.aiChainUpdates ?? []).filter(
      (item) => item.market === inactiveMarket,
    ),
  ];
  const en = report.translations.en;
  en.marketViews[inactiveMarket] =
    productionReport.translations.en.marketViews[inactiveMarket];
  en.aiChainViews[inactiveMarket] =
    productionReport.translations.en.aiChainViews[inactiveMarket];
  en.drivers = [
    ...translatedRows(preparedReport, "drivers", activeMarket),
    ...translatedRows(productionReport, "drivers", inactiveMarket),
  ];
  en.aiChainUpdates = [
    ...translatedRows(preparedReport, "aiChainUpdates", activeMarket),
    ...translatedRows(productionReport, "aiChainUpdates", inactiveMarket),
  ];
  report.headline = trimCharacters(
    `${activeHeadline}；${report.marketViews[inactiveMarket].headline}`,
    100,
  );
  report.summary = trimReaderSummary(
    `${activeSummary} ${report.marketViews[inactiveMarket].summary}`,
    420,
  );
  en.headline = trimCharacters(
    `${activeHeadlineEn}; ${en.marketViews[inactiveMarket].headline}`,
    140,
  );
  en.summary = trimReaderSummary(
    `${activeSummaryEn} ${en.marketViews[inactiveMarket].summary}`,
    500,
  );
  return report;
}

export function preserveInactiveStoredSlice(
  candidateContent,
  productionReport,
  activeMarket,
) {
  if (!productionReport) return candidateContent;
  const inactiveMarket = activeMarket === "CN" ? "US" : "CN";
  if (!productionReport.marketAsOf?.[inactiveMarket]) {
    throw new Error(`生产报告缺少 ${inactiveMarket} 行情日期，禁止覆盖`);
  }
  const merged = structuredClone(candidateContent);
  if (merged.recaps || productionReport.recaps) merged.recaps = {
    ...(merged.recaps?.[activeMarket] ? { [activeMarket]: merged.recaps[activeMarket] } : {}),
    ...(productionReport.recaps?.[inactiveMarket] ? { [inactiveMarket]: productionReport.recaps[inactiveMarket] } : {}),
  };
  merged.marketAsOf[inactiveMarket] =
    productionReport.marketAsOf[inactiveMarket];
  merged.marketViews[inactiveMarket] =
    productionReport.marketViews[inactiveMarket];
  merged.aiChainViews[inactiveMarket] =
    productionReport.aiChainViews[inactiveMarket];
  merged.marketSessions = replaceMarketRows(
    merged.marketSessions,
    productionReport.marketSessions,
    inactiveMarket,
    "market",
  );
  merged.markets = replaceMarketRows(
    merged.markets,
    productionReport.markets,
    inactiveMarket,
    "region",
  );
  for (const field of [
    "sectorPerformance",
    "aiChainPerformance",
    "sectorHeat",
    "drivers",
    "aiChainUpdates",
  ]) {
    merged[field] = replaceMarketRows(
      merged[field],
      productionReport[field],
      inactiveMarket,
      "market",
    );
  }
  merged.translations.en.marketViews[inactiveMarket] =
    productionReport.translations.en.marketViews[inactiveMarket];
  merged.translations.en.aiChainViews[inactiveMarket] =
    productionReport.translations.en.aiChainViews[inactiveMarket];
  for (const field of ["drivers", "aiChainUpdates"]) {
    merged.translations.en[field] = ["CN", "US"].flatMap((market) =>
      translatedRows(
        market === activeMarket ? candidateContent : productionReport,
        field,
        market,
      ),
    );
  }
  return merged;
}

export async function auditWorkflowCausalEvidence({ manifest, report, manifestPath, input }) {
  for (const run of [...(manifest.agentRuns ?? []), ...(manifest.failedAgentRuns ?? [])]) {
    if (run.receiptArtifact) await auditNativeAgentAttempt(dirname(resolve(manifestPath)), run);
  }
  if (manifest.coverageRequired) {
    if (!input) throw new Error("完整复盘核验缺少确定性行情输入");
    const root = resolve(dirname(resolve(manifestPath)), "artifacts");
    const [ledger, social, draft, review, tradingData, macroData, attribution, transmission, companyBackground, pbocNews] = await Promise.all(["recap-ledger.json", "social-ledger.json", "recap-draft.json", "recap-review.json", "recap-trading-data.json", "recap-macro-data.json", "recap-attribution.json", "recap-transmission-data.json", "recap-company-background-data.json", "recap-pboc-news-data.json"].map(async (name) => JSON.parse(await readFile(resolve(root, name), "utf8"))));
    const sourceSnapshots = JSON.parse(await readFile(resolve(root, "recap-source-snapshots.json"), "utf8"));
    if (stableHash(sourceSnapshots) !== manifest.sourceSnapshotsHash) throw new Error("完整复盘原文快照哈希不一致");
    auditLedgerSourceSnapshots(ledger, sourceSnapshots, { envelope: researchMarketEnvelope(input, manifest.market), macroData });
    if (stableHash(ledger) !== manifest.recapLedgerHash || stableHash(social) !== manifest.socialHash || stableHash(draft) !== manifest.recapApproval?.draftHash || stableHash(review) !== manifest.recapApproval?.reviewHash || stableHash(tradingData) !== manifest.tradingHash || stableHash(macroData) !== manifest.macroHash) throw new Error("完整复盘证据、日线、宏观数据、原文或独立审稿哈希不一致");
    validateRecapTradingData(tradingData, researchMarketEnvelope(input, manifest.market));
    validateRecapMacroData(macroData, researchMarketEnvelope(input, manifest.market));
    if (stableHash(transmission) !== manifest.transmissionHash) throw new Error("完整复盘行业背景原文哈希不一致");
    validateRecapTransmissionData(transmission, researchMarketEnvelope(input, manifest.market), completeRecapPlan(researchMarketEnvelope(input, manifest.market), tradingData));
    if (stableHash(companyBackground) !== manifest.companyBackgroundHash) throw new Error("完整复盘公司身份、申报与敞口原文哈希不一致");
    validateRecapCompanyBackgroundData(companyBackground, researchMarketEnvelope(input, manifest.market), completeRecapPlan(researchMarketEnvelope(input, manifest.market), tradingData));
    if (stableHash(pbocNews) !== manifest.pbocNewsHash) throw new Error("完整复盘央行新闻目录与原文哈希不一致");
    const envelope = researchMarketEnvelope(input, manifest.market);
    validateRecapPbocNewsData(pbocNews, envelope);
    auditRecapPbocNewsSources(pbocNews, envelope, completeRecapPlan(envelope, tradingData), ledger, sourceSnapshots);
    if (stableHash(attribution) !== manifest.recapAttributionHash) throw new Error("完整复盘事件传导审查哈希不一致");
    validateRecapAttribution(attribution, researchMarketEnvelope(input, manifest.market), recapTargets(researchMarketEnvelope(input, manifest.market)), ledger, { requireComplete: true, macroData });
    if (!Object.values(manifest.stages ?? {}).some((stage) => stage.role === "deterministic_source_verification" && stage.status === "completed" && stage.outputHash === stableHash(ledger))) throw new Error("完整复盘证据尚未通过原文验证");
    for (const [role, field, expected] of [["recap_attributor", "attributionStage", attribution], ["recap_writer", "writerStage", draft], ["recap_reviewer", "reviewerStage", review]]) {
      const key = manifest.recapApproval?.[field];
      const stage = manifest.stages?.[key];
      if (typeof key !== "string" || !/^[a-z0-9-]+$/u.test(key) || stage?.role !== role || stage.status !== "completed" || !(manifest.agentRuns ?? []).some((run) => run.key === key && run.agentRunId === stage.agentRunId && run.role === role && run.status === "completed" && run.filesystemIsolation === AGENT_FILESYSTEM_ISOLATION)) throw new Error("完整复盘缺少对应成稿的独立写作或审稿进程");
      const text = await readFile(resolve(root, `${key}.json`), "utf8");
      if (stableHash(text) !== stage.outputHash || stableHash(JSON.parse(text)) !== stableHash(expected)) throw new Error("完整复盘成稿或审稿与独立进程产物不一致");
    }
    const recap = validateCompleteRecap(draft, researchMarketEnvelope(input, manifest.market), ledger, social, { requireComplete: true, tradingData, attribution, macroData });
    validateRecapReview(review, recap);
    if (stableHash(recap) !== manifest.recapApproval?.recapHash || stableHash(report.recaps?.[manifest.market]) !== stableHash(recap)) throw new Error("发布复盘与已批准完整复盘不一致");
  }
  const ledger = JSON.parse(await readFile(resolve(dirname(resolve(manifestPath)), "artifacts/evidence-ledger.json"), "utf8"));
  if (manifest.coverageRequired) auditLedgerSourceSnapshots(ledger, JSON.parse(await readFile(resolve(dirname(resolve(manifestPath)), "artifacts/recap-source-snapshots.json"), "utf8")), { envelope: researchMarketEnvelope(input, manifest.market) });
  if (!Object.values(manifest.stages ?? {}).some((stage) =>
    stage.role === "deterministic_source_verification" && stage.status === "completed" && stage.outputHash === stableHash(ledger)
  )) throw new Error("发布证据账本与已验证阶段哈希不一致");
  for (const item of [...report.drivers, ...report.aiChainUpdates].filter((item) => item.market === manifest.market)) {
    const urls = new Set(item.evidence.map((source) => source.source));
    if ((ledger.sources ?? []).some((source) => urls.has(source.url) && hasEarningsPerShareComparison(source) && source.earningsContextChecked !== true)) {
      throw new Error(`${item.title} 的每股收益证据尚未核查投资或非经常性收益口径`);
    }
    for (const source of ledger.sources ?? []) {
      if (urls.has(source.url)) assertComparisonNotesInExcerpt(source);
    }
    if (!(ledger.sources ?? []).some((source) =>
      source.role === "causal" && source.causalConnection && urls.has(source.url) && hasCausalPassage(source.supportingExcerpt)
    )) throw new Error(`${item.title} 的已核验原文缺少因果联系，禁止把并列行情发布为归因`);
  }
}

async function loadWorkflowArtifacts({ inputPath, reportPath, manifestPath }) {
  const [inputText, reportText, manifestText] = await Promise.all([
    readFile(resolve(inputPath), "utf8"),
    readFile(resolve(reportPath), "utf8"),
    readFile(resolve(manifestPath), "utf8"),
  ]);
  const input = validateInput(JSON.parse(inputText));
  const report = JSON.parse(reportText);
  const manifest = JSON.parse(manifestText);
  auditWorkflowManifest(manifest, reportText);
  const finalReview = JSON.parse(
    await readFile(
      resolve(dirname(resolve(manifestPath)), manifest.approval.reviewArtifact),
      "utf8",
    ),
  );
  if (stableHash(finalReview) !== manifest.approval.reviewHash) {
    throw new Error("最终 Reviewer 批准文件与运行清单哈希不一致");
  }
  if (
    manifest.inputHash !== manifest.marketInputHash ||
    manifest.inputHash !== marketInputHash(input, manifest.market) ||
    manifest.reportDate !== input.reportDate ||
    manifest.batchRunId !== input.runId
  ) {
    throw new Error("发布输入与多 Agent 运行清单不一致");
  }
  await auditWorkflowCausalEvidence({ manifest, report, manifestPath, input });
  return { input, report, manifest, reportText };
}

export async function verifyWorkflowReadback(
  { inputPath, reportPath, manifestPath },
  {
    readback = readCurrentProductionSnapshot,
    retryEqualMarketAsOfMismatch = false,
  } = {},
) {
  const { input, report, manifest } = await loadWorkflowArtifacts({
    inputPath,
    reportPath,
    manifestPath,
  });
  if (manifest.deliveryMode !== "publish") {
    throw new Error("工作流未授权进入生产发布模式");
  }
  const validatedReport = validateReport(report, input, {
    requireResearchAudit: false,
    activeMarket: manifest.market,
  });
  const expectedContent = JSON.parse(buildReportContent(input, validatedReport));
  const snapshot = await readback(input);
  if (snapshot.report?.reportDate !== input.reportDate) {
    throw new Error(`生产回读未返回目标日期 ${input.reportDate} 的日报`);
  }
  const expectedHash = workflowMarketContentHash(
    expectedContent,
    manifest.market,
  );
  const actualHash = workflowMarketContentHash(
    snapshot.report ?? {},
    manifest.market,
  );
  const inactiveSeedCandidate = seededInactiveSlice(
    manifest,
    null,
    expectedContent,
  );
  const verifiedInactiveSeed =
    inactiveSeedCandidate &&
    workflowMarketContentHash(
      snapshot.report ?? {},
      inactiveSeedCandidate.market,
    ) === inactiveSeedCandidate.marketContentHash
      ? inactiveSeedCandidate
      : null;
  const actualMarketAsOf = snapshot.report?.marketAsOf?.[manifest.market];
  const equalDateMismatch =
    actualMarketAsOf === manifest.marketAsOf && actualHash !== expectedHash;
  if (retryEqualMarketAsOfMismatch && equalDateMismatch) {
    throw new Error(
      `生产回读的 ${manifest.market} 同交易日切片与当前待恢复稿不一致`,
    );
  }
  if (
    snapshot.report?.agentModel === "openai/codex-multi-agent" &&
    (actualMarketAsOf > manifest.marketAsOf ||
      equalDateMismatch)
  ) {
    const superseded = {
      status: "superseded",
      recovered: true,
      reportDate: input.reportDate,
      market: manifest.market,
      marketAsOf: snapshot.report.marketAsOf,
    };
    Object.defineProperty(superseded, "productionReport", {
      value: snapshot.report,
      enumerable: false,
    });
    return superseded;
  }
  if (
    snapshot.report?.agentModel !== "openai/codex-multi-agent" ||
    expectedHash !== actualHash
  ) {
    throw new Error(`生产回读的 ${manifest.market} 市场切片不一致`);
  }
  const publication = {
    status: "published",
    recovered: true,
    reportDate: input.reportDate,
    market: manifest.market,
    marketAsOf: snapshot.report.marketAsOf,
    marketContentHash: expectedHash,
    ...(verifiedInactiveSeed
      ? { seededInactiveSlice: verifiedInactiveSeed }
      : {}),
  };
  Object.defineProperty(publication, "productionReport", {
    value: snapshot.report,
    enumerable: false,
  });
  return publication;
}

export async function publishWorkflowReport(
  {
    inputPath = "work/daily-input.json",
    reportPath = "work/daily-report.json",
    manifestPath = "work/daily-workflow-manifest.json",
  } = {},
  {
    execute = executeRemoteSql,
    readback = readPublishingProductionSnapshot,
    comparisonRead = fetchComparisonReport,
    expectedBaseMarketContentHash = null,
    replaceableSameMarketContentHashes = [],
    ingestionStatus = "running",
  } = {},
) {
  const { input, report, manifest } = await loadWorkflowArtifacts({
    inputPath,
    reportPath,
    manifestPath,
  });
  if (manifest.deliveryMode !== "publish") {
    throw new Error("工作流未授权进入生产发布模式");
  }
  const comparisonReport = await comparisonRead(input);
  const productionBefore = reportAtOrBeforeDate(
    comparisonReport,
    input.reportDate,
  );
  const validatedCandidate = validateReport(report, input, {
    requireResearchAudit: false,
    activeMarket: manifest.market,
  });
  const rawCandidateContent = JSON.parse(buildReportContent(input, validatedCandidate));
  const candidateMarketHash = workflowMarketContentHash(
    rawCandidateContent,
    manifest.market,
  );
  const matchingInactiveSeedCandidate = seededInactiveSlice(
    manifest,
    null,
    rawCandidateContent,
  );
  const matchingInactiveSeed =
    matchingInactiveSeedCandidate &&
    workflowMarketContentHash(
      productionBefore ?? {},
      matchingInactiveSeedCandidate.market,
    ) === matchingInactiveSeedCandidate.marketContentHash
      ? matchingInactiveSeedCandidate
      : null;
  const productionMarketAsOf =
    productionBefore?.marketAsOf?.[manifest.market];
  const productionMarketHash = workflowMarketContentHash(
    productionBefore ?? {},
    manifest.market,
  );
  const replaceableSameDate =
    productionMarketAsOf === manifest.marketAsOf &&
    replaceableSameMarketContentHashes.includes(productionMarketHash);
  if (productionMarketAsOf > manifest.marketAsOf) {
    const superseded = {
      status: "superseded",
      reportDate: input.reportDate,
      market: manifest.market,
      marketAsOf: productionBefore.marketAsOf,
    };
    Object.defineProperty(superseded, "productionReport", {
      value: productionBefore,
      enumerable: false,
    });
    return superseded;
  }
  if (
    productionBefore?.reportDate === input.reportDate &&
    productionBefore?.agentModel === "openai/codex-multi-agent" &&
    productionMarketAsOf === manifest.marketAsOf &&
    productionMarketHash !== candidateMarketHash &&
    !replaceableSameDate
  ) {
    const superseded = {
      status: "superseded",
      reportDate: input.reportDate,
      market: manifest.market,
      marketAsOf: productionBefore.marketAsOf,
    };
    Object.defineProperty(superseded, "productionReport", {
      value: productionBefore,
      enumerable: false,
    });
    return superseded;
  }
  if (
    productionBefore?.reportDate === input.reportDate &&
    productionBefore?.agentModel === "openai/codex-multi-agent" &&
    productionMarketAsOf === manifest.marketAsOf &&
    productionMarketHash === candidateMarketHash
  ) {
    const published = {
      status: "published",
      recovered: true,
      reportDate: input.reportDate,
      market: manifest.market,
      marketAsOf: productionBefore.marketAsOf,
      marketContentHash: candidateMarketHash,
      ...(matchingInactiveSeed
        ? { seededInactiveSlice: matchingInactiveSeed }
        : {}),
    };
    Object.defineProperty(published, "productionReport", {
      value: productionBefore,
      enumerable: false,
    });
    return published;
  }
  const baseMarketContentHash = workflowMarketContentHash(
    productionBefore ?? {},
    manifest.market,
  );
  if (
    expectedBaseMarketContentHash &&
    baseMarketContentHash !== expectedBaseMarketContentHash &&
    !replaceableSameDate
  ) {
    throw new Error(
      `生产环境的 ${manifest.market} 市场切片已在失败后变化，禁止重试覆盖`,
    );
  }
  const reportForPublish = refreshInactiveAnalysis(
    validatedCandidate,
    productionBefore,
    manifest.market,
  );
  const candidateContent = JSON.parse(
    buildReportContent(input, reportForPublish),
  );
  const expectedContent = preserveInactiveStoredSlice(
    candidateContent,
    productionBefore,
    manifest.market,
  );
  const inactiveSeed = seededInactiveSlice(
    manifest,
    productionBefore,
    expectedContent,
  );
  const publicationAttempt = {
    market: manifest.market,
    marketAsOf: manifest.marketAsOf,
    baseMarketContentHash,
    expectedMarketContentHash: workflowMarketContentHash(
      expectedContent,
      manifest.market,
    ),
    ingestionStatus,
    startedAt: new Date().toISOString(),
    ...(inactiveSeed ? { seededInactiveSlice: inactiveSeed } : {}),
  };
  let sqlResult;
  let snapshot;
  try {
    sqlResult = await execute(
      workflowCompletedSql(input, reportForPublish, expectedContent, {
        ingestionStatus,
      }),
    );
    snapshot = await readback(input);
  } catch (error) {
    const publicationError =
      error instanceof Error ? error : new Error(String(error));
    Object.defineProperty(publicationError, "publicationAttempt", {
      value: publicationAttempt,
      enumerable: false,
    });
    throw publicationError;
  }
  const contentFields = [
    "contractVersion",
    "overview",
    "marketViews",
    "aiChainViews",
    "recaps",
    "updateKind",
    "marketAsOf",
    "marketSessions",
    "markets",
    "sectorPerformance",
    "aiChainPerformance",
    "sectorHeat",
    "drivers",
    "aiChainUpdates",
    "stories",
    "translations",
    "isSample",
  ];
  const mismatches = contentFields.filter(
    (field) => !same(snapshot.report?.[field], expectedContent[field]),
  );
  if (
    snapshot.report?.headline !== reportForPublish.headline ||
    snapshot.report?.summary !== reportForPublish.summary ||
    snapshot.report?.agentModel !== "openai/codex-multi-agent" ||
    mismatches.length > 0
  ) {
    const publicationError = new Error(
      `生产回读与多 Agent 报告不一致${
        mismatches.length ? `：${mismatches.join(", ")}` : ""
      }`,
    );
    Object.defineProperty(publicationError, "publicationAttempt", {
      value: publicationAttempt,
      enumerable: false,
    });
    throw publicationError;
  }
  const publication = {
    status: "published",
    reportDate: input.reportDate,
    market: manifest.market,
    marketAsOf: snapshot.report.marketAsOf,
    agentRunCount: manifest.agentRuns.length,
    verifiedSourceCount: manifest.evidence.verifiedSourceCount,
    marketContentHash: workflowMarketContentHash(
      expectedContent,
      manifest.market,
    ),
    wrangler: sqlResult,
    ...(inactiveSeed ? { seededInactiveSlice: inactiveSeed } : {}),
  };
  Object.defineProperty(publication, "productionReport", {
    value: snapshot.report,
    enumerable: false,
  });
  return publication;
}

export async function publishPreparedWorkflowReport({
  inputPath,
  reportPath,
  manifestPath = "work/daily-workflow-manifest.json",
} = {}, options = {}) {
  const candidate = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const paths = {
    inputPath: inputPath ?? candidate.inputPath,
    reportPath: reportPath ?? candidate.reportPath,
    manifestPath: resolve(manifestPath),
  };
  const { manifest } = await loadWorkflowArtifacts(paths);
  if (manifest.deliveryMode !== "publish") throw new Error("工作流未授权进入生产发布模式");
  if (manifest.coverageRequired !== true || manifest.recapApproval?.status !== "complete") {
    throw new Error("生产发布需要通过完整板块复盘验收，旧版报告不得绕过覆盖检查");
  }
  // The convenience manifest is a copy. Persist publication state in the
  // original run so the scheduler and subsequent recovery see the same truth.
  const runDirectory = dirname(dirname(resolve(manifest.reportPath)));
  if (manifest.runKey && runDirectory.endsWith(`/${manifest.runKey}`)) {
    paths.manifestPath = resolve(runDirectory, "manifest.json");
    const original = await loadWorkflowArtifacts(paths);
    if (original.manifest.reportHash !== manifest.reportHash || original.manifest.batchRunId !== manifest.batchRunId) {
      throw new Error("待发布副本与原始运行清单不一致");
    }
  }
  const { recoverPendingPublications } = await import("./daily-workflow.mjs");
  const results = await recoverPendingPublications(dirname(dirname(paths.manifestPath)), {
    ...options,
    requireCompleteRecap: true,
    manifestPaths: [paths.manifestPath],
  });
  if (results.length) return results[0];
  return (options.verify ?? verifyWorkflowReadback)(paths);
}

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  const reportIndex = args.indexOf("--report");
  const manifestIndex = args.indexOf("--manifest");
  const result = await publishPreparedWorkflowReport({
    inputPath: inputIndex >= 0 ? args[inputIndex + 1] : undefined,
    reportPath: reportIndex >= 0 ? args[reportIndex + 1] : undefined,
    manifestPath: manifestIndex >= 0 ? args[manifestIndex + 1] : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!["published", "superseded"].includes(result.status) || ["failed", "pending", "abandoned"].includes(result.ingestionFinalization?.status)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Recovery imports the orchestrator, which imports this module. Finish module
  // evaluation before awaiting that dynamic import to avoid an ESM deadlock.
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
