import { JSDOM } from "jsdom";

export const SNOWFLAKE_PRESS_RELEASE_VERSION = "verified-snowflake-press-release-v1";
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function snowflakePressReleaseIdentity(source) {
  let url; try { url = new URL(source); } catch { return null; }
  const match = /^\/en\/news\/press-releases\/([a-z0-9]+(?:-[a-z0-9]+){1,24})\/$/u.exec(url.pathname);
  if (url.origin !== "https://www.snowflake.com" || url.username || url.password || url.search || url.hash || !match) return null;
  return { slug: match[1], pathname: url.pathname, nativeUrl: `https://www.snowflake.com/content/snowflake-site/global${url.pathname.slice(0, -1)}` };
}

// This reviewed native release prints an issuer dateline in its owned body and
// repeats it in the same article's three descriptions. It establishes a release
// DAY only. A place name, "today", SEO text or market hours supplies no clock.
export function snowflakePressReleaseRecord(html, source) {
  const identity = snowflakePressReleaseIdentity(source);
  if (!identity) return null;
  const document = new JSDOM(html).window.document;
  const meta = (attribute, name) => {
    const nodes = [...document.head.querySelectorAll(`meta[${attribute}="${name}"]`)];
    return nodes.length === 1 ? clean(nodes[0].content) : null;
  };
  const canonical = [...document.head.querySelectorAll('link[rel="canonical"]')];
  if (canonical.length !== 1 || canonical[0].getAttribute("href") !== source || meta("property", "og:url") !== identity.nativeUrl || meta("name", "apple-mobile-web-app-title") !== "Snowflake") return null;
  const heroes = [...document.querySelectorAll(".snowflake-hero-system.hero--press")], owners = [...document.querySelectorAll(".snowflake-flexible-column-container.press-body")], bodies = [...document.querySelectorAll(".snowflake-text.main-pr-body[data-analytics-section='text']")];
  if (heroes.length !== 1 || owners.length !== 1 || bodies.length !== 1 || document.querySelectorAll(".main-pr-body").length !== 1 || !owners[0].contains(bodies[0])) return null;
  const hero = heroes[0], owner = owners[0], body = bodies[0], page = hero.closest(".aem-page.page");
  if (!page || owner.closest(".aem-page.page") !== page || hero.contains(owner) || owner.contains(hero) || !(hero.compareDocumentPosition(owner) & document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)) return null;
  const headings = [...hero.querySelectorAll(".snowflake-hero-system-headline h1.snowflake-title-v2-line")];
  if (headings.length !== 1 || document.querySelectorAll("h1").length !== 1) return null;
  const title = clean(headings[0].textContent);
  if (title.length < 12 || title.length > 220 || !/\bSnowflake\b/u.test(title) || meta("property", "og:title") !== title || meta("name", "twitter:title") !== title) return null;
  if (body.children.length !== 1 || body.children[0].tagName !== "SPAN") return null;
  const wrapper = body.children[0], paragraphs = [...wrapper.children].filter(node => node.tagName === "P");
  const pattern = new RegExp(`^([A-Z][A-Z .,'’()]{1,65}) [—–-] (${months.join("|")}) ([1-9]|[12]\\d|3[01]), (20\\d{2}) [—–-] Snowflake(?: Inc\\.)? \\(NYSE: ([A-Z]{1,5})\\)[, ]`, "u");
  const datelines = paragraphs.map((node, index) => ({ node, index, match: pattern.exec(clean(node.textContent)) })).filter(item => item.match);
  if (datelines.length !== 1 || datelines[0].index > 4 || datelines[0].match[5] !== "SNOW") return null;
  const { match, node } = datelines[0], date = `${match[4]}-${String(months.indexOf(match[2]) + 1).padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return null;
  const dateline = clean(node.textContent);
  for (const [attribute, name] of [["name", "description"], ["property", "og:description"], ["name", "twitter:description"]]) {
    const description = meta(attribute, name), prefix = description?.replace(/(?:\.{3}|…)$/u, "").trim();
    if (!prefix || prefix.length < match[0].length || !dateline.startsWith(prefix) || !pattern.test(description)) return null;
  }
  // A revised or differently timestamped native variant needs its own review;
  // do not fall back to its earlier dateline or borrow unrelated metadata.
  const revisionNodes = [...wrapper.querySelectorAll("p,h2,h3,h4,h5,h6,div,li,time")];
  if ([...document.head.querySelectorAll("meta")].some(node => /^(?:datePublished|pubdate|publishdate|article:published_time|dateModified|article:modified_time|lastModified|updateTime)$/iu.test(node.name || node.getAttribute("property") || "")) || [...document.head.querySelectorAll('script[type="application/ld+json"]')].some(node => /"date(?:Published|Modified)"\s*:/u.test(node.textContent)) || revisionNodes.some(node => /^(?:Updated|Last updated|Revised|Correction)\s*[:—–-]/iu.test(clean(node.textContent)))) return null;
  const clone = wrapper.cloneNode(true);
  clone.querySelectorAll("head,script,style,noscript,svg,nav,aside").forEach(node => node.remove());
  clone.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
  clone.querySelectorAll("p,div,li,h2,h3,h4,h5,h6").forEach(node => node.append("\n"));
  const text = `${title}\n${clone.textContent}`.replace(/[\t\f\v ]+/gu, " ").replace(/\s*\n\s*/gu, "\n").trim();
  if (text.length < 120 || /\{\{[^}]+\}\}/u.test(text)) return null;
  return { version: SNOWFLAKE_PRESS_RELEASE_VERSION, ...identity, title, text, publicationDate: date, publishedAtCandidates: [], publishedDateCandidates: [date], issuer: { name: "Snowflake", exchange: "NYSE", ticker: match[5] }, timePrecision: "date" };
}
