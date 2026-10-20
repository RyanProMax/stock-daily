import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test, { before, after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite";

const daily = JSON.parse(await readFile("docs/report-contracts/examples/daily-v1.json"));
const weekly = JSON.parse(await readFile("docs/report-contracts/examples/weekly-v1.json"));
const migrations = await Promise.all((await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort().map((name) => readFile(`migrations/${name}`, "utf8")));
let vite, app, contract, storage;
before(async () => {
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false } });
  ({ default: app } = await vite.ssrLoadModule("/src/worker.tsx"));
  contract = await vite.ssrLoadModule("/src/contracts/reports.ts");
  storage = await vite.ssrLoadModule("/src/server/report-writes.ts");
});
after(async () => { await vite?.close(); });

// Executes the application's parameterized SQL and transaction boundaries against
// real SQLite. No production bindings, Wrangler state or network calls are used.
class LocalD1 {
  sql = new DatabaseSync(":memory:");
  failAfter = null;
  beforeBatch = null;
  constructor() { for (const migration of migrations) this.sql.exec(migration); }
  prepare(query) {
    const database = this;
    function prepared(values = []) {
      return {
        bind: (...args) => prepared(args),
        first: async () => database.sql.prepare(query).get(...values) ?? null,
        all: async () => ({ results: database.sql.prepare(query).all(...values), success: true }),
        run: async () => ({ success: true, meta: database.sql.prepare(query).run(...values) }),
      };
    }
    return prepared();
  }
  async batch(statements) {
    await this.beforeBatch?.();
    this.sql.exec("BEGIN");
    try {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        results.push(await statement.run());
        if (this.failAfter === index + 1) throw new Error("injected storage failure");
      }
      this.sql.exec("COMMIT");
      return results;
    } catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
  counts() { return this.sql.prepare("SELECT (SELECT count(*) FROM daily_reports) AS daily, (SELECT count(*) FROM weekly_reports) AS weekly, (SELECT count(*) FROM report_writes) AS receipts").get(); }
}
const fakeBearer = "fake-local-report-writer-for-tests-only";
function environment(db = new LocalD1()) { return { DB: db, REPORT_WRITE_TOKENS: JSON.stringify({ tests: fakeBearer }) }; }
const route = (kind) => kind === "daily" ? `/api/reports/${daily.reportDate}` : `/api/weekly/${weekly.weekEnd}`;
async function put(env, kind = "daily", payload = daily, headers = {}, key = "example-run") {
  return app.request(`https://reports.example.com${route(kind)}`, { method: "PUT", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${fakeBearer}`, "Idempotency-Key": key,
    "If-None-Match": "*", ...headers,
  }, body: JSON.stringify(payload) }, env);
}
async function get(env, kind = "daily") { return app.request(`https://reports.example.com${route(kind)}`, {}, env); }
function changed(payload = daily) { const next = structuredClone(payload); next.summary += " Updated."; return next; }

test("both final examples validate; generated declarations are checked by npm check", () => {
  assert.equal(contract.validateReportPayload("daily", daily), daily);
  assert.equal(contract.validateReportPayload("weekly", weekly), weekly);
});
test("writer fails closed for absent/malformed credentials and rejects unauthenticated callers", async () => {
  for (const setting of [undefined, "{}", "null", "bad", JSON.stringify({ tests: "short" })]) {
    const env = { DB: new LocalD1(), REPORT_WRITE_TOKENS: setting };
    assert.equal((await put(env)).status, 503);
    assert.equal(env.DB.counts().receipts, 0);
  }
  const env = environment();
  assert.equal((await put(env, "daily", daily, { Authorization: "" })).status, 401);
  assert.equal((await put(env, "daily", daily, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal(env.DB.counts().daily, 0);
  assert.equal((await put({ ...env, DB: undefined })).status, 503);
});
test("local/preview remote-data mode rejects PUT before it can proxy or write", async () => {
  const env = { ...environment(), REMOTE_DATA_ORIGIN: "https://production.example.com" };
  assert.equal((await put(env)).status, 405);
  assert.equal(env.DB.counts().daily, 0);
});
test("schema, calendar dates, deadlines, source URLs, translations and references are enforced", async () => {
  const changes = [
    (x) => { x.schemaVersion = "unknown-version"; },
    (x) => { x.reportDate = "2026-02-30"; },
    (x) => { x.researchAudit = {}; },
    (x) => { x.translations.en.stories.push({ title: "Extra", summary: "Extra", interpretation: "Extra", sectors: [] }); },
    (x) => { x.marketViews.CN.driverIds = ["unknown"]; },
    (x) => { x.markets[0].asOf = "2026-10-15"; },
    (x) => { x.markets[0].source = "javascript:alert(1)"; },
    (x) => { x.cutoffAt = "2026-10-19T12:00:00Z"; },
  ];
  const env = environment();
  for (const modify of changes) {
    const bad = structuredClone(daily); modify(bad);
    assert.equal((await put(env, "daily", bad)).status, 422);
  }
  const badEvent = structuredClone(weekly); badEvent.events[0].status = "realized";
  assert.equal((await put(env, "weekly", badEvent)).status, 422);
  const badWeek = structuredClone(weekly); badWeek.weekStart = badWeek.weekEnd;
  assert.equal((await put(env, "weekly", badWeek)).status, 422);
  assert.equal(env.DB.counts().receipts, 0);
});
test("required request headers, JSON and size limits are enforced", async () => {
  const env = environment();
  assert.equal((await put(env, "daily", daily, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await put(env, "daily", daily, { "Idempotency-Key": "" })).status, 400);
  assert.equal((await put(env, "daily", daily, { "If-None-Match": "" })).status, 428);
  assert.equal((await put(env, "daily", daily, { "If-None-Match": "", "If-Match": "*" })).status, 400);
  const oversized = { ...daily, summary: "x".repeat(1024 * 1024) };
  assert.equal((await put(env, "daily", oversized)).status, 413);
  const response = await app.request(`https://reports.example.com${route("daily")}`, { method: "PUT", headers: { Authorization: `Bearer ${fakeBearer}`, "Content-Type": "application/json", "Idempotency-Key": "bad-json", "If-None-Match": "*" }, body: "{" }, env);
  assert.equal(response.status, 400);
});
for (const [kind, example] of [["daily", daily], ["weekly", weekly]]) {
  test(`${kind}: persists the canonical contract, reads it back, and replays without another revision`, async () => {
    const env = environment();
    const response = await put(env, kind, example);
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = (await response.json()).data;
    assert.equal(receipt.revision, 1);
    const readback = await get(env, kind);
    assert.equal(readback.status, 200);
    assert.equal(readback.headers.get("Cache-Control"), "no-store");
    const read = await readback.json();
    assert.deepEqual(read.data, example);
    assert.equal(readback.headers.get("ETag"), receipt.etag);
    assert.equal(read.meta.contentHash, await storage.contentHash(example));
    const replay = await put(env, kind, example);
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).data, receipt);
    assert.equal(env.DB.counts().receipts, 1);
    assert.equal((await put(env, kind, changed(example))).status, 409);
    assert.equal((await put(env, kind, changed(example), {}, "second-key")).status, 412);
    const update = await put(env, kind, changed(example), { "If-None-Match": "", "If-Match": receipt.etag }, "second-key");
    assert.equal(update.status, 200, await update.clone().text());
    const updated = (await update.json()).data;
    assert.equal(updated.revision, 2);
    assert.equal((await put(env, kind, changed(example), { "If-None-Match": "", "If-Match": receipt.etag }, "stale-key")).status, 412);
    const same = await put(env, kind, changed(example), { "If-None-Match": "", "If-Match": updated.etag }, "same-content-new-key");
    assert.equal((await same.json()).data.revision, 2);
    // A delayed retry refers to its original receipt even after newer content.
    assert.deepEqual((await (await put(env, kind, example)).json()).data, receipt);
    assert.deepEqual((await (await get(env, kind)).json()).data, changed(example));
  });
  test(`${kind}: transaction failure rolls back both content and receipt`, async () => {
    const env = environment();
    const initial = (await (await put(env, kind, example)).json()).data;
    env.DB.failAfter = 1;
    const update = await put(env, kind, changed(example), { "If-None-Match": "", "If-Match": initial.etag }, "retryable");
    assert.equal(update.status, 503);
    assert.deepEqual((await (await get(env, kind)).json()).data, example);
    assert.equal(env.DB.counts().receipts, 1);
    env.DB.failAfter = null;
    assert.equal((await put(env, kind, changed(example), { "If-None-Match": "", "If-Match": initial.etag }, "retryable")).status, 200);
  });
  test(`${kind}: a write racing after preflight cannot overwrite the winning content`, async () => {
    const env = environment();
    const initial = (await (await put(env, kind, example)).json()).data;
    const winning = changed(example); winning.headline = "Winning report";
    env.DB.beforeBatch = () => {
      env.DB.beforeBatch = null;
      const table = kind === "daily" ? "daily_reports" : "weekly_reports";
      // A legacy writer changes content without updating the new revision column.
      env.DB.sql.prepare(`UPDATE ${table} SET content = ?, headline = ?`).run(JSON.stringify(winning), winning.headline);
    };
    const response = await put(env, kind, changed(example), { "If-None-Match": "", "If-Match": initial.etag }, "racing-key");
    assert.equal(response.status, 412);
    assert.deepEqual((await (await get(env, kind)).json()).data, winning);
    assert.equal(env.DB.counts().receipts, 1);
  });
}
test("a failed first creation leaves no placeholder report or receipt", async () => {
  const env = environment(); env.DB.failAfter = 1;
  assert.equal((await put(env)).status, 503);
  assert.equal((await get(env)).status, 404);
  assert.equal(env.DB.counts().receipts, 0);
});
test("idempotency keys are scoped by writer and cannot cross report resources", async () => {
  const env = environment();
  assert.equal((await put(env)).status, 200);
  assert.equal((await put(env, "weekly", weekly)).status, 409);
});
test("old market dates cannot replace a newer daily slice", async () => {
  const env = environment(); const receipt = (await (await put(env)).json()).data;
  const older = structuredClone(daily); older.marketAsOf.CN = "2026-10-15";
  older.markets[0].asOf = older.marketAsOf.CN; older.sectorPerformance[0].asOf = older.marketAsOf.CN; older.aiChainPerformance[0].asOf = older.marketAsOf.CN;
  assert.equal((await put(env, "daily", older, { "If-None-Match": "", "If-Match": receipt.etag }, "older")).status, 409);
  assert.deepEqual((await (await get(env)).json()).data, daily);
});
test("the additive migration leaves historical payload and metadata unchanged and readable", async () => {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations.slice(0, -1)) db.exec(migration);
  const legacyDaily = { ...daily, schemaVersion: undefined, cutoffAt: undefined, isSample: false };
  const legacyWeekly = { ...weekly, schemaVersion: undefined, cutoffAt: undefined };
  db.prepare("INSERT INTO daily_reports (report_date, edition, headline, summary, generated_at, data_cut, agent_model, content) VALUES (?, 1, ?, ?, ?, 'legacy cutoff', 'legacy-model', ?)").run(daily.reportDate, daily.headline, daily.summary, daily.generatedAt, JSON.stringify(legacyDaily));
  db.prepare("INSERT INTO weekly_reports (week_end, week_start, headline, summary, generated_at, agent_model, content) VALUES (?, ?, ?, ?, ?, 'legacy-model', ?)").run(weekly.weekEnd, weekly.weekStart, weekly.headline, weekly.summary, weekly.generatedAt, JSON.stringify(legacyWeekly));
  const before = db.prepare("SELECT * FROM daily_reports").get();
  const beforeWeek = db.prepare("SELECT * FROM weekly_reports").get();
  db.exec(migrations.at(-1));
  const { revision, ...rest } = db.prepare("SELECT * FROM daily_reports").get();
  assert.equal(revision, 0); assert.deepEqual(rest, { ...before });
  const { revision: weekRevision, ...weekRest } = db.prepare("SELECT * FROM weekly_reports").get();
  assert.equal(weekRevision, 0); assert.deepEqual(weekRest, { ...beforeWeek });
  const adapter = new LocalD1(); adapter.sql.close(); adapter.sql = db;
  const env = environment(adapter);
  const read = await get(env); assert.equal(read.status, 200);
  const body = await read.json(); assert.equal(body.data.agentModel, "legacy-model"); assert.equal(body.meta.revision, 0);
  assert.equal((await get(env, "weekly")).status, 200);
  // A historical report can be upgraded in place using its ETag without deleting history.
  assert.equal((await put(env, "daily", daily, { "If-None-Match": "", "If-Match": read.headers.get("ETag") })).status, 200);
  assert.equal(adapter.sql.prepare("SELECT edition FROM daily_reports").get().edition, 1);
});
test("new reports render through the existing bilingual daily and weekly pages", async () => {
  const env = environment();
  assert.equal((await put(env)).status, 200);
  assert.equal((await put(env, "weekly", weekly, {}, "weekly")).status, 200);
  for (const [path, title] of [["/?market=CN&lang=zh", daily.marketViews.CN.headline], ["/?market=US&lang=en", daily.translations.en.marketViews.US.headline], ["/weekly?lang=zh", weekly.headline], ["/weekly?lang=en", weekly.translations.en.headline]]) {
    const response = await app.request(`https://reports.example.com${path}`, {}, env);
    assert.equal(response.status, 200, await response.clone().text());
    const html = await response.text();
    assert.ok(html.includes(title));
    assert.doesNotMatch(html, /external-report-v1|external-agent|daily-v1|weekly-v1/);
  }
});

test("a lost database acknowledgement recovers the committed receipt", async () => {
  const env = environment();
  const original = env.DB.batch.bind(env.DB);
  env.DB.batch = async (...args) => { await original(...args); throw new Error("lost acknowledgement after commit"); };
  const response = await put(env);
  assert.equal(response.status, 200);
  assert.deepEqual((await (await get(env)).json()).data, daily);
  assert.equal(env.DB.counts().receipts, 1);
});

test("sourced industry, AI, news and recap modules round-trip without legacy research filtering", async () => {
  const report = structuredClone(daily);
  const evidence = { title: "Example announcement", facts: "Synthetic source facts.", source: "https://example.com/announcement", sourceLabel: "Example issuer", publishedAt: "2026-10-16T12:00:00Z", kind: "event", sourceType: "first_party" };
  const source = { id: "source-1", url: evidence.source, label: evidence.sourceLabel, publishedAt: evidence.publishedAt, verifiedAt: "2026-10-18T12:15:00Z" };
  report.drivers = [{ id: "driver-1", market: "US", role: "primary", basis: "event", direction: "positive", title: "示例行业因素", summary: "示例说明仅供格式测试。", mechanism: "示例传导机制。", sectorSymbols: ["US-TECH"], evidence: [evidence] }];
  report.aiChainUpdates = [{ id: "ai-1", market: "US", layer: "chips", title: "示例芯片观察", summary: "合成示例说明。", implication: "合成示例含义。", evidence: [evidence] }];
  report.stories = [{ id: "story-1", regions: ["US"], category: "公司", importance: 3, title: "示例公司事件", summary: "合成示例摘要。", evidence: "合成示例事实。", source: evidence.source, sourceLabel: evidence.sourceLabel, publishedAt: evidence.publishedAt }];
  report.marketViews.US.driverStatus = "partial"; report.marketViews.US.driverIds = ["driver-1"];
  report.aiChainViews.US.driverStatus = "partial"; report.aiChainViews.US.driverIds = ["ai-1"];
  report.recaps = { US: { market: "US", marketAsOf: report.marketAsOf.US, status: "partial", socialStatus: "no_relevant_posts", entries: [{ target: "SPX", kind: "market", status: "unresolved", confidence: "low", why: "证据尚不充分。", whyEn: "Evidence remains incomplete.", magnitude: "观察不足。", magnitudeEn: "Magnitude remains uncertain.", invalidateIf: "新证据改变观察。", invalidateIfEn: "New evidence changes the view.", sources: [source], alternatives: [], opinions: [] }] } };
  report.translations.en.drivers = [{ title: "Example industry factor", summary: "Synthetic source-based observation.", mechanism: "Example mechanism." }];
  report.translations.en.aiChainUpdates = [{ title: "Example chip observation", summary: "Synthetic AI observation.", implication: "Example implication." }];
  report.translations.en.stories = [{ title: "Example company event", summary: "Synthetic news summary.", interpretation: "Synthetic interpretation.", sectors: [] }];
  const env = environment();
  const response = await put(env, "daily", report);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await (await get(env)).json()).data, report);
  const view = await vite.ssrLoadModule("/src/server/reports.ts").then((module) => module.getDailyReport(env.DB, report.reportDate));
  assert.deepEqual(view.drivers, report.drivers);
  assert.deepEqual(view.recaps, report.recaps);
  const page = await app.request("https://reports.example.com/?market=US&lang=en", {}, env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Evidence remains incomplete."));
  assert.doesNotMatch(html, /external-agent|daily-v1/);
  const afterCutoff = structuredClone(report);
  afterCutoff.drivers[0].evidence[0].publishedAt = "2026-10-18T12:01:00Z";
  assert.throws(() => contract.validateReportPayload("daily", afterCutoff), /later than cutoff/);
  const lateVerification = structuredClone(report);
  lateVerification.recaps.US.entries[0].sources[0].verifiedAt = "2026-10-18T12:31:00Z";
  assert.throws(() => contract.validateReportPayload("daily", lateVerification), /later than generated/);
});

test("unknown persisted schema versions fail closed for readback and rendering", async () => {
  const env = environment();
  assert.equal((await put(env)).status, 200);
  const unknown = { ...daily, schemaVersion: "daily-v999" };
  env.DB.sql.prepare("UPDATE daily_reports SET content = ?").run(JSON.stringify(unknown));
  assert.equal((await get(env)).status, 503);
  const response = await app.request("https://reports.example.com/?market=US", {}, env);
  assert.equal(response.status, 503);
  assert.equal(env.DB.counts().receipts, 1);
});
test("report text cannot break out of HTML or hydration JSON, and source links reject unsafe schemes/credentials", async () => {
  const env = environment();
  const attack = '</script><img src=x onerror="globalThis.reportXss=1"><script>globalThis.reportXss=1</script>';
  const report = structuredClone(daily);
  report.headline = attack;
  report.summary = attack;
  report.marketViews.US.headline = attack;
  report.translations.en.marketViews.US.headline = attack;
  assert.equal((await put(env, "daily", report)).status, 200);
  const response = await app.request("https://reports.example.com/?market=US&lang=en", {}, env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /<img src=x|<script>globalThis\.reportXss/);
  const serialized = html.match(/<script id="stock-daily-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(serialized);
  assert.equal(JSON.parse(serialized).report.marketViews.US.headline, attack);
  for (const url of ["javascript:alert(1)", "data:text/html,test", "//evil.example.com/path", "https:" + "//name:pass@example.com/path", "https://name@example.com/path", "https://example.com/\nunsafe"]) {
    const bad = structuredClone(daily); bad.markets[0].source = url;
    assert.throws(() => contract.validateReportPayload("daily", bad));
  }
});
