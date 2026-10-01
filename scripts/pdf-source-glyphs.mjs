// Preserve the original character; never translate an unknown symbol into a
// word, number or economic qualification. The inspected CNINFO format uses an
// embedded Wingdings glyph as an isolated marker at the start of a list line.
export function verifiedPdfListMarker(item, font, before, after) {
  return font?.missingFile === false && font.isType3Font === false &&
    ((item.str === "\uF06C" && /^(?:[A-Z]{6}\+)?Wingdings(?:-Regular)?$/u.test(font.name ?? "")) ||
     (item.str === "\uF0B7" && /^(?:[A-Z]{6}\+)?SymbolMT$/u.test(font.name ?? ""))) &&
    before.trim() === "" && /^[\s]*[\p{L}\p{N}]/u.test(after) && !/[\uE000-\uF8FF]/u.test(after);
}

// The native annual/quarterly forms use this embedded Wingdings 2 character
// for the selected member of a printed two-choice field. Preserve the original
// symbol, including the other printed choice; never turn it into a word/value.
export function verifiedPdfFormMarker(item, font, before, after) {
  if (!["\uF052", "\uF0A3"].includes(item.str) || font?.missingFile !== false || font.isType3Font !== false || !/^(?:[A-Z]{6}\+)?Wingdings ?2(?:-Regular)?$/u.test(font.name ?? "")) return false;
  const left = before.replace(/\s+/gu, ""), right = after.replace(/\s+/gu, "");
  const pairs = [["适用", "不适用"], ["不适用", "适用"], ["是", "否"], ["否", "是"]];
  if (item.str === "\uF0A3") return pairs.some(([unselected, selected]) => left === "" && right === unselected + "\uF052" + selected);
  return pairs.some(([selected, other]) => (left === "" && right === selected + "□" + other) || (["□", "\uF0A3"].some(marker => left === marker + other) && right === selected));
}

// These inspected diagnostics concern TrueType grid-fitting instructions or
// optional .notdef duplication, never character-map or PDF-index recovery.
// Keep them in the read record; every other parser warning remains a refusal.
export function verifiedPdfFontHintWarning(value) {
  // PDF.js skips optional .notdef duplication when the native TrueType glyph
  // count already occupies all 65,535 entries; no text mapping is repaired.
  if (value === "Warning: Not enough space in glyfs to duplicate first glyph.") return true;
  const match = /^Warning: TT: undefined function: (\d{1,5})$/u.exec(value);
  return Boolean(match && Number(match[1]) <= 65535);
}
