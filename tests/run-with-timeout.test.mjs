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
