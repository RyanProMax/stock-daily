import { JSDOM } from "jsdom";
import { verifiedExternalSourceLabel, verifiedExternalSourceType, verifiedFirstPartyIssuerIdentity } from "./source-registry.mjs";
import { chinaPmiDocument } from "./china-pmi-release.mjs";
import { mofDocumentIdentity, mofDocumentRecord } from "./mof-document.mjs";
import { pbocDocumentIdentity, pbocDocumentRecord } from "./pboc-document.mjs";
import { nativeIssuerReleaseIdentity, nativeIssuerReleaseRecord } from "./native-issuer-release.mjs";
import { yahooLiveArticleIdentity, yahooLiveArticleRecord } from "./yahoo-live-article.mjs";

import { englishPublicationDate, newYorkPublicationDate } from "./fed-speech-publication.mjs";

export const ARTICLE_PROVENANCE_VERSION = "verified-article-provenance-v8";
const TYPES = new Set(["article", "newsarticle", "analysisnewsarticle", "reportagenewsarticle"]);
const normalized = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
const titleKey = value => normalized(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const corporateNameKey = value => titleKey(normalized(value).replace(/(?:[\s,.]+(?:co|corp|corporation|company|inc|incorporated|ltd|limited|plc)\.?)+$/iu, ""));

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
  // HPE's own page binds its public article URL to a CMS mainEntityOfPage.
  // This exact path relation is allowed only with both native public identity
  // records. It is not a URL rewrite, redirect or borrowed parent timestamp.
  const publicUrl = new URL(source), cmsAlias = publicUrl.hostname === "www.hpe.com" && /^\/us\/en\/newsroom\/press-release\//u.test(publicUrl.pathname) && !publicUrl.search
    && [...document.querySelectorAll('link[rel="canonical"]')].length === 1 && exactUrl(document.querySelector('link[rel="canonical"]').getAttribute("href"), source) === expected
    && [...document.querySelectorAll('meta[property="og:url"]')].length === 1 && exactUrl(document.querySelector('meta[property="og:url"]').getAttribute("content"), source) === expected
    ? exactUrl(`https://www.hpe.com/content/hpe/country${publicUrl.pathname}`, source) : null;
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const types = (Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]]).map(value => String(value ?? "").toLowerCase());
    const entity = value.mainEntityOfPage;
    const identities = [value.url, value["@id"], typeof entity === "string" ? entity : null, entity?.url, entity?.["@id"]];
    const ownPublisher = names(value.publisher).some(name => corporateNameKey(name) === corporateNameKey(verifiedFirstPartyIssuerIdentity(source)?.label));
    if (types.some(type => TYPES.has(type)) && (identities.some(value => exactUrl(value, source) === expected) || (cmsAlias && ownPublisher && identities.some(value => exactUrl(value, source) === cmsAlias)))) matches.push(value);
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

function declaredPageIdentities(value) {
  if (Array.isArray(value)) return value.flatMap(declaredPageIdentities);
  if (value && typeof value === "object") return [value.url, value["@id"]].filter(item => item != null).flatMap(declaredPageIdentities);
  return value == null ? [] : [value];
}

function ownedArticleHeading(document, source, article, pageHeadlines) {
  const expected = exactUrl(source, source);
  const canonical = [...document.querySelectorAll('link[rel="canonical"]')];
  const ogUrls = [...document.querySelectorAll('meta[property="og:url"]')];
  const identityAgrees = (items, attribute) => items.length <= 1 && items.every(item => exactUrl(item.getAttribute(attribute), source) === expected);
  if (!identityAgrees(canonical, "href") || !identityAgrees(ogUrls, "content")) return false;
  const bodies = [...document.querySelectorAll("article")];
  const headings = bodies.length === 1 ? [...bodies[0].querySelectorAll("h1")] : [];
  if (bodies.length > 1 || (bodies.length === 1 && (headings.length !== 1 || headings[0].closest("figure, figcaption, aside, nav, footer, blockquote") || titleKey(headings[0].textContent) !== titleKey(article.headline)))) return false;
  const identities = [article.url, article["@id"], ...declaredPageIdentities(article.mainEntityOfPage)].filter(value => value != null);
  if (verifiedExternalSourceType(source) === "publisher" && identities.some(value => exactUrl(value, source) !== expected)) return false;
  if (pageHeadlines.length === 1 && titleKey(pageHeadlines[0]) === titleKey(article.headline)) return true;
  // A website logo or navigation heading is outside the owned story. Ignore
  // it only when the one story body, both exact public identities and its
  // author bind the metadata to this page; another article cannot lend a clock.
  return bodies.length === 1 && headings.length === 1 && canonical.length === 1 && ogUrls.length === 1 && names(article.author).some(Boolean) && identities.every(value => exactUrl(value, source) === expected);
}

