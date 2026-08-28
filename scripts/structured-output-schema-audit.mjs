import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function auditStructuredOutputSchema(schema, label = "schema") {
  const issues = [];
  function visit(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.properties && typeof value.properties === "object") {
      const propertyNames = Object.keys(value.properties);
      const required = Array.isArray(value.required) ? value.required : [];
      const missing = propertyNames.filter((name) => !required.includes(name));
      if (missing.length > 0) {
        issues.push(`${path} required 缺少 ${missing.join(", ")}`);
      }
      if (value.additionalProperties !== false) {
        issues.push(`${path} 必须设置 additionalProperties=false`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}.${key}`);
    }
  }
  visit(schema, label);
  if (issues.length > 0) {
    throw new Error(`结构化输出 Schema 不兼容：${issues.join("; ")}`);
  }
  return { status: "valid", label };
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error("至少提供一个 Schema 文件");
  }
  const results = [];
  for (const path of paths) {
    const absolutePath = resolve(path);
    const schema = JSON.parse(await readFile(absolutePath, "utf8"));
    results.push(auditStructuredOutputSchema(schema, absolutePath));
  }
  console.log(JSON.stringify({ status: "valid", schemas: results }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
