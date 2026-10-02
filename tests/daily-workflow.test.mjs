import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeDailyMarketPack } from "../scripts/market-data.mjs";
import {
  assessDailyFreshness,
  dailyCutoffAt,
} from "../scripts/daily-policy.mjs";
import { yahooSectorPoint, currentSectorMetrics } from "../scripts/sector-heat.mjs";
import { auditStructuredOutputSchema } from "../scripts/structured-output-schema-audit.mjs";
import { ATTRIBUTION_VERSION } from "../scripts/recap-attribution.mjs";
import { fixtureInput } from "./daily-v10-fixture.mjs";
import { fetchComparisonReport } from "../scripts/daily-freshness.mjs";
import {
  handledMarketUpdates,
  mergeHandledMarketState,
} from "../scripts/daily-handled-markets.mjs";

test("historical comparison selects the newest eligible archived report", async () => {
  const requests = [];
  const fetcher = async (url) => {
    requests.push(url);
    const response = (status, data) => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => data,
    });
    if (url.includes("/api/reports/2026-08-21?")) return response(404, null);
    if (url.includes("/api/reports?") && url.includes("before=2026-08-21")) {
      return response(200, {
        data: [
          { reportDate: "2026-08-29" },
          { reportDate: "2026-08-20" },
          { reportDate: "2026-08-19" },
        ],
      });
    }
    if (url.includes("/api/reports/2026-08-20?")) {
      return response(200, { data: { reportDate: "2026-08-20" } });
    }
    return response(404, null);
  };
  const report = await fetchComparisonReport(
    { reportDate: "2026-08-21" },
    "https://example.test",
    { fetcher },
  );
  assert.equal(report.reportDate, "2026-08-20");
  assert.equal(
    requests.some((url) =>
      url.includes("/api/reports?limit=1&before=2026-08-21"),
    ),
    true,
  );
  assert.equal(
    requests.some((url) => url.includes("/api/reports/2026-08-29?")),
    false,
  );
});

