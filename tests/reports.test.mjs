import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reports = JSON.parse(
  await readFile(new URL("../data/reports.json", import.meta.url), "utf8"),
);

test("report archive is unique and newest-first", () => {
  assert.ok(reports.length >= 7);
  const dates = reports.map((report) => report.reportDate);
  assert.equal(new Set(dates).size, dates.length);
  assert.deepEqual(dates, [...dates].sort().reverse());
  for (const requiredDate of [
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
    "2026-07-25",
    "2026-07-26",
  ]) {
    assert.ok(dates.includes(requiredDate), `${requiredDate} must be backfilled`);
  }
});

test("every report contains only the minimum renderable daily brief", () => {
  for (const report of reports) {
    assert.match(report.reportDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(report.edition > 0);
    assert.ok(report.headline.length > 5);
    assert.ok(report.summary.length > 5);
    assert.equal(report.isSample, false);
    assert.doesNotMatch(report.agentModel, /manual/i);
    assert.doesNotMatch(
      `${report.headline} ${report.summary}`,
      /演示|示例|demo|sample/i,
    );
    if (Array.isArray(report.overview)) {
      assert.ok(report.overview.length >= 1);
    } else {
      assert.ok(["positive", "negative", "mixed"].includes(report.overview.tone));
      assert.ok(report.overview.interpretation.length > 20);
      assert.ok(Array.isArray(report.overview.positive));
      assert.ok(Array.isArray(report.overview.negative));
    }
    assert.ok(report.marketViews.CN);
    assert.ok(report.marketViews.US);
    for (const market of ["CN", "US"]) {
      const view = report.marketViews[market];
      assert.ok(view.headline.length > 5);
      assert.ok(view.summary.length > 5);
      assert.ok(["positive", "negative", "mixed"].includes(view.overview.tone));
      assert.ok(view.overview.interpretation.length > 20);
    }
    assert.equal(report.markets.length, 6);
    assert.equal(
      report.markets.filter((market) => market.region === "CN").length,
      2,
    );
    assert.equal(
      report.markets.filter((market) => market.region === "US").length,
      4,
    );
    for (const market of report.markets) {
      assert.ok(market.source.startsWith("https://"));
    }
    assert.equal(report.sectorHeat.length, 6);
    assert.equal(
      report.sectorHeat.filter((sector) => sector.market === "CN").length,
      3,
    );
    assert.equal(
      report.sectorHeat.filter((sector) => sector.market === "US").length,
      3,
    );
    assert.equal(
      new Set(
        report.sectorHeat.map(
          (sector) => `${sector.market}:${sector.symbol}`,
        ),
      ).size,
      report.sectorHeat.length,
    );
    for (const sector of report.sectorHeat) {
      assert.ok(sector.name);
      assert.ok(sector.nameEn);
      assert.match(sector.symbol, /^[A-Z0-9]{2,10}$/);
      assert.ok(Number.isInteger(sector.score));
      assert.ok(sector.score >= 0 && sector.score <= 100);
      assert.match(sector.change, /^[+-]?\d+(?:\.\d+)?%$/);
      assert.ok(["up", "down", "flat"].includes(sector.direction));
      assert.match(sector.asOf, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(sector.source.startsWith("https://"));
    }
    const reportWeekday = new Date(
      `${report.reportDate}T12:00:00.000Z`,
    ).getUTCDay();
    const minimumStoriesPerMarket =
      reportWeekday === 0 || reportWeekday === 6 ? 3 : 4;
    for (const market of ["CN", "US"]) {
      const storyCount = report.stories.filter((story) =>
        story.regions.includes(market),
      ).length;
      assert.ok(
        storyCount >= minimumStoriesPerMarket && storyCount <= 6,
        `${report.reportDate} ${market} must contain ${minimumStoriesPerMarket}–6 stories`,
      );
    }
    assert.equal(
      report.translations.en.stories.length,
      report.stories.length,
      `${report.reportDate} English stories must align with source stories`,
    );
    assert.ok(report.agentModel);
    assert.equal("leadPoints" in report, false);
    assert.equal("quickReads" in report, false);
    assert.equal("keyNumbers" in report, false);
    assert.equal("events" in report, false);
    assert.equal("watchlist" in report, false);
    assert.equal("editorialBody" in report, false);

    for (const story of report.stories) {
      assert.ok(story.id);
      assert.ok(story.source.startsWith("https://"));
      assert.ok(story.publishedAt);
      assert.ok(
        Date.parse(story.publishedAt) <=
          Date.parse(`${report.reportDate}T01:00:00.000Z`),
      );
      assert.ok(story.regions.length > 0);
      assert.ok(
        story.regions.every((region) => region === "CN" || region === "US"),
      );
      assert.ok(story.importance >= 1 && story.importance <= 5);
      assert.ok(story.ai.interpretation.length > 5);
      assert.ok(["positive", "negative", "mixed", "neutral"].includes(story.ai.tone));
      assert.ok(Array.isArray(story.ai.sectors));
      assert.ok(Array.isArray(story.ai.tickers));
    }
  }
});

test("weekly migration stores one compact report per week", async () => {
  const migration = await readFile(
    new URL("../migrations/0004_weekly_reports.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS weekly_reports/);
  assert.match(migration, /week_end TEXT PRIMARY KEY/);
  assert.match(migration, /content TEXT NOT NULL CHECK \(json_valid\(content\)\)/);
});

test("compact migration contains every report date and audit table", async () => {
  const migration = await readFile(
    new URL(
      "../migrations/0003_compact_reports_and_ingestion.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const report of reports) {
    assert.match(migration, new RegExp(report.reportDate));
  }
  assert.match(migration, /CREATE TABLE ingestion_runs/);
  assert.match(migration, /content TEXT NOT NULL CHECK \(json_valid\(content\)\)/);
  assert.doesNotMatch(migration, /signal_count/);
  assert.doesNotMatch(migration, /payload TEXT/);
});

test("sector heat migration backfills the complete visible week", async () => {
  const migration = await readFile(
    new URL("../migrations/0006_market_sector_heat.sql", import.meta.url),
    "utf8",
  );
  for (const reportDate of [
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
    "2026-07-25",
    "2026-07-26",
  ]) {
    assert.match(migration, new RegExp(reportDate));
  }
  assert.match(migration, /json_set\(\s*content,\s*'\$\.sectorHeat'/s);
});
