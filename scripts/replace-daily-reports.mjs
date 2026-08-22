import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildReportContent,
  validateInput,
  validateReport,
} from "./daily-publish.mjs";
import { marketAsOfFromInput } from "./daily-policy.mjs";

const execFileAsync = promisify(execFile);

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const local = args.includes("--local");
  const remote = args.includes("--remote");
  if (local === remote) throw new Error("必须且只能指定 --local 或 --remote");
  if (remote && !args.includes("--confirm-delete-all-daily")) {
    throw new Error("远程替换必须显式传入 --confirm-delete-all-daily");
  }

  const inputPath = resolve(argumentValue(args, "--input", "work/daily-input-v9.json"));
  const reportPath = resolve(argumentValue(args, "--report", "work/daily-report-v9.json"));
  const persistTo = argumentValue(args, "--persist-to", "");
  const input = validateInput(JSON.parse(await readFile(inputPath, "utf8")));
  const report = validateReport(JSON.parse(await readFile(reportPath, "utf8")), input);
  const marketAsOf = marketAsOfFromInput(input);
  if (
    input.contractVersion !== "market-attribution-v9" ||
    input.reportDate !== "2026-08-22" ||
    marketAsOf.CN !== "2026-08-21" ||
    marketAsOf.US !== "2026-08-21"
  ) {
    throw new Error("替换脚本只接受已校验的 2026-08-22 V9 验收样本");
  }

  const generatedAt = new Date().toISOString();
  const content = buildReportContent(input, report);
  const dataCut = `CN ${marketAsOf.CN} · US ${marketAsOf.US}`;
  const sql = `
DELETE FROM daily_reports;
INSERT INTO daily_reports (
  report_date, edition, headline, summary, generated_at,
  data_cut, agent_model, content
) VALUES (
  '2026-08-22', 1,
  ${sqlText(report.headline)},
  ${sqlText(report.summary)},
  ${sqlText(generatedAt)},
  ${sqlText(dataCut)},
  'openai/codex-scheduled',
  ${sqlText(content)}
);
INSERT INTO ingestion_runs (
  run_id, report_date, started_at, finished_at, status,
  market_count, news_count, error
) VALUES (
  ${sqlText(input.runId)},
  '2026-08-22',
  ${sqlText(input.collectedAt)},
  ${sqlText(generatedAt)},
  'completed',
  ${input.markets.length},
  ${input.news.length},
  NULL
)
ON CONFLICT(run_id) DO UPDATE SET
  finished_at = excluded.finished_at,
  status = 'completed',
  market_count = excluded.market_count,
  news_count = excluded.news_count,
  error = NULL;
`;

  const wranglerPath = resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const wranglerArgs = [
    "d1",
    "execute",
    "stock-daily-db",
    local ? "--local" : "--remote",
    "--yes",
    "--json",
    "--command",
    sql,
  ];
  if (local && persistTo) wranglerArgs.push("--persist-to", resolve(persistTo));
  const result = await execFileAsync(
    wranglerPath,
    wranglerArgs,
    { cwd: process.cwd(), env: process.env, maxBuffer: 8 * 1024 * 1024 },
  );
  console.log(JSON.stringify({
    status: "replaced",
    target: local ? "local" : "remote",
    reportDate: input.reportDate,
    edition: 1,
    driverCount: report.drivers.length,
    marketAsOf,
    wrangler: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  }, null, 2));
}

await main();