test("daily scheduler delegates to isolated ephemeral market agents", async () => {
  const [scheduler, workflow, publisher] = await Promise.all([
    readFile(new URL("../scripts/run-codex-daily.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/daily-workflow.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/daily-workflow-publish.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(scheduler, /scripts\/daily-workflow\.mjs/);
  assert.doesNotMatch(scheduler, /codex-daily-agent-prompt|daily-review-prompt/);
  assert.match(workflow, /"--ephemeral"/);
  assert.match(workflow, /definition\.search \? \["--search"\] : \[\]\),\s*"exec"/);
  assert.match(workflow, /"--ignore-user-config"/);
  assert.match(workflow, /"--sandbox",\s*"read-only"/);
  assert.match(workflow, /facts:\s*\{\s*prompt: "facts-researcher\.md"/);
  assert.match(workflow, /causal:\s*\{\s*prompt: "causal-researcher\.md"/);
  assert.match(workflow, /role: "reviewer"/);
  assert.match(workflow, /randomUUID\(\)/);
  assert.match(workflow, /Promise\.all\(\[/);
  const thirdRepairIndex = workflow.indexOf("repairRound <= 3");
  assert.ok(
    thirdRepairIndex >= 0 &&
      thirdRepairIndex < workflow.indexOf("const failedIds = new Set", thirdRepairIndex),
    "three stage-directed repair rounds must run before an otherwise valid single card is dropped",
  );
  assert.match(workflow, /DEFAULT_RESEARCH_BUDGET_MS = 20 \* 60/);
  assert.match(workflow, /DEFAULT_WORKFLOW_TIMEOUT_MS = 45 \* 60/);
  assert.match(workflow, /this\.searchQueryCount > this\.searchQueryLimit/);
  assert.match(scheduler, /freshness_status != 0 && freshness_status != 10/);
  assert.match(scheduler, /--timeout-ms 6900000/);
  assert.doesNotMatch(scheduler, /const handled = item\.status === "no_claims"/);
  assert.match(scheduler, /result\.status === "pending_no_claims"/);
  assert.match(scheduler, /last-handled-market-as-of\.json/);
  assert.match(scheduler, /--handled-market-as-of/);
  assert.match(
    scheduler,
    /requested_date.*shadow_run.*workflow_args\+=\(--force-markets\)/s,
  );
  assert.match(scheduler, /scripts\/daily-handled-markets\.mjs/);
  assert.doesNotMatch(scheduler, /LAST_HANDLED_FILE/);
  assert.match(scheduler, /result\.status === "skipped"\) process\.exit\(12\)/);
  assert.match(scheduler, /publication_status == 12[\s\S]*compensation trigger/);
  assert.match(scheduler, /process\.exit\(fullyPublished \? 0 : 1\)/);
  assert.match(workflow, /manifestPath: result\.manifestPath/);
  assert.match(workflow, /recovered = await verifyWorkflowReadback/);
  assert.match(workflow, /existing\.outputHash === stableHash\(cached\)/);
  assert.match(publisher, /fetchFreshDailySnapshot/);
  assert.match(publisher, /workflowMarketContentHash/);
  assert.match(scheduler, /kill -0 "\$\{stale_lock_pid\}"/);
  assert.match(scheduler, /printf "%s\\n" "\$\$" > "\$\{LOCK_PID_FILE\}"/);
});

test("handled-market checkpoints use production-confirmed dates from runs and recoveries", () => {
  const result = {
    results: [
      {
        status: "ready",
        market: "US",
        marketAsOf: "2026-08-21",
        publication: {
          status: "superseded",
          marketAsOf: { CN: "2026-08-21", US: "2026-08-22" },
        },
      },
      {
        status: "ready",
        market: "CN",
        marketAsOf: "2026-08-24",
        publication: { status: "pending" },
      },
    ],
    recoveries: [
      {
        status: "published",
        market: "CN",
        marketAsOf: { CN: "2026-08-23", US: "2026-08-22" },
      },
      {
        status: "pending",
        market: "CN",
        marketAsOf: "2026-08-24",
      },
    ],
  };

  assert.deepEqual(handledMarketUpdates(result), {
    CN: "2026-08-23",
    US: "2026-08-22",
  });
  assert.deepEqual(
    mergeHandledMarketState({ CN: "2026-08-24", US: "2026-08-20" }, result),
    { CN: "2026-08-24", US: "2026-08-22" },
  );
});

test("handled-market checkpoints never fall back to an unconfirmed attempted date", () => {
  assert.deepEqual(
    handledMarketUpdates({
      results: [
        {
          status: "ready",
          market: "US",
          marketAsOf: "2026-08-29",
          publication: { status: "published" },
        },
      ],
      recoveries: [
        {
          status: "deferred",
          market: "CN",
          marketAsOf: "2026-08-29",
        },
      ],
    }),
    {},
  );
});

test("destructive report replacement requires search and source audits", async () => {
  const replacement = await readFile(
    new URL("../scripts/replace-daily-reports.mjs", import.meta.url),
    "utf8",
  );
  const searchAudit = replacement.indexOf("auditCodexRun(eventsText, report, input)");
  const sourceAudit = replacement.indexOf("await auditReportSources(report)");
  const deleteSql = replacement.indexOf("DELETE FROM daily_reports");
  assert.ok(searchAudit >= 0 && sourceAudit > searchAudit);
  assert.ok(deleteSql > sourceAudit);
  assert.match(replacement, /--confirm-delete-all-daily/);
});

test("the publication boundary accepts only an audited multi-agent manifest", async () => {
  const [legacyPublisher, publisher] = await Promise.all([
    readFile(new URL("../scripts/daily-publish.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/daily-workflow-publish.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(legacyPublisher, /旧的一体化日报发布入口已停用/);
  assert.match(publisher, /auditWorkflowManifest\(manifest, reportText\)/);
  assert.match(publisher, /manifest\.deliveryMode !== "publish"/);
  assert.match(publisher, /fetchFreshDailySnapshot/);
  assert.match(publisher, /生产回读与多 Agent 报告不一致/);
});

test("shadow mode validates a real report without writing Cloudflare state", async () => {
  const [scheduler, workflow] = await Promise.all([
    readFile(new URL("../scripts/run-codex-daily.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/daily-workflow.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(scheduler, /workflow_args\+=\(--shadow\)/);
  assert.match(workflow, /if \(publish && !shadow\)/);
  assert.match(workflow, /deliveryMode = shadow/);
});

test("daily task uses market results as search leads instead of a news pool", async () => {
  const [planner, facts, causal, writer, task, collector, schema] = await Promise.all([
    readFile(
      new URL("../docs/daily-agents/planner.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../docs/daily-agents/facts-researcher.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../docs/daily-agents/causal-researcher.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../docs/daily-agents/writer.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../docs/codex-daily-task.md", import.meta.url), "utf8"),
    readFile(new URL("../scripts/daily-collect.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../docs/daily-agents/draft.schema.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  assert.match(planner, /three genuinely competing hypotheses/);
  assert.match(facts, /actual and consensus\/baseline values/);
  assert.match(causal, /competing explanations/);
  assert.match(causal, /same-day event plus a price move is not enough/);
  assert.match(causal, /different registered publisher/);
  assert.match(causal, /excludedSources/);
  assert.match(writer, /100–220 Chinese characters/);
  assert.match(writer, /不能据此声称/);
  assert.match(task, /主动(?:研究|检索)/);
  assert.doesNotMatch(collector, /news-pipeline|x-intelligence/);
  assert.match(collector, /marketBriefs/);
  assert.equal(
    schema.properties.contractVersion.const,
    "stock-daily-market-draft-v1",
  );
  assert.equal(schema.$defs.driver.properties.mechanism.minLength, 100);
  assert.equal(schema.$defs.aiUpdate.properties.implication.minLength, 100);
  assert.equal(schema.$defs.driver.properties.summary.minLength, 100);
  assert.equal(schema.$defs.driver.properties.summary.maxLength, 220);
  assert.equal(schema.$defs.aiUpdate.properties.summary.minLength, 100);
});

test("resume and repair are scoped to immutable stage artifacts", async () => {
  const workflow = await readFile(
    new URL("../scripts/daily-workflow.mjs", import.meta.url),
    "utf8",
  );
  // Checkpoint hashes and changed-file rejection are exercised behaviorally
  // by the multi-agent harness, including research batch preflight.
  assert.match(workflow, /role = repairReview \? "repair" : "writer"/);
  assert.match(workflow, /repairIssues/);
  assert.doesNotMatch(workflow, /previousDraft: repairReview\.draft, review:/);
});

test("Codex output schemas satisfy strict structured-output requirements", async () => {
  const names = ["plan", "evidence", "adjudication", "draft", "review", "translation", "recap-attribution"];
  const schemas = await Promise.all(
    names.map((name) =>
      readFile(new URL(`../docs/daily-agents/${name}.schema.json`, import.meta.url), "utf8").then(JSON.parse),
    ),
  );
  for (const schema of schemas) {
    assert.equal(auditStructuredOutputSchema(schema).status, "valid");
  }
  assert.equal(schemas.at(-1).properties.contractVersion.const, ATTRIBUTION_VERSION);
  const invalid = structuredClone(schemas[3]);
  invalid.$defs.aiView.required = invalid.$defs.aiView.required.filter(
    (key) => key !== "mechanism",
  );
  assert.throws(
    () => auditStructuredOutputSchema(invalid),
    /required 缺少 mechanism/,
  );
});

test("daily policy publishes only when at least one market advances", () => {
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
  assert.equal(checkpoint.publish, false);
  assert.equal(checkpoint.reason, "no_material_advance");
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

test("current sector quotations cite the provider actually read rather than an unread official page", () => {
  const cutoff = Date.parse("2026-08-21T21:00:00Z");
  for (const [market, symbol, path] of [["US", "XLK", "/us/XLK.html"], ["CN", "932077", "/zz/2.932077.html"]]) {
    const sectors = [{ symbol, name: "科技", nameEn: "Technology" }];
    const payload = { data: { diff: [{ f12: symbol, f3: 1.23, f124: cutoff / 1000 }] } };
    const [metric] = currentSectorMetrics(payload, sectors, market, cutoff);
    assert.equal(metric.source, `https://quote.eastmoney.com${path}`);
    assert.equal(metric.change, "+1.23%");
    payload.data.diff[0].f12 = "WRONG";
    assert.throws(() => currentSectorMetrics(payload, sectors, market, cutoff), /sectors/);
  }
});
