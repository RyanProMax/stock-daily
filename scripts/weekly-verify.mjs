import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = JSON.parse(
  await readFile(resolve(process.argv[2] ?? "work/weekly-input.json"), "utf8"),
);
const response = await fetch(
  `https://stock-daily-4ip.pages.dev/api/weekly/${input.weekEnd}`,
  { signal: AbortSignal.timeout(20_000) },
);
if (!response.ok) {
  throw new Error(`线上周报回读失败：${response.status}`);
}
const report = (await response.json()).data;
if (
  report?.weekStart !== input.weekStart ||
  report?.weekEnd !== input.weekEnd ||
  report?.agentModel !== "openai/codex-weekly" ||
  !Array.isArray(report?.highlights) ||
  !report?.outlook?.base
) {
  throw new Error("线上周报与本次输入不一致");
}
console.log(
  JSON.stringify(
    {
      status: "verified",
      weekStart: report.weekStart,
      weekEnd: report.weekEnd,
      highlightCount: report.highlights.length,
      eventCount: report.events.length,
    },
    null,
    2,
  ),
);
