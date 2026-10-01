import { pdfSourceRecord } from "./pdf-source.mjs";

const key = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, "");

function periodicPdfIdentity(pages) {
  const lines = pages[0].text.split("\n");
  // A quarterly first page can continue into a glossary after its board
  // declaration. Those table rows are not additional cover issuers.
  const declarationIndex = lines.findIndex(line => /董事会.*保证/u.test(key(line)));
  const coverLines = declarationIndex < 0 ? lines : lines.slice(0, declarationIndex);
  const companies = [...new Set(coverLines.map(key).filter(line => /^[^：:]{3,70}(?:股份)?有限公司$/u.test(line)))];
  const titles = [...new Set(lines.map(key).filter(line => /^20\d{2}年(?:年度|半年度|第?一季度|第?三季度)报告(?:\((?:更新|修订|更正)(?:版|稿|后)?\))?$/u.test(line)))];
  if (companies.length !== 1 || titles.length !== 1 || !pages.slice(0, 3).some(page => /董事会[^。]{0,160}保证[^。]{0,160}真实[^。]{0,80}准确[^。]{0,80}完整/u.test(key(page.text)))) return null;
  const issuerName = companies[0], pairs = [];
  const header = pages[0].text.slice(0, 512);
  const codes = [...header.matchAll(/(?:证券|股票|公司)代码\s*[:：]\s*(\d{6})(?!\d)/gu)];
  const names = [...header.matchAll(/(?:证券|股票|公司)简称\s*[:：]\s*([^\n：:]{2,80})/gu)].map(match => key(match[1].replace(/\s*(?:公告编号|(?:证券|股票|公司)代码).*$/u, "")));
  if (codes.length === 1 && names.length === 1 && names[0].length <= 20) pairs.push({ code: codes[0][1], name: names[0] });
  // Shenzhen covers commonly omit the code. Their own company-profile table
  // supplies it on a later front page; the adjacent legal name must be exactly
  // the sole name printed on the cover, not a client/counterparty mention.
  for (const page of pages.slice(0, 8)) {
    const text = key(page.text);
    if (!/公司简介/u.test(text) || !/公司(?:的)?中文名称/u.test(text)) continue;
    if (!text.includes("公司中文名称" + issuerName) && !text.includes("公司的中文名称" + issuerName)) return null;
    for (const match of text.matchAll(/股票简称([^：:<>]{2,20}?)股票代码(\d{6})(?!\d)/gu)) pairs.push({ name: match[1], code: match[2] });
  }
  const unique = [...new Map(pairs.map(pair => [`${pair.code}:${pair.name}`, pair])).values()];
  if (unique.length !== 1) return null;
  return { ...unique[0], issuerName, title: titles[0] };
}

