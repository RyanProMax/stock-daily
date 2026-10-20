import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test, { before, after } from "node:test";

// Wrangler already depends on Miniflare. Test the compiled Pages Worker against
// its actual local D1 implementation as well as the SQLite fault-injection suite.
const wranglerRequire = createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
const { Miniflare } = wranglerRequire("miniflare");
const example = JSON.parse(await readFile("docs/report-contracts/examples/daily-v1.json"));
const fakeBearer = "fake-miniflare-report-writer-tests-only";
let mf, db;
before(async () => {
  mf = new Miniflare({ modules: true, scriptPath: resolve("dist/_worker.js"), compatibilityDate: "2026-07-25",
    compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "local-report-contract-tests" }, d1Persist: false,
    bindings: { REPORT_WRITE_TOKENS: JSON.stringify({ tests: fakeBearer }) } });
  db = await mf.getD1Database("DB");
  const names = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = (await readFile(`migrations/${name}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " ").trim();
    if (sql) await db.exec(sql);
  }
});
after(async () => { await mf?.dispose(); });
function put(payload, key, etag) {
  return mf.dispatchFetch(`https://reports.example.com/api/reports/${example.reportDate}`, { method: "PUT", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${fakeBearer}`, "Idempotency-Key": key,
    ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
  }, body: JSON.stringify(payload) });
}
test("compiled Pages Worker commits, replays and conditionally updates real local D1", async () => {
  const [first, concurrentReplay] = await Promise.all([put(example, "first"), put(example, "first")]);
  assert.equal(concurrentReplay.status, 200, await concurrentReplay.clone().text());
  assert.equal(first.status, 200, await first.clone().text());
  const receipt = (await first.json()).data;
  const read = await mf.dispatchFetch(`https://reports.example.com/api/reports/${example.reportDate}`);
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).data, example);
  assert.deepEqual((await (await put(example, "first")).json()).data, receipt);
  const changed = { ...example, headline: "Updated local D1 report" };
  assert.equal((await put(changed, "conflict")).status, 412);
  const updated = await put(changed, "second", receipt.etag);
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await updated.json()).data.revision, 2);
  assert.equal((await put(example, "stale", receipt.etag)).status, 412);
  assert.equal((await db.prepare("SELECT count(*) AS count FROM report_writes").first()).count, 2);
});
test("D1 batch rolls content back if receipt insertion fails", async () => {
  const row = await db.prepare("SELECT content, revision FROM daily_reports").first();
  await assert.rejects(db.batch([
    db.prepare("UPDATE daily_reports SET content = ?, revision = revision + 1").bind(JSON.stringify(example)),
    db.prepare("INSERT INTO report_writes (writer_id, idempotency_key, report_kind, report_key, request_hash, revision, content_hash, etag, accepted_at) VALUES ('tests', 'invalid', 'daily', 'example', 'example', NULL, 'example', 'example', 'example')"),
  ]));
  assert.deepEqual(await db.prepare("SELECT content, revision FROM daily_reports").first(), row);
});

test("competing conditional PUTs to real D1 accept exactly one revision", async () => {
  const read = await mf.dispatchFetch(`https://reports.example.com/api/reports/${example.reportDate}`);
  const etag = read.headers.get("ETag");
  const results = await Promise.all([
    put({ ...example, headline: "Concurrent A" }, "concurrent-a", etag),
    put({ ...example, headline: "Concurrent B" }, "concurrent-b", etag),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 412]);
  assert.equal((await db.prepare("SELECT revision FROM daily_reports").first()).revision, 3);
  assert.equal((await db.prepare("SELECT count(*) AS count FROM report_writes").first()).count, 3);
});
