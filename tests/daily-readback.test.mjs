import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  dailySnapshotIsCurrent,
  fetchFreshDailySnapshot,
} from "../scripts/daily-readback.mjs";

const input = {
  reportDate: "2026-08-25",
  updateKind: "close",
  collectedAt: "2026-08-25T08:00:01.000Z",
};

function snapshot({
  updateKind = "close",
  generatedAt = "2026-08-25T08:01:00.000Z",
  finishedAt = generatedAt,
} = {}) {
  return {
    health: {
      latestIngestion: {
        reportDate: "2026-08-25",
        status: "completed",
        finishedAt,
      },
    },
    report: {
      reportDate: "2026-08-25",
      updateKind,
      generatedAt,
    },
  };
}

test("production readback rejects a stale edition and accepts the current run", async () => {
  const stale = snapshot({
    updateKind: "morning",
    generatedAt: "2026-08-25T01:04:00.000Z",
  });
  const current = snapshot();
  assert.equal(dailySnapshotIsCurrent(input, stale), false);
  assert.equal(dailySnapshotIsCurrent(input, current), true);

  let calls = 0;
  const waits = [];
  const result = await fetchFreshDailySnapshot(input, {
    retryDelaysMs: [0, 5, 10],
    wait: async (milliseconds) => waits.push(milliseconds),
    snapshotLoader: async () => {
      calls += 1;
      return calls === 1 ? stale : current;
    },
  });
  assert.equal(result.report.updateKind, "close");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5]);
});

test("production readback stops after the bounded stale-snapshot window", async () => {
  let calls = 0;
  await assert.rejects(
    fetchFreshDailySnapshot(input, {
      retryDelaysMs: [0, 1, 1],
      wait: async () => {},
      snapshotLoader: async () => {
        calls += 1;
        return snapshot({
          updateKind: "morning",
          generatedAt: "2026-08-25T01:04:00.000Z",
        });
      },
    }),
    /生产日报在重试窗口内未更新/,
  );
  assert.equal(calls, 3);
});

test("the exact-report API disables intermediary caching", async () => {
  const worker = await readFile(
    new URL("../src/worker.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    worker,
    /app\.get\("\/api\/reports\/:date"[\s\S]*?c\.header\("Cache-Control", "no-store"\)/,
  );
});
