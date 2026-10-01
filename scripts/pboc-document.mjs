import { JSDOM } from "jsdom";

export const PBOC_DOCUMENT_VERSION = "verified-pboc-news-document-v1";
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const key = value => clean(value).replace(/\s+/gu, "");

export function pbocDocumentIdentity(source) {
  let url; try { url = new URL(source); } catch { return null; }
  const match = /^\/goutongjiaoliu\/113456\/113469\/((20\d{2})(\d{2})(\d{2})\d{11})\/index\.html$/u.exec(url.pathname);
  if (url.origin !== "https://www.pbc.gov.cn" || url.username || url.password || url.search || url.hash || !match) return null;
  const date = `${match[2]}-${match[3]}-${match[4]}`, calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return null;
  // The numeric CMS path identifies an article/date, never its publication hour.
  return { publicationDate: date, documentId: match[1], pathname: url.pathname };
}

// This reviewed PBOC news format prints a Beijing publication clock beside
// its own byline. createDate is a separate CMS creation field, not that clock.
export function pbocDocumentRecord(html, source) {
  const identity = pbocDocumentIdentity(source);
  if (!identity) return null;
  const document = new JSDOM(html).window.document;
  const meta = name => {
    const nodes = [...document.head.querySelectorAll(`meta[name="${name}"]`)];
    return nodes.length === 1 ? nodes[0].content : null;
  };
  if (meta("SiteName") !== "沟通交流" || meta("SiteIDCode") !== "goutongjiaoliu" || meta("ColumnName") !== "新闻" || meta("ColumnType") !== "工作动态" || meta("Url") !== identity.pathname || meta("PubDate") !== identity.publicationDate || !["", "沟通交流"].includes(meta("ContentSource"))) return null;
  const bodies = [...document.querySelectorAll("td.content > #zoom.zoom1")], bylines = [...document.querySelectorAll("#laiyuan")];
  if (bodies.length !== 1 || document.querySelectorAll("#zoom").length !== 1 || bylines.length !== 1 || !["", "沟通交流"].includes(clean(bylines[0].textContent))) return null;
  if (clean(bylines[0].textContent) !== meta("ContentSource")) return null;
  const body = bodies[0], bodyTable = body.closest("table"), owner = bodyTable?.parentElement;
  const bylineTable = bylines[0].closest("table"), row = bylines[0].closest("tr"), cell = bylines[0].closest("td");
  if (!owner || owner.tagName !== "TD" || bylineTable?.parentElement !== owner || cell?.parentElement !== row || clean(cell.textContent) !== `文章来源：${clean(bylines[0].textContent)}`) return null;
  const headers = [...owner.querySelectorAll("h2")].filter(node => clean(node.textContent) && !body.contains(node)), titles = [...document.head.querySelectorAll("title")];
  const title = clean(headers[0]?.textContent);
  if (headers.length !== 1 || titles.length !== 1 || title.length < 8 || title.length > 220 || key(title) !== key(meta("ArticleTitle")) || key(title) !== key(titles[0].textContent)) return null;
  const headerTable = headers[0].closest("table")?.parentElement?.closest("table"), children = [...owner.children];
  if (headerTable?.parentElement !== owner || children.indexOf(headerTable) >= children.indexOf(bylineTable) || children.indexOf(bylineTable) >= children.indexOf(bodyTable)) return null;
  const clockCell = cell.nextElementSibling;
  if (!clockCell || clockCell.tagName !== "TD" || clockCell.getAttribute("align") !== "right" || clockCell.nextElementSibling) return null;
  const clock = clean(clockCell.textContent);
  if (!/^20\d{2}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(clock) || clock.slice(0, 10) !== identity.publicationDate) return null;
  if ([...document.querySelectorAll("meta")].some(node => /^(?:dateModified|article:modified_time|bytedance:updated_time|updateTime|lastModified)$/iu.test(node.name || node.getAttribute("property") || "")) || /更新时间|修改时间|修订时间/u.test(clean(bylineTable.textContent))) return null;
  if ([...document.head.querySelectorAll('link[rel="canonical"],meta[property="og:url"]')].some(node => (node.getAttribute("href") ?? node.getAttribute("content")) !== source)) return null;
  const page = document.body.cloneNode(true);
  page.querySelectorAll("script,style,noscript").forEach(node => node.remove());
  if (!/网站标识码：\s*bm25000001/u.test(page.textContent) || !/网站主办单位：中国人民银行办公厅/u.test(page.textContent)) return null;
  const clone = body.cloneNode(true);
  clone.querySelectorAll("head,script,style,noscript,svg,nav,aside,footer").forEach(node => node.remove());
  clone.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
  clone.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6").forEach(node => node.append("\n"));
  const text = `${title}\n${clone.textContent}`.replace(/[\t\f\v ]+/gu, " ").replace(/\s*\n\s*/gu, "\n").trim();
  if ([...text].length < 80 || /\{\{[^}]+\}\}/u.test(text)) return null;
  const publishedAt = new Date(clock.replace(" ", "T") + "+08:00").toISOString();
  return { version: PBOC_DOCUMENT_VERSION, ...identity, title, text, publishedAtCandidates: [publishedAt], publishedDateCandidates: [identity.publicationDate] };
}