function issuerPublisherMatches(value, issuer, source) {
  if (names(value).some(name => corporateNameKey(name) === corporateNameKey(issuer.label))) return true;
  // This reviewed Q4 release uses the Micron brand alongside its legal name.
  // Neither an unrelated organization nor Q4's separate software credit owns it.
  return issuer.domain === "micron.com" && value?.["@type"] === "Corporation" && value.name === "Micron" &&
    corporateNameKey(value.legalName) === corporateNameKey(issuer.label) &&
    exactUrl(value.url, source) === "https://investors.micron.com/";
}

function micronReleaseHeading(document, source, article) {
  const url = new URL(source);
  if (url.hostname !== "investors.micron.com" || !/^\/news\/press-release\/20\d{2}\/[^/]+\/default\.aspx$/u.test(url.pathname) || url.search) return false;
  const modules = [...document.querySelectorAll("main .evergreen-news-details")];
  const urls = [...document.querySelectorAll('meta[property="og:url"]')];
  if (modules.length !== 1 || urls.length !== 1 || exactUrl(urls[0].content, source) !== exactUrl(source, source)) return false;
  const items = [...modules[0].querySelectorAll(".evergreen-news-details-item")];
  if (items.length !== 1) return false;
  const headings = [...items[0].querySelectorAll("h3.evergreen-news-title")], dates = [...items[0].querySelectorAll(".evergreen-news-date-text")];
  const published = instant(article.datePublished);
  if (headings.length !== 1 || dates.length !== 1 || !published || titleKey(headings[0].textContent) !== titleKey(article.headline)) return false;
  const visibleDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(new Date(published));
  return normalized(dates[0].textContent) === visibleDate;
}

