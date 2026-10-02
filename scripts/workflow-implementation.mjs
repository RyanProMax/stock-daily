import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW_IMPLEMENTATION_VERSION = "workflow-source-fingerprint-v1";
export const WORKFLOW_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = value => createHash("sha256").update(value).digest("hex");

export async function workflowImplementationSnapshot(root = WORKFLOW_PROJECT_ROOT) {
  const paths = ["AGENTS.md", "package.json", "pnpm-lock.yaml"];
  const walk = async relative => {
    for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("工作流源码不得通过符号链接变更来源");
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:mjs|sh|py|json|md)$/u.test(entry.name)) paths.push(path);
    }
  };
  await Promise.all(["scripts", "data", "docs/daily-agents"].map(walk));
  const files = Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, digest(await readFile(resolve(root, path)))])));
  return { version: WORKFLOW_IMPLEMENTATION_VERSION, hash: digest(JSON.stringify(files)), files };
}

export async function assertWorkflowImplementation(snapshot, root = WORKFLOW_PROJECT_ROOT) {
  const current = await workflowImplementationSnapshot(root);
  if (!snapshot || snapshot.version !== WORKFLOW_IMPLEMENTATION_VERSION || snapshot.hash !== current.hash || digest(JSON.stringify(snapshot.files)) !== current.hash) throw new Error("工作流源码在运行后发生变更，必须使用完整的新版本重新研究和审核");
  return current;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, path, ...extra] = process.argv.slice(2);
  if (!["--snapshot", "--check"].includes(operation) || !path || extra.length) throw new Error("Use --snapshot PATH or --check PATH");
  const snapshot = operation === "--snapshot" ? await workflowImplementationSnapshot() : await assertWorkflowImplementation(JSON.parse(await readFile(path, "utf8")));
  if (operation === "--snapshot") await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ hash: snapshot.hash, fileCount: Object.keys(snapshot.files).length }));
}
