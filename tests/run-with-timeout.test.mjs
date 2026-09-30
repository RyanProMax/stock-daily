import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const runner = new URL("../scripts/run-with-timeout.mjs", import.meta.url);

test("timeout runner preserves successful command output", async () => {
  const result = await execFileAsync(process.execPath, [
    runner.pathname,
    "--timeout-ms",
    "2000",
    "--",
    process.execPath,
    "-e",
    "process.stdout.write('completed')",
  ]);
  assert.equal(result.stdout, "completed");
});

test("timeout runner leaves child command flags opaque after the separator", async () => {
  const result = await execFileAsync(process.execPath, [
    runner.pathname,
    "--timeout-ms",
    "2000",
    "--",
    process.execPath,
    "-e",
    "process.stdout.write(process.argv.slice(1).join('|'))",
    "--",
    "--stdout-path",
    "child-owned-path",
  ]);
  assert.equal(result.stdout, "--stdout-path|child-owned-path");
});

test("timeout runner accepts the two-market scheduler envelope", async () => {
  const result = await execFileAsync(process.execPath, [
    runner.pathname,
    "--timeout-ms",
    "5700000",
    "--idle-timeout-ms",
    "900000",
    "--",
    process.execPath,
    "-e",
    "process.stdout.write('accepted')",
  ]);
  assert.equal(result.stdout, "accepted");
});

test("timeout runner reports a command startup failure as exit 127", async () => {
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        runner.pathname,
        "--timeout-ms",
        "1000",
        "--",
        "/definitely/missing-stock-daily-command",
      ]),
    (error) => error?.code === 127 && /Unable to start command/u.test(error.stderr),
  );
});

test("timeout runner persists stdout incrementally for recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-daily-timeout-events-"));
  const eventsPath = join(directory, "events.jsonl");
  try {
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          runner.pathname,
          "--timeout-ms",
          "2000",
          "--idle-timeout-ms",
          "120",
          "--stdout-path",
          eventsPath,
          "--",
          process.execPath,
          "-e",
          "process.stdout.write('persisted-event\\n'); setInterval(()=>{},1000)",
        ]),
      (error) => error?.code === 124,
    );
    assert.equal(await readFile(eventsPath, "utf8"), "persisted-event\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeout runner terminates the whole spawned process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-daily-timeout-"));
  const marker = join(directory, "grandchild-finished");
  const childScript = [
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath,['-e',${JSON.stringify(
      `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),700)`,
    )}],{stdio:'inherit'});`,
    "setInterval(()=>{},1000);",
  ].join("");
  try {
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          runner.pathname,
          "--timeout-ms",
          "100",
          "--",
          process.execPath,
          "-e",
          childScript,
        ]),
      (error) => error?.code === 124 && /terminating process group/u.test(error.stderr),
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(() => readFile(marker), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeout runner terminates a command that stops producing output", async () => {
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        runner.pathname,
        "--timeout-ms",
        "2000",
        "--idle-timeout-ms",
        "100",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('started'); setInterval(()=>{},1000)",
      ]),
    (error) =>
      error?.code === 124 &&
      /produced no output for 100 ms/u.test(error.stderr),
  );
});

test("timeout runner treats stderr progress as activity", async () => {
  const result = await execFileAsync(process.execPath, [
    runner.pathname,
    "--timeout-ms",
    "1000",
    "--idle-timeout-ms",
    "120",
    "--",
    process.execPath,
    "-e",
    "let n=0; const timer=setInterval(()=>{process.stderr.write('progress\\n'); if(++n===3){clearInterval(timer); process.stdout.write('done')}},70)",
  ]);
  assert.equal(result.stdout, "done");
  assert.match(result.stderr, /progress/u);
});
