export function fixturePdf(pages, imagePages = []) {
  const unicode = text => [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>", "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /FontDescriptor 6 0 R /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>"];
  const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const chars = [...new Set(pages.flat().join(""))];
  const cmap = [];
  for (let i = 0; i < chars.length; i += 100) { const group = chars.slice(i, i + 100); cmap.push(`${group.length} beginbfchar\n` + group.map(char => `<${unicode(char)}> <${unicode(char)}>`).join("\n") + "\nendbfchar"); }
  objects.push(stream("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" + cmap.join("\n") + "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end"));
  objects.push("<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>");
  const kids = [];
  for (const [index, page] of pages.entries()) {
    const imageId = imagePages.includes(index) ? objects.length + 1 : null;
    if (imageId) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\n00>\nendstream");
    const id = objects.length + 1; kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${imageId ? `/XObject << /Im0 ${imageId} 0 R >>` : ""} >> /Contents ${id + 1} 0 R >>`);
    objects.push(stream("BT /F1 10 Tf 40 760 Td\n" + page.map(text => `<${unicode(text)}> Tj 0 -18 Td`).join("\n") + "\nET" + (imageId ? "\nq 100 0 0 100 100 100 cm /Im0 Do Q" : "")));
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  let body = "%PDF-1.7\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(body + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