export function cninfoPdfIdentity(body, source) {
  let url;
  try { url = new URL(source); } catch { return null; }
  const match = /^\/finalpage\/(20\d{2}-\d{2}-\d{2})\/(\d{10})\.PDF$/u.exec(url.pathname);
  if (url.origin !== "https://static.cninfo.com.cn" || url.username || url.password || url.search || url.hash || !match) return null;
  const pages = pdfSourceRecord(body).pages, firstPage = pages[0].text;
  const periodic = periodicPdfIdentity(pages);
  if (periodic) {
    const flag = /^(?:000|001|002|003|300|301)/u.test(periodic.code) ? "true" : /^(?:600|601|603|605|688|689)/u.test(periodic.code) ? "false" : null;
    if (!flag) return null;
    return { ...periodic, datePath: match[1], announcementId: match[2], symbol: `${periodic.code}.${flag === "true" ? "SZ" : "SS"}`, recordUrl: `https://www.cninfo.com.cn/new/announcement/bulletin_detail?announceId=${match[2]}&flag=${flag}&announceTime=${match[1]}` };
  }
  if (firstPage.split("\n").some(line => /^20\d{2}年(?:年度|半年度|第?一季度|第?三季度)报告(?:\((?:更新|修订|更正)(?:版|稿|后)?\))?$/u.test(key(line)))) return null;
  const header = firstPage.slice(0, 256);
  const codes = [...header.matchAll(/(?:证券|股票)代码\s*[:：]\s*(\d{6})(?!\d)/gu)];
  const names = [...header.matchAll(/(?:证券|股票)简称\s*[:：]\s*([^\s：:]{2,20})/gu)];
  if (codes.length !== 1 || names.length !== 1) return null;
  const code = codes[0][1], flag = /^(?:000|001|002|003|300|301)/u.test(code) ? "true" : /^(?:600|601|603|605|688|689)/u.test(code) ? "false" : null;
  const lines = firstPage.split("\n"), issuerIndex = lines.findIndex(line => /^[^：:]{3,70}(?:股份)?有限公司$/u.test(line));
  if (!flag || issuerIndex < 0 || issuerIndex > 3) return null;
  const declaration = lines.findIndex((line, index) => index > issuerIndex && line.startsWith("本公司董事会"));
  if (declaration < 0 || declaration > issuerIndex + 8) return null;
  const title = lines.slice(issuerIndex + 1, declaration).join("").trim();
  if (title.length < 8 || title.length > 220) return null;
  return { datePath: match[1], announcementId: match[2], code, name: names[0][1], issuerName: lines[issuerIndex], title, symbol: `${code}.${flag === "true" ? "SZ" : "SS"}`, recordUrl: `https://www.cninfo.com.cn/new/announcement/bulletin_detail?announceId=${match[2]}&flag=${flag}&announceTime=${match[1]}` };
}

export function cninfoPdfPublication(body, receipt, source) {
  const identity = cninfoPdfIdentity(body, source);
  if (!identity || receipt?.finalUrl !== identity.recordUrl || receipt.requestMethod !== "POST" || receipt.status !== 200 || !/^application\/json(?:;|$)/iu.test(receipt.contentType ?? "") || !Buffer.isBuffer(receipt.rawBody) || receipt.rawBody.length > 1024 * 1024) return null;
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receipt.rawBody)); } catch { return null; }
  const a = value?.announcement;
  if (!a || a.announcementId !== identity.announcementId || a.secCode !== identity.code || key(a.secName) !== key(identity.name) || a.adjunctType !== "PDF" || a.adjunctUrl !== `finalpage/${identity.datePath}/${identity.announcementId}.PDF` || typeof a.orgId !== "string" || !/^[A-Za-z0-9]{3,40}$/u.test(a.orgId) || !Number.isSafeInteger(a.announcementTime)) return null;
  let fileUrl;
  try { fileUrl = new URL(value.fileUrl); } catch { return null; }
  if (!["http:", "https:"].includes(fileUrl.protocol) || fileUrl.hostname !== "static.cninfo.com.cn" || fileUrl.pathname !== `/${a.adjunctUrl}` || fileUrl.username || fileUrl.password || fileUrl.port || fileUrl.search || fileUrl.hash) return null;
  const title = String(a.announcementTitle ?? "");
  // Native quarterly records may omit the issuer prefix. The sole PDF issuer,
  // record code/name, announcement ID and exact file path remain mandatory.
  if (![identity.title, ...[identity.name, identity.issuerName].flatMap(name => [name + identity.title, name + "：" + identity.title])].some(expected => key(title) === key(expected))) return null;
  const date = new Date(a.announcementTime);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2199) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map(part => [part.type, part.value]));
  const publishedDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (publishedDate !== identity.datePath) return null;
  // announcementTime may be a calendar sentinel; storageTime is ingestion.
  // Neither supplies a verified public intraday clock for these originals.
  return { issuer: { symbol: identity.symbol, code: identity.code, name: identity.name, issuerName: identity.issuerName }, announcementId: identity.announcementId, title, publishedDateCandidates: [publishedDate], publishedAtCandidates: [], timePrecision: "date", timeBasis: "official_calendar_record" };
}
