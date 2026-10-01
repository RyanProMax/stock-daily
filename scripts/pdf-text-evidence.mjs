import { pdfSourceRecord, PDF_SOURCE_VERSION } from "./pdf-source.mjs";

export const PDF_TEXT_EVIDENCE_VERSION = "verified-pdf-text-excerpt-v1";
const normalized = value => String(value).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}.+%\-]+/gu, "").replaceAll("维权", "");

export function pdfTextExcerptChecker(opened) {
  if (!/^application\/pdf(?:;|$)/iu.test(opened.contentType ?? "")) return () => null;
  if (!Buffer.isBuffer(opened.rawBody)) throw new Error("PDF 引文缺少可重读的原始字节");
  const record = pdfSourceRecord(opened.rawBody);
  if (opened.pdfDocument?.version !== PDF_SOURCE_VERSION || opened.pdfDocument.bodyHash !== record.bodyHash || opened.text !== record.text || JSON.stringify(opened.pdfDocument.pages) !== JSON.stringify(record.pages)) throw new Error("PDF 逐页文字及图片记录未由原始字节重建");
  let offset = 0;
  const formPositions = [];
  const ranges = record.pages.map(page => {
    const text = normalized(page.text), start = offset; offset += text.length;
    for (const match of page.text.matchAll(/\uF052/gu)) formPositions.push(start + normalized(page.text.slice(0, match.index)).length);
    return { page: page.number, start, end: offset, text };
  });
  const body = ranges.map(page => page.text).join("");
  const positions = fragment => {
    const found = [];
    for (let cursor = 0; cursor < body.length;) {
      const start = body.indexOf(fragment, cursor);
      if (start < 0) break;
      found.push({ start, end: start + fragment.length });
      if (found.length > 128) throw new Error("PDF 支持摘录出现次数超过可核验定位边界");
      cursor = start + 1;
    }
    if (!found.length) throw new Error("PDF 支持摘录未在原始文字位置定位");
    return found;
  };
  return excerpt => {
    const whole = normalized(excerpt);
    if (whole.length < 20) throw new Error("PDF 支持摘录过短");
    let span;
    if (body.includes(whole)) { const matches = positions(whole); span = { start: matches[0].start, end: matches.at(-1).end }; }
    else {
      const fragments = String(excerpt).split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/u).map(value => normalized(value).replace(/[.]+$/u, "")).filter(Boolean);
      if (fragments.length < 2) throw new Error("PDF 支持摘录无法在逐页原文定位");
      const matches = fragments.map(positions);
      let cursor = 0;
      for (const possibilities of matches) {
        const next = possibilities.find(item => item.start >= cursor);
        if (!next) throw new Error("PDF 引文片段顺序与原始页次不一致");
        cursor = next.end;
      }
      // Repeated native headings/tables are legitimate, but cannot let a
      // caller select the convenient clean occurrence. Cover every matching
      // position and every intervening page, including unused possibilities.
      span = { start: Math.min(...matches.flat().map(item => item.start)), end: Math.max(...matches.flat().map(item => item.end)) };
    }
    if (formPositions.some(position => position >= span.start && position < span.end)) throw new Error("PDF 引文涉及原始勾选状态，不能把保留的字体符号解释或改写为已核验事实");
    const pages = ranges.filter(page => page.end > span.start && page.start < span.end).map(page => page.page);
    const first = Math.max(1, pages[0] - 1), last = Math.min(record.pageCount, pages.at(-1) + 1);
    const contextPages = record.pages.filter(page => page.number >= first && page.number <= last);
    if (contextPages.some(page => page.rasterOperationCount > 0)) throw new Error("PDF 引文或相邻限定内容包含尚未核验的图片，不能仅凭文字层放行");
    return { version: PDF_TEXT_EVIDENCE_VERSION, documentHash: record.bodyHash, pages, contextPages: contextPages.map(page => page.number), unverifiedVisualPages: [...record.unverifiedVisualPages], limitation: "Verified native text passages and adjacent pages only; embedded graphics are not evidence." };
  };
}

export function verifiedPdfTextExcerpt(source, opened) {
  return pdfTextExcerptChecker(opened)(source.supportingExcerpt);
}
