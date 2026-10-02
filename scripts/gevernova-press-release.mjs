import { JSDOM } from "jsdom";

export const GEVERNOVA_PRESS_RELEASE_VERSION = "verified-gevernova-press-release-v1";
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function gevernovaPressReleaseIdentity(source) {
  let url; try { url = new URL(source); } catch { return null; }
  const match = /^\/news\/press-releases\/([a-z0-9]+(?:-[a-z0-9]+){1,32})$/u.exec(url.pathname);
  if (url.origin !== "https://www.gevernova.com" || url.username || url.password || url.search || url.hash || !match) return null;
  return { slug: match[1], pathname: url.pathname };
}

// The reviewed release has an owned first-paragraph dateline repeated in its
// description. It supplies a DAY, not an intraday publication or ex-dividend time.
export function gevernovaPressReleaseRecord(html, source) {
  const identity = gevernovaPressReleaseIdentity(source);
  if (!identity) return null;
  const document = new JSDOM(html).window.document;
  const canonical = [...document.head.querySelectorAll('link[rel="canonical"]')];
  const descriptions = [...document.head.querySelectorAll('meta[name="description"]')];
  const owners = [...document.querySelectorAll("#block-ge-vernova-news-content")];
  if (canonical.length !== 1 || canonical[0].getAttribute("href") !== source || descriptions.length !== 1 || owners.length !== 1) return null;
  const owner = owners[0], headings = [...owner.querySelectorAll(".hero-article-section h1.hero-article-title")], bodies = [...owner.querySelectorAll(".article-text-content > .article-para")];
  if (headings.length !== 1 || document.querySelectorAll("h1").length !== 1 || bodies.length !== 1 || document.querySelectorAll(".article-text-content").length !== 1 || !(headings[0].compareDocumentPosition(bodies[0]) & document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)) return null;
  const title = clean(headings[0].textContent), body = bodies[0];
  if (title.length < 12 || title.length > 220 || !/^GE Vernova\b/u.test(title) || document.title.trim() !== `${title} | GE Vernova News`) return null;
  const paragraphs = [...body.children].filter(node => node.tagName === "P");
  const pattern = new RegExp(`^CAMBRIDGE, Mass\\. \\((${months.join("|")}) ([1-9]|[12]\\d|3[01]), (20\\d{2})\\) [—–-] GE Vernova \\(NYSE: ([A-Z]{1,5})\\) today announced\\b`, "u");
  const datelines = paragraphs.map((node, index) => ({ node, index, match: pattern.exec(clean(node.textContent)) })).filter(x => x.match);
  if (datelines.length !== 1 || datelines[0].index !== 0 || datelines[0].match[4] !== "GEV") return null;
  const { node, match } = datelines[0], date = `${match[3]}-${String(months.indexOf(match[1]) + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date || !clean(descriptions[0].content).startsWith(clean(node.textContent))) return null;
  // The reviewed page was edited after initial publication. Its JSON record
  // lacks an article URL/publisher, so it cannot establish an intraday clock.
  // Both version dates must match the owned dateline's day. A later-day
  // revision must not borrow the original date.
  const scripts = [...document.head.querySelectorAll('script[type="application/ld+json"]')];
  let graph;
  try { graph = scripts.length === 1 ? JSON.parse(scripts[0].textContent) : null; } catch { return null; }
  const article = graph?.["@context"] === "https://schema.org" && graph?.["@graph"]?.length === 1 ? graph["@graph"][0] : null;
  const versionDate = value => {
    const match = /^(20\d{2}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}-0[45]00$/u.exec(value ?? "");
    const normalized = typeof value === "string" ? value.replace(/(-0[45])(00)$/u, "$1:$2") : "";
    return match && Number.isFinite(Date.parse(normalized)) && new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(normalized)) === match[1] ? match[1] : null;
  };
  if (article?.["@type"] !== "NewsArticle" || clean(article.headline) !== title || versionDate(article.datePublished) !== date || versionDate(article.dateModified) !== date || Date.parse(article.dateModified) < Date.parse(article.datePublished)) return null;
  if ([...document.head.querySelectorAll("meta")].some(x => /^(?:datePublished|pubdate|publishdate|article:published_time|dateModified|article:modified_time|lastModified|updateTime)$/iu.test(x.name || x.getAttribute("property") || "")) || [...owner.querySelectorAll("p,div,h2,h3,h4,li,time")].some(x => /^(?:Updated|Last updated|Revised|Correction)\s*[:—–-]/iu.test(clean(x.textContent)))) return null;
  const clone = body.cloneNode(true);
  clone.querySelectorAll("script,style,noscript,svg,nav,aside,figure").forEach(x => x.remove());
  clone.querySelectorAll("br").forEach(x => x.replaceWith("\n"));
  clone.querySelectorAll("p,div,li,h2,h3,h4").forEach(x => x.append("\n"));
  const text = `${title}\n${clone.textContent}`.replace(/[\t\f\v ]+/gu, " ").replace(/\s*\n\s*/gu, "\n").trim();
  if (text.length < 120 || /\{\{[^}]+\}\}/u.test(text)) return null;
  return { version: GEVERNOVA_PRESS_RELEASE_VERSION, ...identity, title, text, publicationDate: date, publishedAtCandidates: [], publishedDateCandidates: [date], issuer: { name: "GE Vernova", exchange: "NYSE", ticker: match[4] }, timePrecision: "date" };
}
