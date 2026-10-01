import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, OPS, version } from "pdfjs-dist/legacy/build/pdf.mjs";
import { verifiedPdfListMarker, verifiedPdfFormMarker, verifiedPdfFontHintWarning } from "./pdf-source-glyphs.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const imageOperators = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask]);
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > MAX_BYTES) throw new Error("PDF byte limit exceeded");
  chunks.push(chunk);
}
const data = Buffer.concat(chunks);
if (!data.subarray(0, 5).equals(Buffer.from("%PDF-")) || !/%%EOF\s*$/u.test(data.subarray(-1024).toString("latin1"))) throw new Error("Incomplete PDF signature or end marker");
const tail = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(data.subarray(-1024).toString("latin1"));
const offset = tail ? Number(tail[1]) : -1;
const xref = Number.isSafeInteger(offset) && offset >= 5 && offset < data.length ? data.subarray(offset, offset + 512).toString("latin1") : "";
if (!/^(?:xref\s|\d+\s+\d+\s+obj\b[\s\S]*\/Type\s*\/XRef\b)/u.test(xref)) throw new Error("Invalid PDF cross-reference offset");
const warnings = [];
console.log = (...values) => { if (values.some(value => /^(?:Warning|Error):/u.test(String(value)))) warnings.push(values.join(" ")); };
console.warn = console.error = (...values) => { warnings.push(values.join(" ")); };
const root = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const task = getDocument({ data: new Uint8Array(data), stopAtErrors: true, isEvalSupported: false, enableXfa: false, useWorkerFetch: false, useWasm: false, disableFontFace: true, cMapUrl: resolve(root, "cmaps") + "/", cMapPacked: true, standardFontDataUrl: resolve(root, "standard_fonts") + "/" });
try {
  const document = await task.promise;
  if (document.numPages < 1 || document.numPages > 512 || document.isPureXfa) throw new Error("Unsupported PDF page count or dynamic form");
  const pages = [];
  let textLength = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const operators = await page.getOperatorList();
    const rasterOperationCount = operators.fnArray.filter(operator => imageOperators.has(operator)).length;
    const content = await page.getTextContent({ disableNormalization: true });
    const items = content.items.filter(item => typeof item.str === "string");
    const listMarkers = [];
    let line = "";
    for (const [index, item] of items.entries()) {
      if (/[\uE000-\uF8FF]/u.test(item.str)) {
        const font = page.commonObjs.get(item.fontName);
        const following = [];
        for (const next of items.slice(index + 1)) {
          following.push(next.str);
          if (next.hasEOL) break;
        }
        const list = verifiedPdfListMarker(item, font, line, following.join("")), form = verifiedPdfFormMarker(item, font, line, following.join(""));
        if (!list && !form) throw new Error(`Page ${number} has an unverifiable private-use character`);
        listMarkers.push({ itemIndex: index, originalCharacter: item.str, fontName: font.name, kind: list ? "list" : "form_choice" });
      }
      line = item.hasEOL ? "" : line + item.str;
    }
    const text = items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join("").normalize("NFC").replace(/[\t\f\v ]+/gu, " ").replace(/\s*\n\s*/gu, "\n").trim();
    if (!text || /[\u0000\uFFFD]/u.test(text)) throw new Error(`Page ${number} has no verifiable complete text layer`);
    textLength += text.length;
    if (textLength > MAX_TEXT) throw new Error("PDF text limit exceeded");
    pages.push({ number, text, textItemCount: items.length, rasterOperationCount, ...(listMarkers.length ? { listMarkers } : {}) });
    page.cleanup();
  }
  if (warnings.some(warning => !verifiedPdfFontHintWarning(warning)) || warnings.length > 256) throw new Error("PDF parsing reported a warning or recovery outside verified font hints");
  process.stdout.write(JSON.stringify({ version: `pdfjs-${version}-text-v4`, pageCount: document.numPages, pages, fontHintWarnings: warnings, text: pages.map(page => page.text).join("\n\n") }));
} finally { await task.destroy(); }
