import { JSDOM } from "jsdom";
import { ARTICLE_PROVENANCE_VERSION } from "./source-article-provenance.mjs";

export const NFRA_DOCUMENT_VERSION = "verified-nfra-document-v1";
const normalized = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();

// The native ItemDetail.js calls this exact same-origin record using the page's
// docId. The page is only a template; its footer is never the article body.
export function nfraDocumentIdentity(source) {
  let url;
  try { url = new URL(source); } catch { return null; }
  if (url.origin !== "https://www.nfra.gov.cn" || url.username || url.password || url.hash || !["/cn/view/pages/ItemDetail.html", "/cn/view/pages/governmentDetail.html"].includes(url.pathname)) return null;
  const allowed = url.pathname.endsWith("governmentDetail.html") ? ["docId", "itemId", "generaltype"] : ["docId", "itemId"];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return null;
  const docId = url.searchParams.get("docId"), itemId = url.searchParams.get("itemId");
  if (!/^[1-9]\d{0,8}$/u.test(docId ?? "") || !/^[1-9]\d{0,5}$/u.test(itemId ?? "") || (url.searchParams.has("generaltype") && url.searchParams.get("generaltype") !== "1")) return null;
  return { docId: Number(docId), itemId: Number(itemId), recordUrl: `https://www.nfra.gov.cn/cn/static/data/DocInfo/SelectByDocId/data_docId=${docId}.json` };
}

function publicationInstant(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(value)) return null;
  const date = value.slice(0, 10);
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return null;
  // This reviewed Chinese authority's native publishDate is Beijing time.
  return new Date(value.replace(" ", "T") + "+08:00").toISOString();
}

function editInstant(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u.test(value) || /[+-]14:(?!00)/u.test(value)) return null;
  const instant = Date.parse(value), date = value.slice(0, 10);
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(instant) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return null;
  return new Date(instant).toISOString();
}

export function nfraDocumentRecord(shell, receipt, source) {
  const identity = nfraDocumentIdentity(source);
  if (!identity || receipt?.finalUrl !== identity.recordUrl || receipt.status !== 200 || !/^application\/json(?:;|$)/iu.test(receipt.contentType ?? "") || !Buffer.isBuffer(receipt.rawBody) || receipt.rawBody.length > 4 * 1024 * 1024) return null;
  const document = new JSDOM(shell).window.document;
  const controller = document.querySelector('[ng-controller="itemDetailCtrl"]');
  let scripts;
  try { scripts = [...document.querySelectorAll("script[src]")].map(item => new URL(item.getAttribute("src"), source)); } catch { return null; }
  if (!controller || !controller.querySelector('[ng-bind-html="data.docClob|trustHtml"]') || !controller.querySelector('[ng-bind-html^="data.docTitle|"]') || !controller.textContent.includes("data.publishDate|dateFormat2") || !["ItemDetail.js", "Script.js"].every(name => scripts.filter(url => url.origin === "https://www.nfra.gov.cn" && url.pathname === `/cn/js/common/${name}`).length === 1)) return null;
  let response;
  try { response = JSON.parse(receipt.rawBody.toString("utf8")); } catch { return null; }
  const data = response?.data;
  if (response?.rptCode !== 200 || !data || data.docId !== identity.docId || data.documentType !== "0" || !["办公厅", "大型银行监管司"].includes(data.docSource) || data.titleLink || data.isTitleLink || !Array.isArray(data.listTwoItem) || data.listTwoItem.filter(item => item?.ItemID === identity.itemId).length !== 1 || typeof data.docClob !== "string" || data.docClob.length > 1_000_000) return null;
  const title = normalized(data.docTitle);
  // Native Chinese headings insert a display newline which docSubtitle omits.
  // Ignore spacing only; changed words, numbers and punctuation still fail.
  if (title.length < 8 || title.length > 220 || title.replace(/\s+/gu, "") !== normalized(data.docSubtitle).replace(/\s+/gu, "")) return null;
  const initialPublishedAt = publicationInstant(data.publishDate);
  if (!initialPublishedAt) return null;
  const body = new JSDOM(data.docClob).window.document;
  body.querySelectorAll("head, script, style, noscript, svg").forEach(item => item.remove());
  body.querySelectorAll("br").forEach(item => item.replaceWith("\n"));
  body.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6").forEach(item => item.append("\n"));
  const text = `${title}\n${body.body.textContent}`.replace(/[\t\f\v ]+/gu, " ").replace(/\s*\n\s*/gu, "\n").trim();
  if ([...text].length < 80 || /\{\{[^}]+\}\}/u.test(text)) return null;
  // A later CMS edit is not proof of when that revised public version became
  // available. Refuse to borrow the earlier creation time for changed text.
  const unchanged = editInstant(data.docEditdate) === initialPublishedAt;
  return {
    version: NFRA_DOCUMENT_VERSION, docId: identity.docId, title, text,
    publishedAtCandidates: unchanged ? [initialPublishedAt] : [],
    publishedDateCandidates: [data.publishDate.slice(0, 10)],
    articleProvenance: { version: ARTICLE_PROVENANCE_VERSION, origin: { key: "authority:nfra.gov.cn", identified: true, basis: "bound_authority_document" }, publication: unchanged ? { status: "verified", initialPublishedAt, currentVersionAt: initialPublishedAt, timeBasis: "first_publication" } : { status: "unverified_update" } },
  };
}
