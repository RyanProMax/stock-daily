import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let vite;
before(async () => {
  vite = await createServer({ appType: "custom", configFile: false, server: { middlewareMode: true, hmr: false } });
});
after(async () => { await vite?.close(); });

test("archive endpoint binds the historical boundary before applying its limit", async () => {
  const { default: app } = await vite.ssrLoadModule("/src/worker.tsx");
  const queries = [];
  const db = { prepare(sql) {
    return { bind(...parameters) {
      queries.push({ sql, parameters });
      return { async all() { return { results: [] }; } };
    } };
  } };
  const response = await app.request("https://example.com/api/reports?limit=1&before=2026-08-25", {}, { DB: db });
  assert.equal(response.status, 200);
  assert.deepEqual(queries[0].parameters, ["2026-08-25", 1]);
  assert.match(queries[0].sql, /WHERE report_date <= \?[\s\S]*ORDER BY report_date DESC[\s\S]*LIMIT \?/u);
  const invalid = await app.request("https://example.com/api/reports?before=invalid", {}, { DB: db });
  assert.equal(invalid.status, 400);
  assert.equal(queries.length, 1);
});
