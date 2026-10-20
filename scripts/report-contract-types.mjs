import { readFile, writeFile } from "node:fs/promises";

// The JSON Schemas are authoritative. This emits only TypeScript declarations;
// all runtime validation is performed by the Workers-compatible schema library.
const root = new URL("../docs/report-contracts/", import.meta.url);
const common = JSON.parse(await readFile(new URL("common-v1.schema.json", root)));
const schemas = await Promise.all(["daily", "weekly"].map(async (kind) =>
  JSON.parse(await readFile(new URL(`${kind}-v1.schema.json`, root))),
));
const name = (key) => `Report${key[0].toUpperCase()}${key.slice(1)}`;
function type(schema) {
  if (schema.$ref) return name(schema.$ref.split("/").at(-1));
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(type).join(" | ");
  if (schema.type === "array") return `Array<${type(schema.items)}>`;
  if (schema.type === "object") {
    return `{\n${Object.entries(schema.properties).map(([key, value]) =>
      `  ${JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${type(value)};`,
    ).join("\n")}\n}`;
  }
  if (["number", "integer"].includes(schema.type)) return "number";
  if (["string", "boolean"].includes(schema.type)) return schema.type;
  throw new Error("Unsupported schema type in declaration generation");
}
const output = "// Generated from docs/report-contracts/*.schema.json. Do not edit.\n"
  + Object.entries(common.$defs).map(([key, value]) => `type ${name(key)} = ${type(value)};\n`).join("\n")
  + schemas.map((schema, index) => `\nexport type ${index ? "Weekly" : "Daily"}ReportPayload = ${type(schema)};\n`).join("");
const target = new URL("../src/report-contracts.generated.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== output) throw new Error("Run npm run contracts:generate");
} else {
  await writeFile(target, output);
}
