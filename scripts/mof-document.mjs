import { JSDOM } from "jsdom";

export const MOF_DOCUMENT_VERSION = "verified-mof-finance-document-v2";
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const key = value => clean(value).replace(/\s+/gu, "");

export function mofDocumentIdentity(source) {
  let url;
  try { url = new URL(source); } catch { return null; }
  const path = /^\/zhengcejiedu\/(20\d{4})\/t(20\d{2})(\d{2})(\d{2})_([1-9]\d{5,9})\.htm$/u.exec(url.pathname);
  if (url.origin !== "https://jrs.mof.gov.cn" || url.username || url.password || url.search || url.hash || !path || path[1] !== path[2] + path[3]) return null;
  const date = `${path[2]}-${path[3]}-${path[4]}`, calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return null;
  return { publicationDate: date, documentId: path[5] };
}

// Only this reviewed Financial Department article template establishes local
// publication time. A generic government hostname or URL date does not.
export function mofDocumentRecord(html, source) {
  const identity = mofDocumentIdentity(source);
  if (!identity) return null;
  const document = new JSDOM(html).window.document;
  const meta = name => {
    const nodes = [...document.head.querySelectorAll(`meta[name="${name}"]`)];
    return nodes.length === 1 ? nodes[0].content : null;
  };
  if (meta("SiteName") !== "中华人民共和国财政部" || meta("SiteDomain") !== "http://www.mof.gov.cn" || meta("SiteIDCode") !== "bm14000001" || !["", "金融司"].includes(meta("ContentSource"))) return null;
  const containers = [...document.querySelectorAll(".mainboxerji > .box_content")];
  if (containers.length !== 1) return null;
  const headings = [...containers[0].querySelectorAll("h2.title_con")], bodies = [...containers[0].querySelectorAll(".my_conboxzw > .my_doccontent")];
  const titles = [...document.head.querySelectorAll("title")];
  const title = clean(headings[0]?.textContent);
  if (headings.length !== 1 || bodies.length !== 1 || titles.length !== 1 || title.length < 8 || title.length > 220 || key(title) !== key(meta("ArticleTitle")) || key(title) !== key(titles[0].textContent)) return null;
  const clock = meta("PubDate");
  if (!/^20\d{2}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(clock ?? "") || clock.slice(0, 10) !== identity.publicationDate) return null;
  const dateLabel = value => {
    const match = /^(20\d{2})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日$/u.exec(value);
    return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
  };
  const byline = clean(bodies[0].querySelector("p")?.textContent);
  const bylineMatch = /^(20\d{2}年\d{1,2}月\d{1,2}日) 来源：金融司$/u.exec(byline);
  const dateNodes = [...document.querySelectorAll(".mainboxerji .docreltime")];
  const dateMatch = /^发布日期：(20\d{2}年\d{1,2}月\d{1,2}日)$/u.exec(clean(dateNodes[0]?.textContent));
  if (!bylineMatch || dateNodes.length !== 1 || !dateMatch || dateLabel(bylineMatch[1]) !== identity.publicationDate || dateLabel(dateMatch[1]) !== identity.publicationDate) return null;
  if ([...document.querySelectorAll("meta")].some(node => /^(?:dateModified|article:modified_time|bytedance:updated_time|updateTime|lastModified)$/iu.test(node.name || node.getAttribute("property") || "")) || dateNodes.some(node => /更新时间|修改时间|修订时间/u.test(node.textContent))) return null;
  const canonical = [...document.head.querySelectorAll('link[rel="canonical"],meta[property="og:url"]')];
  if (canonical.some(node => (node.getAttribute("href") ?? node.getAttribute("content")) !== source)) return null;
  const clone = bodies[0].cloneNode(true);
  clone.querySelectorAll("head,script,style,noscript,svg,nav,aside,footer").forEach(node => node.remove());
  clone.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
  clone.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6").forEach(node => node.append("\n"));
  const text = `${title}\n${clone.textContent}`.replace(/[\t\f\v ]+/gu, " ").replace(/\s*\n\s*/gu, "\n").trim();
  if ([...text].length < 80 || /\{\{[^}]+\}\}/u.test(text)) return null;
  const publishedAt = new Date(clock.replace(" ", "T") + "+08:00").toISOString();
  return { version: MOF_DOCUMENT_VERSION, ...identity, title, text, publishedAtCandidates: [publishedAt], publishedDateCandidates: [identity.publicationDate] };
}
