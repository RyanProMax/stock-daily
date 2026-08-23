import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const defaultPython = resolve(
  homedir(),
  "projects/stock-kol-intel/.venv/bin/python",
);
export const X_COLLECTOR_TIMEOUT_MS = 110_000;

function safeReason(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

export async function collectXIntelligence(referenceTime) {
  const python = process.env.STOCK_DAILY_X_PYTHON || defaultPython;
  try {
    await access(python, fsConstants.X_OK);
    const result = await execFileAsync(
      python,
      [
        resolve(scriptsDir, "x-intelligence.py"),
        "--config",
        resolve(scriptsDir, "../data/ai-x-sources.json"),
        "--reference-time",
        new Date(referenceTime).toISOString(),
        "--hours",
        "72",
      ],
      {
        timeout: X_COLLECTOR_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          TWS_HTTP_BACKEND: process.env.TWS_HTTP_BACKEND || "curl",
        },
      },
    );
    const payload = JSON.parse(result.stdout);
    return {
      candidates: Array.isArray(payload.items) ? payload.items : [],
      diagnostics: {
        status:
          typeof payload.status === "string" && payload.status
            ? payload.status
            : "search_error",
        sourceCount: Number(payload.sourceCount ?? 0),
        candidateCount: Number(payload.candidateCount ?? 0),
        ...(payload.recoveredFromCooldown === true
          ? { recoveredFromCooldown: true }
          : {}),
        ...(payload.reason ? { reason: String(payload.reason).slice(0, 200) } : {}),
      },
    };
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    return {
      candidates: [],
      diagnostics: {
        status:
          code === "ENOENT" || code === "EACCES"
            ? "dependency_missing"
            : "search_error",
        reason: safeReason(error),
      },
    };
  }
}
