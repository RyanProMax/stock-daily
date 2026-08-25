import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeDailyMarketPack } from "../scripts/market-data.mjs";
import {
  assessDailyFreshness,
  dailyCutoffAt,
} from "../scripts/daily-policy.mjs";
import { yahooSectorPoint } from "../scripts/sector-heat.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";

test("daily scheduler runs native search in read-only mode before validation and publication", async () => {
  const scheduler = await readFile(
    new URL("../scripts/run-codex-daily.sh", import.meta.url),
    "utf8",
  );
  assert.match(scheduler, /"\$\{CODEX_BIN\}" --search exec/);
  assert.match(scheduler, /--sandbox read-only/);
  assert.match(scheduler, /--json/);
  assert.match(scheduler, /--output-schema "\$\{REPORT_SCHEMA_FILE\}"/);
  assert.match(
    scheduler,
    /--output-last-message "\$\{REPORT_FILE\}"[\s\S]*?> "\$\{AGENT_EVENTS_FILE\}"/,
  );

  const collect = scheduler.indexOf("npm run daily:collect");
  const codex = scheduler.indexOf('"${CODEX_BIN}" --search exec');
  const audit = scheduler.indexOf("node scripts/daily-agent-audit.mjs");
  const sourceAudit = scheduler.indexOf("node scripts/daily-source-audit.mjs");
  const check = scheduler.indexOf("npm run daily:check");
  const publish = scheduler.indexOf("npm run daily:publish");
  const verify = scheduler.indexOf("node scripts/daily-verify.mjs");
  assert.ok(
    collect < codex &&
      codex < audit &&
      audit < sourceAudit &&
      sourceAudit < check,
  );
  assert.ok(check < publish && publish < verify);
});

test("destructive report replacement requires search and source audits", async () => {
  const replacement = await readFile(
    new URL("../scripts/replace-daily-reports.mjs", import.meta.url),
    "utf8",
  );
  const searchAudit = replacement.indexOf("auditCodexRun(eventsText, report)");
  const sourceAudit = replacement.indexOf("await auditReportSources(report)");
  const deleteSql = replacement.indexOf("DELETE FROM daily_reports");
  assert.ok(searchAudit >= 0 && sourceAudit > searchAudit);
  assert.ok(deleteSql > sourceAudit);
  assert.match(replacement, /--confirm-delete-all-daily/);
});

test("the publication boundary cannot bypass search or source audits", async () => {
  const publisher = await readFile(
    new URL("../scripts/daily-publish.mjs", import.meta.url),
    "utf8",
  );
  const reportValidation = publisher.lastIndexOf("const report = validateReport(");
  const searchAudit = publisher.lastIndexOf("auditCodexRun(eventsText, report)");
  const sourceAudit = publisher.lastIndexOf("await auditReportSources(report)");
  const publication = publisher.lastIndexOf(
    "executeSql(completedSql(input, report)",
  );
  assert.ok(reportValidation >= 0);
  assert.ok(searchAudit > reportValidation);
  assert.ok(sourceAudit > searchAudit);
  assert.ok(publication > sourceAudit);
});

test("shadow mode validates a real report without writing Cloudflare state", async () => {
  const scheduler = await readFile(
    new URL("../scripts/run-codex-daily.sh", import.meta.url),
    "utf8",
  );
  const shadowBranch = scheduler.match(
    /if \[\[ "\$\{shadow_run\}" == true \]\]; then([\s\S]*?)fi/,
  )?.[1];
  assert.ok(shadowBranch);
  assert.match(shadowBranch, /publication skipped/);
  assert.match(shadowBranch, /exit 0/);
  assert.doesNotMatch(shadowBranch, /daily:publish|daily-verify/);
});

