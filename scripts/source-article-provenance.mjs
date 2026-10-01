import { JSDOM } from "jsdom";
import { verifiedExternalSourceLabel, verifiedExternalSourceType } from "./source-registry.mjs";

export const ARTICLE_PROVENANCE_VERSION = "verified-article-provenance-v1";
const TYPES = new Set(["article", "newsarticle", "analysisnewsarticle", "reportagenewsarticle"]);
const normalized = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
const titleKey = value => normalized(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function exactUrl(value, base) {
  try {
    if (typeof value !== "string" || !value.trim()) return null;
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    url.hostname = url.hostname.replace(/^www\./u, "");
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function instant(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u.test(value)) return null;
  const date = value.slice(0, 10), calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date || !Number.isFinite(Date.parse(value)) || /[+-]14:(?!00)/u.test(value)) return null;
  return new Date(value).toISOString();
}

function matchingArticles(document, source) {
  const matches = [], expected = exactUrl(source, source);
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const types = (Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]]).map(value => String(value ?? "").toLowerCase());
    const entity = value.mainEntityOfPage;
    const identities = [value.url, value["@id"], typeof entity === "string" ? entity : null, entity?.url, entity?.["@id"]];
    if (types.some(type => TYPES.has(type)) && identities.some(value => exactUrl(value, source) === expected)) matches.push(value);
    Object.values(value).forEach(visit);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)); } catch { /* Invalid metadata supplies no article identity. */ }
  }
  return matches;
}

function names(value) {
  if (Array.isArray(value)) return value.flatMap(names);
  if (typeof value === "string") return [normalized(value)];
  return value && typeof value.name === "string" ? [normalized(value.name)] : [];
}

function agency(value) {
  if (/\bAssociated Press\b|\bAP (?:Business|Technology|Economics|Financial|News|Staff)?\s*(?:Writer|Writers|Correspondent|Reporter)\b/iu.test(value)) return "agency:associated_press";
  if (/^(?:Reuters|Thomson Reuters)$/iu.test(value) || /\b(?:Reuters (?:Writer|Reporter|Correspondent)|(?:for|at) Reuters)\b/iu.test(value)) return "agency:reuters";
  return null;
}

// Only the current article's identity, author and owned body can establish
// version availability or reporting origin. Photo credits, recommended
// articles, website footers and a generic dateModified are excluded.
export function sourceArticleProvenance(decodedHtml, source) {
  if (verifiedExternalSourceType(source) !== "publisher") return null;
  const document = new JSDOM(decodedHtml).window.document;
  const headlines = [...document.querySelectorAll("h1")].map(item => normalized(item.textContent)).filter(Boolean);
  const allArticles = matchingArticles(document, source);
  const articles = allArticles.filter(item => headlines.length === 1 && titleKey(item.headline) === titleKey(headlines[0]) && titleKey(item.headline).length >= 8);
  const host = new URL(source).hostname.replace(/^www\./u, "");
  const nativeAgency = /(?:^|\.)apnews\.com$/u.test(host) ? "agency:associated_press" : /(?:^|\.)reuters\.com$/u.test(host) ? "agency:reuters" : null;
  let origin = nativeAgency ? { key: nativeAgency, identified: true, basis: "original_agency_domain" } : { key: `publisher:${host.replace(/^(?:[a-z]{2})\.finance\.yahoo\.com$/u, "finance.yahoo.com")}`, identified: false, basis: "origin_unresolved" };
  let publication = null;
  if (allArticles.some(item => item.dateModified != null) || document.querySelector('meta[property="article:modified_time"]')) publication = { status: "unverified_update" };
  if (articles.length === 1) {
    const article = articles[0], authors = names(article.author), authorAgencies = authors.map(agency).filter(Boolean);
    const bodies = [...document.querySelectorAll("article")].filter(item => {
      const heading = item.querySelector("h1");
      return !heading || titleKey(heading.textContent) === titleKey(article.headline);
    });
    if (bodies.length === 1) {
      const body = bodies[0].cloneNode(true);
      body.querySelectorAll("figure, figcaption, picture, img, aside, nav, footer, blockquote").forEach(item => item.remove());
      const paragraphs = [...body.querySelectorAll("p")].map(item => normalized(item.textContent)).filter(Boolean);
      for (const text of paragraphs.slice(0, 3)) {
        const dateline = /^[A-Z][A-Z .,-]{1,60}(?: [A-Z][a-z]+ \d{1,2})?\s*\((AP|Reuters)\)\s*[—–-]/u.exec(text);
        if (dateline && authors.length) authorAgencies.push(dateline[1] === "AP" ? "agency:associated_press" : "agency:reuters");
      }
      const ending = paragraphs.slice(-5).filter(text => text.length < 300 && /^[\p{L} .,&'-]+ (?:write|writes|report|reports) for (?:the )?(?:Associated Press|Reuters)\.$/iu.test(text));
      for (const text of ending) if (authors.length && authors.every(author => {
        const lastName = author.split(/\s+/u).at(-1);
        return lastName.length >= 3 && text.toLocaleLowerCase().includes(lastName.toLocaleLowerCase());
      })) authorAgencies.push(agency(text));
    }
    const agencies = [...new Set(authorAgencies.filter(Boolean))];
    if (agencies.length === 1) origin = { key: agencies[0], identified: true, basis: "bound_article_attribution" };
    else if (!agencies.length && authors.length && names(article.publisher).some(name => titleKey(name) === titleKey(verifiedExternalSourceLabel(source)))) origin = { ...origin, identified: true, basis: "bound_publisher_and_author" };
    else if (agencies.length > 1) origin = { ...origin, identified: false, basis: "ambiguous_attribution" };
    if (article.dateModified != null) {
      const initialPublishedAt = instant(article.datePublished), currentVersionAt = instant(article.dateModified);
      const clocksAgree = (property, value) => [...document.querySelectorAll(`meta[property="${property}"]`)].every(item => {
        const raw = item.getAttribute("content") ?? "";
        // Offset-free labels cannot corroborate or override the exact zoned
        // article record. A conflicting explicit clock does invalidate it.
        if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw)) return true;
        const parsed = instant(raw);
        return parsed && (raw.includes(".") ? parsed === value : Math.floor(Date.parse(parsed) / 1_000) === Math.floor(Date.parse(value) / 1_000));
      });
      publication = initialPublishedAt && currentVersionAt && Date.parse(currentVersionAt) >= Date.parse(initialPublishedAt) && clocksAgree("article:published_time", initialPublishedAt) && clocksAgree("article:modified_time", currentVersionAt)
        ? { status: "verified", initialPublishedAt, currentVersionAt, timeBasis: currentVersionAt === initialPublishedAt ? "first_publication" : "article_update" }
        : { status: "unverified_update" };
    }
  }
  return { version: ARTICLE_PROVENANCE_VERSION, publication, origin };
}