function hpeReleaseDate(document, source, article) {
  const url = new URL(source);
  const path = /^\/us\/en\/newsroom\/press-release\/(20\d{2})\/(\d{2})\/[a-z0-9-]+\.html$/u.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.hpe.com" || url.search || url.hash || !path) return null;
  const modules = document.querySelectorAll(".newsroom-article");
  if (modules.length !== 1) return null;
  const headers = modules[0].querySelectorAll(":scope > .newsroom-a-header");
  if (headers.length !== 1) return null;
  const titles = headers[0].querySelectorAll(":scope > h1.newsroom-a-title");
  const dates = headers[0].querySelectorAll(":scope > .newsroom-a-info > .newsroom-a-data");
  if (titles.length !== 1 || dates.length !== 1 || titleKey(titles[0].textContent) !== titleKey(article.headline)) return null;
  const date = englishPublicationDate(dates[0].textContent), publishedAt = instant(article.datePublished);
  return date && publishedAt && date === newYorkPublicationDate(publishedAt) && date.startsWith(`${path[1]}-${path[2]}-`) ? date : null;
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
  if (yahooLiveArticleIdentity(source)) {
    const record = yahooLiveArticleRecord(decodedHtml, source);
    return { version: ARTICLE_PROVENANCE_VERSION, origin: record?.origin ?? { key: "publisher:finance.yahoo.com", identified: false, basis: "origin_unresolved" }, publication: record ? { status: "verified", initialPublishedAt: record.initialPublishedAt, currentVersionAt: record.currentVersionAt, timeBasis: record.initialPublishedAt === record.currentVersionAt ? "first_publication" : "article_update" } : { status: "unverified_update" } };
  }
  const nativeIssuer = nativeIssuerReleaseIdentity(source);
  if (nativeIssuer) {
    const record = nativeIssuerReleaseRecord(decodedHtml, source);
    return { version: ARTICLE_PROVENANCE_VERSION, origin: { key: `issuer:${nativeIssuer.issuerDomain}`, identified: Boolean(record), basis: record ? "bound_issuer_document" : "origin_unresolved" }, publication: record ? { status: "verified_date", publicationDate: record.publicationDate, timeBasis: "native_announcement_date" } : { status: "unverified_update" } };
  }
  if (mofDocumentIdentity(source)) {
    const record = mofDocumentRecord(decodedHtml, source);
    return { version: ARTICLE_PROVENANCE_VERSION, origin: { key: "authority:mof.gov.cn", identified: Boolean(record), basis: record ? "bound_authority_document" : "origin_unresolved" }, publication: record ? { status: "verified", initialPublishedAt: record.publishedAtCandidates[0], currentVersionAt: record.publishedAtCandidates[0], timeBasis: "first_publication" } : { status: "unverified_update" } };
  }
  const chinaPmi = chinaPmiDocument(decodedHtml, source);
  if (pbocDocumentIdentity(source)) {
    const record = pbocDocumentRecord(decodedHtml, source);
    return { version: ARTICLE_PROVENANCE_VERSION, origin: { key: "authority:pbc.gov.cn", identified: Boolean(record), basis: record ? "bound_authority_document" : "origin_unresolved" }, publication: record ? { status: "verified", initialPublishedAt: record.publishedAtCandidates[0], currentVersionAt: record.publishedAtCandidates[0], timeBasis: "first_publication" } : { status: "unverified_update" } };
  }
  if (chinaPmi) return { version: ARTICLE_PROVENANCE_VERSION, origin: { key: "authority:stats.gov.cn", identified: true, basis: "bound_authority_document" }, publication: { status: "verified", initialPublishedAt: chinaPmi.publishedAt, currentVersionAt: chinaPmi.publishedAt, timeBasis: "first_publication" } };
  const sourceType = verifiedExternalSourceType(source), issuer = verifiedFirstPartyIssuerIdentity(source);
  if (sourceType !== "publisher" && !(sourceType === "first_party" && issuer)) return null;
  const document = new JSDOM(decodedHtml).window.document;
  const headlines = [...document.querySelectorAll("h1")].map(item => normalized(item.textContent)).filter(Boolean);
  const allArticles = matchingArticles(document, source);
  const articles = allArticles.length === 1 ? allArticles.filter(item => (ownedArticleHeading(document, source, item, headlines) || (issuer?.domain === "micron.com" && micronReleaseHeading(document, source, item))) && titleKey(item.headline).length >= 8 && (!issuer || issuerPublisherMatches(item.publisher, issuer, source))) : [];
  const host = new URL(source).hostname.replace(/^www\./u, "");
  const nativeAgency = /(?:^|\.)apnews\.com$/u.test(host) ? "agency:associated_press" : /(?:^|\.)reuters\.com$/u.test(host) ? "agency:reuters" : null;
  let origin = issuer ? { key: `issuer:${issuer.domain}`, identified: false, basis: "origin_unresolved" } : nativeAgency ? { key: nativeAgency, identified: true, basis: "original_agency_domain" } : { key: `publisher:${host.replace(/^(?:[a-z]{2})\.finance\.yahoo\.com$/u, "finance.yahoo.com")}`, identified: false, basis: "origin_unresolved" };
  let publication = null;
  if (allArticles.some(item => item.dateModified != null) || document.querySelector('meta[property="article:modified_time"]')) publication = { status: "unverified_update" };
  if (articles.length === 1) {
    const article = articles[0], authors = names(article.author), authorAgencies = authors.map(agency).filter(Boolean);
    if (issuer) origin = { key: `issuer:${issuer.domain}`, identified: true, basis: "bound_issuer_article" };
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
    if (!issuer) {
      if (agencies.length === 1) origin = { key: agencies[0], identified: true, basis: "bound_article_attribution" };
      else if (!agencies.length && authors.length && names(article.publisher).some(name => titleKey(name) === titleKey(verifiedExternalSourceLabel(source)))) origin = { ...origin, identified: true, basis: "bound_publisher_and_author" };
      else if (agencies.length > 1) origin = { ...origin, identified: false, basis: "ambiguous_attribution" };
    }
    if (article.dateModified != null || (issuer && !document.querySelector('meta[property="article:modified_time"]'))) {
      const initialPublishedAt = instant(article.datePublished), currentVersionAt = instant(article.dateModified ?? article.datePublished);
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
      if (publication.status === "verified" && issuer?.domain === "micron.com" && micronReleaseHeading(document, source, article)) publication.boundReleaseDate = initialPublishedAt.slice(0, 10);
      if (publication.status === "verified" && issuer?.domain === "hpe.com") {
        const date = hpeReleaseDate(document, source, article);
        if (date) publication.boundReleaseDate = date;
      }
    }
  }
  return { version: ARTICLE_PROVENANCE_VERSION, publication, origin };
}
