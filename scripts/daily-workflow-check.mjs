import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditWorkflowManifest,
  marketInputHash,
  stableHash,
} from "./daily-workflow-core.mjs";
import { auditWorkflowCausalEvidence, verifyWorkflowReadback } from "./daily-workflow-publish.mjs";
import {
  buildReportContent,
  validateInput,
  validateReport,
} from "./daily-publish.mjs";

export async function checkWorkflowArtifacts({
  inputPath,
  reportPath,
  manifestPath = "work/daily-workflow-manifest.json",
  production = false,
} = {}) {
  const resolvedManifestPath = resolve(manifestPath);
  const manifestText = await readFile(resolvedManifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const resolvedInputPath = resolve(
    inputPath ?? manifest.inputPath ?? "work/daily-input.json",
  );
  const resolvedReportPath = resolve(
    reportPath ?? manifest.reportPath ?? "work/daily-report.json",
  );
  if (production) {
    return verifyWorkflowReadback({
      inputPath: resolvedInputPath,
      reportPath: resolvedReportPath,
      manifestPath: resolvedManifestPath,
    });
  }
  const [inputText, reportText] = await Promise.all([
    readFile(resolvedInputPath, "utf8"),
    readFile(resolvedReportPath, "utf8"),
  ]);
  const input = validateInput(JSON.parse(inputText));
  const report = JSON.parse(reportText);
  const audit = auditWorkflowManifest(manifest, reportText);
  const reviewText = await readFile(
    resolve(dirname(resolvedManifestPath), manifest.approval.reviewArtifact),
    "utf8",
  );
  if (manifest.approval.reviewHash !== stableHash(JSON.parse(reviewText))) {
    throw new Error("最终 Reviewer 批准文件与运行清单哈希不一致");
  }
  if (
    manifest.reportDate !== input.reportDate ||
    manifest.inputHash !== marketInputHash(input, manifest.market) ||
    manifest.batchRunId !== input.runId
  ) {
    throw new Error("检查输入与多 Agent 运行清单不一致");
  }
  await auditWorkflowCausalEvidence({ manifest, report, manifestPath: resolvedManifestPath, input });
  const validatedReport = validateReport(report, input, {
    requireResearchAudit: false,
    activeMarket: manifest.market,
  });
  const content = JSON.parse(buildReportContent(input, validatedReport));
  if (
    content.contractVersion !== "codex-market-research-v11" ||
    !content.marketViews?.CN ||
    !content.marketViews?.US
  ) {
    throw new Error("V11 网站内容构建失败");
  }
  return {
    status: "valid",
    reportDate: input.reportDate,
    market: manifest.market,
    marketAsOf: manifest.marketAsOf,
    agentRunCount: audit.agentRunCount,
    verifiedSourceCount: audit.verifiedSourceCount,
    minimumReviewScore: audit.minimumReviewScore,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  const reportIndex = args.indexOf("--report");
  const manifestIndex = args.indexOf("--manifest");
  const result = await checkWorkflowArtifacts({
    inputPath: inputIndex >= 0 ? args[inputIndex + 1] : undefined,
    reportPath: reportIndex >= 0 ? args[reportIndex + 1] : undefined,
    manifestPath: manifestIndex >= 0 ? args[manifestIndex + 1] : undefined,
    production: args.includes("--production"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