test("daily task uses market results as search leads instead of a news pool", async () => {
  const [prompt, task, collector, schema] = await Promise.all([
    readFile(
      new URL("../docs/codex-daily-agent-prompt.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../docs/codex-daily-task.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../scripts/daily-collect.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../docs/daily-report.schema.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  assert.match(prompt, /实时网页搜索/);
  assert.match(prompt, /至少执行三类独立的窄搜索/);
  assert.match(prompt, /结构性轮动作为主因/);
  assert.doesNotMatch(prompt, /不要联网/);
  assert.match(task, /主动(?:研究|检索)/);
  assert.doesNotMatch(collector, /news-pipeline|x-intelligence/);
  assert.match(collector, /marketBriefs/);
  assert.equal(
    schema.properties.contractVersion.const,
    "codex-market-research-v10",
  );
  assert.ok(schema.required.includes("researchAudit"));
});

test("daily policy refreshes scheduled checkpoints without news-pool state", () => {
  assert.equal(
    dailyCutoffAt("2026-08-25", "morning"),
    "2026-08-25T01:00:00.000Z",
  );
  assert.equal(
    dailyCutoffAt("2026-08-25", "close"),
    "2026-08-25T08:00:00.000Z",
  );
  assert.equal(
    dailyCutoffAt("2026-08-25", "evening"),
    "2026-08-25T13:00:00.000Z",
  );

  const input = fixtureInput();
  const previous = {
    reportDate: input.reportDate,
    updateKind: input.updateKind,
    marketAsOf: { CN: "2026-08-21", US: "2026-08-21" },
  };
  assert.deepEqual(assessDailyFreshness(input, previous), {
    publish: false,
    retryable: false,
    reason: "no_material_advance",
    marketAsOf: { CN: "2026-08-21", US: "2026-08-21" },
    previousMarketAsOf: { CN: "2026-08-21", US: "2026-08-21" },
    advancedMarkets: [],
    newStoryCount: 0,
    checkpointChanged: false,
  });

  const evening = structuredClone(input);
  evening.updateKind = "evening";
  evening.cutoffAt = dailyCutoffAt(evening.reportDate, "evening");
  const checkpoint = assessDailyFreshness(evening, previous);
  assert.equal(checkpoint.publish, true);
  assert.equal(checkpoint.reason, "scheduled_checkpoint");
  assert.equal(checkpoint.newStoryCount, 0);
});

test("weekday close retries until current China close data exists", () => {
  const input = fixtureInput();
  input.reportDate = "2026-08-25";
  input.updateKind = "close";
  input.cutoffAt = dailyCutoffAt(input.reportDate, input.updateKind);
  const result = assessDailyFreshness(input, null);
  assert.equal(result.publish, false);
  assert.equal(result.retryable, true);
  assert.equal(result.reason, "cn_close_not_available");
});

test("daily market pack preserves prior sessions and hides implementation labels", () => {
  const input = fixtureInput();
  const apiMarkets = input.markets.map((market) => ({
    symbol: market.symbol,
    name: market.name,
    region: market.region,
    kind: market.symbol === "DGS10" ? "yield" : "index",
    unit: market.symbol === "DGS10" ? "percent" : "points",
    latest_value: 100,
    previous_value: 99,
    change_value: 1,
    change_ratio: 0.01,
    display_value: market.value,
    display_change: market.change,
    direction: market.direction,
    as_of: market.asOf,
    previous_as_of: market.previousAsOf,
    provider: "fixture",
    source: market.source,
    source_label: "Verified close",
    provider_attempts: [{ provider: "fixture", status: "ok" }],
  }));
  const normalized = normalizeDailyMarketPack({
    schema_version: "market-data-query.v1",
    status: "ok",
    source: "market_data_query",
    computed_at: input.collectedAt,
    request: {
      operation: "daily_market_pack",
      cutoff_at: input.cutoffAt,
      persistence: "none",
    },
    summary: { requested: 10, succeeded: 10, failed: 0 },
    data: { markets: apiMarkets, failures: [] },
  });
  assert.equal(normalized.markets.length, 10);
  assert.equal(normalized.markets[0].previousAsOf, "2026-08-20");
  assert.doesNotMatch(
    normalized.markets.map((market) => market.note).join(" "),
    /API\s*Skill|market_data_query/iu,
  );
  assert.equal(normalized.diagnostics.persistence, "none");
});

test("sector quote settlement grace rejects data beyond the cutoff", () => {
  const cutoffTime = Date.parse("2026-08-21T07:00:00.000Z");
  const payload = {
    chart: {
      result: [
        {
          meta: {
            regularMarketTime:
              Date.parse("2026-08-21T07:00:24.000Z") / 1_000,
            regularMarketPrice: 101,
            chartPreviousClose: 100,
          },
        },
      ],
    },
  };
  assert.equal(yahooSectorPoint(payload, cutoffTime).asOf, "2026-08-21");
  payload.chart.result[0].meta.regularMarketTime =
    Date.parse("2026-08-21T07:05:01.000Z") / 1_000;
  assert.equal(yahooSectorPoint(payload, cutoffTime), null);
});
