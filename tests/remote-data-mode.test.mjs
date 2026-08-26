import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const removedLocalData = [
  "data/reports.json",
  "data/audited-news.json",
  "data/story-insights.json",
  "scripts/compact-reports.mjs",
  "scripts/sync-reports.mjs",
  "scripts/estimate-storage.mjs",
];

test("repository contains no persistent local report mirror", async () => {
  for (const path of removedLocalData) {
    await assert.rejects(access(path), `${path} must stay removed`);
  }
});

test("local development has no D1 binding and reads production", async () => {
  const [packageJson, devConfig, productionConfig] = await Promise.all([
    readFile("package.json", "utf8").then(JSON.parse),
    readFile("wrangler.jsonc", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);
  assert.match(packageJson.scripts.dev, /wrangler pages dev dist/);
  assert.match(packageJson.scripts.preview, /wrangler pages dev dist/);
  assert.equal(packageJson.scripts["db:migrate:local"], undefined);
  assert.equal(packageJson.scripts["data:sync"], undefined);
  assert.equal(packageJson.scripts["data:compact"], undefined);
  assert.equal(packageJson.scripts["storage:estimate"], undefined);
  const config = JSON.parse(devConfig);
  assert.equal(config.d1_databases, undefined);
  assert.equal(
    config.vars.REMOTE_DATA_ORIGIN,
    "https://stock-daily-8k4.pages.dev",
  );
  assert.equal(config.env.production.vars.REMOTE_DATA_ORIGIN, undefined);
  assert.equal(config.env.production.d1_databases[0].binding, "DB");
  assert.match(productionConfig, /"binding": "DB"/);
});

test("publication and replacement scripts only target remote D1", async () => {
  const [publisher, replacement] = await Promise.all([
    readFile("scripts/daily-publish.mjs", "utf8"),
    readFile("scripts/replace-daily-reports.mjs", "utf8"),
  ]);
  assert.match(publisher, /"--remote"/);
  assert.match(replacement, /"--remote"/);
  assert.doesNotMatch(publisher, /"--local"|stock-daily-db \(local\)/);
  assert.doesNotMatch(replacement, /"--local"|--persist-to/);
});

test("migration history contains schema only, never report payloads", async () => {
  const migrationNames = (await readdir("migrations")).filter((name) =>
    name.endsWith(".sql"),
  );
  const migrations = await Promise.all(
    migrationNames.map((name) => readFile(`migrations/${name}`, "utf8")),
  );
  const source = migrations.join("\n");
  assert.doesNotMatch(source, /2026-\d{2}-\d{2}/);
  assert.doesNotMatch(source, /https?:\/\//);
  assert.doesNotMatch(source, /INSERT INTO daily_reports[^;]*VALUES/is);
  assert.match(source, /CREATE TABLE daily_reports_compact/);
  assert.match(source, /INSERT INTO daily_reports_compact[^;]*SELECT/is);
});
