import { spawn } from "node:child_process";

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/run-with-timeout.mjs --timeout-ms <milliseconds> [--idle-timeout-ms <milliseconds>] -- <command> [args...]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const timeoutIndex = args.indexOf("--timeout-ms");
const idleTimeoutIndex = args.indexOf("--idle-timeout-ms");
if (
  separator < 0 ||
  timeoutIndex < 0 ||
  timeoutIndex + 1 >= separator ||
  separator + 1 >= args.length
) {
  usage();
}

const timeoutMs = Number(args[timeoutIndex + 1]);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
  usage("--timeout-ms must be an integer between 1 and 3600000");
}
const idleTimeoutMs =
  idleTimeoutIndex >= 0 ? Number(args[idleTimeoutIndex + 1]) : null;
if (
  idleTimeoutIndex >= separator ||
  (idleTimeoutMs !== null &&
    (!Number.isInteger(idleTimeoutMs) ||
      idleTimeoutMs < 1 ||
      idleTimeoutMs > timeoutMs))
) {
  usage("--idle-timeout-ms must be an integer between 1 and --timeout-ms");
}

const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const useProcessGroup = process.platform !== "win32";
const child = spawn(command, commandArgs, {
  detached: useProcessGroup,
  stdio: ["inherit", "pipe", "inherit"],
});

child.stdout.pipe(process.stdout);

let timedOut = false;
let forwardedSignal = null;
let forceTimer;
let timeoutTimer;
let idleTimer;

function signalChildTree(signal) {
  if (!child.pid) return;
  try {
    process.kill(useProcessGroup ? -child.pid : child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function clearLimitTimers() {
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (idleTimer) clearTimeout(idleTimer);
}

function terminate(signal, timeoutKind = null) {
  if (timedOut || forwardedSignal) return;
  clearLimitTimers();
  if (timeoutKind) {
    timedOut = true;
    console.error(
      timeoutKind === "idle"
        ? `Command produced no output for ${idleTimeoutMs} ms; terminating process group: ${command}`
        : `Command exceeded ${timeoutMs} ms; terminating process group: ${command}`,
    );
  } else {
    forwardedSignal = signal;
  }
  signalChildTree("SIGTERM");
  forceTimer = setTimeout(() => signalChildTree("SIGKILL"), 5_000);
  forceTimer.unref();
}

function resetIdleTimer() {
  if (idleTimeoutMs === null || timedOut || forwardedSignal) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => terminate("SIGTERM", "idle"),
    idleTimeoutMs,
  );
}

child.stdout.on("data", resetIdleTimer);
timeoutTimer = setTimeout(() => terminate("SIGTERM", "hard"), timeoutMs);
resetIdleTimer();
for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
  process.once(signal, () => terminate(signal));
}

child.once("error", (error) => {
  clearLimitTimers();
  if (forceTimer) clearTimeout(forceTimer);
  console.error(`Unable to start command: ${error.message}`);
  process.exitCode = 127;
});

child.once("close", (code, signal) => {
  clearLimitTimers();
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) {
    process.exitCode = 124;
    return;
  }
  if (forwardedSignal || signal) {
    process.exitCode = 128;
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 1;
});
