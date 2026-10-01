import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AGENT_FILESYSTEM_ISOLATION, stableHash } from "./daily-workflow-core.mjs";

const VERSION = "stock-daily-native-attempt-v1";
function artifacts(agentRunId) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(agentRunId)) throw new Error("Invalid native attempt identity");
  const root = `native-attempts/${agentRunId}`;
  return Object.fromEntries(Object.entries({ invocationArtifact: "invocation.json", promptArtifact: "prompt.txt", schemaArtifact: "output.schema.json", eventStreamArtifact: "events.live.jsonl", eventArtifact: "events.jsonl", stderrArtifact: "stderr.txt", outputArtifact: "output.json", receiptArtifact: "receipt.json" }).map(([key, name]) => [key, `${root}/${name}`]));
}
async function writeOnce(path, text) {
  try { await writeFile(path, text, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST" || await readFile(path, "utf8") !== text) throw error;
  }
}

export function nativeSearchQueries(eventsText) {
  const queries = [];
  for (const line of String(eventsText).split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "item.completed" || event.item?.type !== "web_search" || event.item.action?.type !== "search") continue;
      const action = event.item.action;
      for (const query of Array.isArray(action.queries) ? action.queries : [action.query]) {
        if (typeof query === "string" && query.trim()) queries.push(query.trim());
      }
    } catch { /* A failed stream can end with an incomplete event. */ }
  }
  return queries;
}

export async function beginNativeAgentAttempt(runDir, invocation, { prompt, schemaText }) {
  const refs = artifacts(invocation.agentRunId);
  await mkdir(resolve(runDir, "native-attempts"), { recursive: true, mode: 0o700 });
  await mkdir(resolve(runDir, `native-attempts/${invocation.agentRunId}`), { recursive: false, mode: 0o700 });
  const schemaHash = stableHash(schemaText);
  const promptHash = stableHash({ prompt, schemaHash, filesystemIsolation: AGENT_FILESYSTEM_ISOLATION });
  if (schemaHash !== invocation.schemaHash || promptHash !== invocation.promptHash) throw new Error("Native invocation fingerprint mismatch");
  await Promise.all([
    writeOnce(resolve(runDir, refs.promptArtifact), prompt),
    writeOnce(resolve(runDir, refs.schemaArtifact), schemaText),
    writeOnce(resolve(runDir, refs.eventStreamArtifact), ""),
    writeOnce(resolve(runDir, refs.invocationArtifact), `${JSON.stringify({ version: VERSION, ...invocation, filesystemIsolation: AGENT_FILESYSTEM_ISOLATION }, null, 2)}\n`),
  ]);
  return refs;
}

export async function finishNativeAgentAttempt(runDir, stage, { events, stderr = "", outputText = null, exitCode = null, completedAt, capture = "returned" }) {
  const refs = artifacts(stage.agentRunId);
  try {
    await readFile(resolve(runDir, refs.receiptArtifact));
    return (await auditNativeAgentAttempt(runDir, { ...stage, ...refs })).reference;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const invocationText = await readFile(resolve(runDir, refs.invocationArtifact), "utf8");
  const receipt = { version: VERSION, agentRunId: stage.agentRunId, capture, completedAt, exitCode, invocationHash: stableHash(invocationText), eventHash: stableHash(events), stderrHash: stableHash(stderr), outputHash: outputText === null ? null : stableHash(outputText), queries: nativeSearchQueries(events) };
  await writeOnce(resolve(runDir, refs.eventArtifact), events);
  await writeOnce(resolve(runDir, refs.stderrArtifact), stderr);
  if (outputText !== null) await writeOnce(resolve(runDir, refs.outputArtifact), outputText);
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeOnce(resolve(runDir, refs.receiptArtifact), receiptText);
  return { ...refs, receiptHash: stableHash(receiptText) };
}

export async function auditNativeAgentAttempt(runDir, record) {
  const refs = artifacts(record.agentRunId);
  for (const [key, path] of Object.entries(refs)) if (record[key] && record[key] !== path) throw new Error("Native attempt artifact identity mismatch");
  const [invocationText, prompt, schemaText, receiptText, events, stderr, liveEvents] = await Promise.all([
    refs.invocationArtifact, refs.promptArtifact, refs.schemaArtifact, refs.receiptArtifact, refs.eventArtifact, refs.stderrArtifact, refs.eventStreamArtifact,
  ].map(path => readFile(resolve(runDir, path), "utf8")));
  const invocation = JSON.parse(invocationText), receipt = JSON.parse(receiptText);
  const schemaHash = stableHash(schemaText), promptHash = stableHash({ prompt, schemaHash, filesystemIsolation: AGENT_FILESYSTEM_ISOLATION });
  if (invocation.version !== VERSION || receipt.version !== VERSION || invocation.agentRunId !== record.agentRunId || receipt.agentRunId !== record.agentRunId || invocation.filesystemIsolation !== AGENT_FILESYSTEM_ISOLATION || invocation.schemaHash !== schemaHash || invocation.promptHash !== promptHash || receipt.invocationHash !== stableHash(invocationText)) throw new Error("Native attempt invocation changed");
  for (const key of ["key", "promptHash", "schemaHash"]) if (record[key] && record[key] !== invocation[key]) throw new Error("Native attempt manifest fingerprint mismatch");
  if (record.role && record.role !== invocation.role && !(record.role === "writer" && invocation.role === "repair")) throw new Error("Native attempt role changed");
  if (receipt.eventHash !== stableHash(events) || receipt.stderrHash !== stableHash(stderr) || (record.receiptHash && record.receiptHash !== stableHash(receiptText)) || (record.eventHash && record.eventHash !== receipt.eventHash)) throw new Error("Native attempt event or receipt changed");
  if (liveEvents !== events) throw new Error("Native event stream advanced after capture");
  const queries = nativeSearchQueries(events);
  if (stableHash(queries) !== stableHash(receipt.queries) || (record.searchCount != null && record.searchCount !== queries.length) || (record.queries && stableHash(record.queries) !== stableHash(queries))) throw new Error("Native attempt executed-query accounting changed");
  const outputText = receipt.outputHash === null ? null : await readFile(resolve(runDir, refs.outputArtifact), "utf8");
  if (receipt.outputHash !== (outputText === null ? null : stableHash(outputText)) || (record.outputHash && record.outputHash !== receipt.outputHash)) throw new Error("Native attempt output changed");
  return { reference: { ...refs, receiptHash: stableHash(receiptText) }, receipt, invocation, events, outputText };
}
