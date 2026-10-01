import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PDF_SOURCE_VERSION = "verified-pdf-original-v1";
const cache = new Map();
const extractor = fileURLToPath(new URL("./pdf-source-extract.mjs", import.meta.url));

export function pdfSourceRecord(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!bytes.length || bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("PDF 原文长度或文件标识无效");
  const bodyHash = createHash("sha256").update(bytes).digest("hex");
  if (cache.has(bodyHash)) return structuredClone(cache.get(bodyHash));
  let parsed;
  try {
    const output = execFileSync(process.execPath, ["--max-old-space-size=256", extractor], { input: bytes, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    // A parser warning/recovery also makes stdout non-JSON. Do not silently
    // accept repaired, truncated or unreadable originals as a complete read.
    parsed = JSON.parse(output);
  } catch { throw new Error("PDF 原文无法完整、可重复地提取；缺页、加密、扫描或解析恢复均不能充当已核验正文"); }
  if (parsed.version !== "pdfjs-5.6.205-text-v1" || !Number.isInteger(parsed.pageCount) || parsed.pageCount < 1 || parsed.pageCount > 512 || !Array.isArray(parsed.pages) || parsed.pages.length !== parsed.pageCount || typeof parsed.text !== "string" || parsed.text.length < 80 || parsed.text.length > 1_001_024 || parsed.pages.some((page, index) => page.number !== index + 1 || typeof page.text !== "string" || !page.text || !Number.isInteger(page.textItemCount) || page.textItemCount < 1) || parsed.text !== parsed.pages.map(page => page.text).join("\n\n")) throw new Error("PDF 原文的逐页提取记录无效");
  const record = { version: PDF_SOURCE_VERSION, bodyHash, extractorVersion: parsed.version, pageCount: parsed.pageCount, pages: parsed.pages, text: parsed.text };
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(bodyHash, record);
  return structuredClone(record);
}
