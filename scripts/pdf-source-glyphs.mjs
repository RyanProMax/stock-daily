// Preserve the original character; never translate an unknown symbol into a
// word, number or economic qualification. The inspected CNINFO format uses an
// embedded Wingdings glyph as an isolated marker at the start of a list line.
export function verifiedPdfListMarker(item, font, before, after) {
  return item.str === "\uF06C" && font?.missingFile === false && font.isType3Font === false &&
    /^(?:[A-Z]{6}\+)?Wingdings(?:-Regular)?$/u.test(font.name ?? "") &&
    before.trim() === "" && /^[\s]*[\p{L}\p{N}]/u.test(after) && !/[\uE000-\uF8FF]/u.test(after);
}
