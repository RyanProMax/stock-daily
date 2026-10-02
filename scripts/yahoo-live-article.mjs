import { JSDOM } from "jsdom";

export const YAHOO_LIVE_ARTICLE_VERSION = "verified-yahoo-live-article-v1";
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const compact = value => clean(value).replace(/\s/gu, "");
const instant = value => {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u.test(value) || /[+-]14:(?!00)/u.test(value)) return null;
  const day = new Date(value.slice(0, 10) + "T00:00:00Z");
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
};
function livePostTime(value) {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (20\d{2}) at (1[0-2]|[1-9]):([0-5]\d) (AM|PM) UTC$/u.exec(clean(value));
  if (!match) return null;
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].indexOf(match[2]) + 1;
  const hour = Number(match[5]) % 12 + (match[7] === "PM" ? 12 : 0);
  const parsed = instant(`${match[4]}-${String(month).padStart(2, "0")}-${match[3].padStart(2, "0")}T${String(hour).padStart(2, "0")}:${match[6]}:00Z`);
  return parsed && ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(parsed).getUTCDay()] === match[1] ? parsed : null;
}

export function yahooLiveArticleIdentity(source) {
  let url; try { url = new URL(source); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["finance.yahoo.com", "ca.finance.yahoo.com"].includes(url.hostname)) return null;
  const match = /^\/(?:news|markets\/live)\/(stock-market-today-[a-z0-9]+(?:-[a-z0-9]+){2,40}-\d{9})\.html$/u.exec(url.pathname);
  return match ? { slug: match[1], canonical: `https://finance.yahoo.com/markets/live/${match[1]}.html`, regional: url.hostname === "ca.finance.yahoo.com" } : null;
}

// The reviewed regional live page has a navigation H1 as well as the owned
// article heading, and a primary Yahoo canonical alias. Neither a site logo
// nor the video's earlier upload time can identify/date the closing article.
export function yahooLiveArticleRecord(html, source) {
  const identity = yahooLiveArticleIdentity(source);
  if (!identity) return null;
  const document = new JSDOM(html).window.document;
  const canonical = [...document.head.querySelectorAll('link[rel="canonical"]')], urls = [...document.head.querySelectorAll('meta[property="og:url"]')];
  const owners = [...document.querySelectorAll("#main-content-wrapper article.article-wrap")];
  if (canonical.length !== 1 || canonical[0].getAttribute("href") !== identity.canonical || urls.length !== 1 || urls[0].content !== (identity.regional ? source : identity.canonical) || owners.length !== 1 || document.querySelectorAll("article.article-wrap").length !== 1) return null;
  const owner = owners[0], headings = [...owner.querySelectorAll(".cover-headline h1.cover-title")], times = [...owner.querySelectorAll(".byline-attr time.byline-attr-meta-time[datetime]")], bodies = [...owner.querySelectorAll(".body-wrap > .body > .bodyItems-wrapper")];
  if (headings.length !== 1 || owner.querySelectorAll("h1").length !== 1 || times.length !== 1 || bodies.length !== 1) return null;
  const title = clean(headings[0].textContent), current = instant(times[0].getAttribute("datetime"));
  if (title.length < 12 || title.length > 220 || !current) return null;
  let records;
  try { records = [...document.querySelectorAll('script[type="application/ld+json"]')].map(node => JSON.parse(node.textContent)); } catch { return null; }
  const articles = records.filter(item => item?.["@type"] === "NewsArticle"), blogs = records.filter(item => item?.["@type"] === "LiveBlogPosting");
  if (articles.length !== 1 || blogs.length !== 1) return null;
  const article = articles[0], blog = blogs[0], first = instant(article.datePublished), latest = instant(article.dateModified);
  if (clean(article.headline) !== title || clean(blog.headline) !== title || article.mainEntityOfPage?.["@id"] !== identity.canonical || blog.url !== identity.canonical || blog.mainEntityOfPage?.["@id"] !== identity.canonical || !first || latest !== current || Date.parse(first) > Date.parse(current) || instant(blog.datePublished) !== first) return null;
  const publisher = article.publisher, provider = article.provider;
  const publisherNames = identity.regional ? ["Yahoo! Finance Canada", "Yahoo Finance Canada"] : ["Yahoo Finance", "Yahoo! Finance"];
  if (publisher?.["@type"] !== "Organization" || !publisherNames.includes(publisher.name) || publisher.url !== new URL(source).origin + "/" || provider?.["@type"] !== "Organization" || provider.name !== "Yahoo Finance" || !["https://finance.yahoo.com/", "http://finance.yahoo.com/"].includes(provider.url)) return null;
  const author = article.author;
  if (author?.["@type"] !== "Person" || !clean(author.name) || !/^https:\/\/finance\.yahoo\.com\/author\/[a-z0-9-]+\/$/u.test(author.url ?? "") || ![...owner.querySelectorAll('.byline-attr a[href*="/author/"]')].some(node => {
    let url; try { url = new URL(node.getAttribute("href"), source); } catch { return false; }
    return clean(node.textContent) === clean(author.name) && url.protocol === "https:" && ["finance.yahoo.com", "ca.finance.yahoo.com"].includes(url.hostname) && url.pathname.replace(/\/$/u, "") === new URL(author.url).pathname.replace(/\/$/u, "");
  })) return null;
  // The owned wrapper contains the lead followed by the live updates and
  // hydration script. Only its direct paragraphs constitute articleBody;
  // require all of them, rather than matching a selected opening excerpt.
  const paragraphs = [...bodies[0].children].filter(node => node.tagName === "P");
  if (!paragraphs.length || typeof blog.articleBody !== "string" || compact(paragraphs.map(node => node.textContent).join("")) !== compact(blog.articleBody)) return null;
  if (!Array.isArray(blog.liveBlogUpdate) || !blog.liveBlogUpdate.length || blog.liveBlogUpdate.some(update => !instant(update.datePublished) || Date.parse(update.datePublished) > Date.parse(current) || (update.dateModified != null && (!instant(update.dateModified) || Date.parse(update.dateModified) < Date.parse(update.datePublished) || Date.parse(update.dateModified) > Date.parse(current))))) return null;
  const posts = [...bodies[0].querySelectorAll(".liveblog-posts .liveblog-list > li.caas-liveblogpost")];
  if (posts.length !== blog.liveBlogUpdate.length || posts.some((post, index) => {
    const headings = [...post.querySelectorAll("h2.headline")], clocks = [...post.querySelectorAll("time.liveblogpost-relative-time")];
    const time = clocks.length === 1 ? livePostTime(clocks[0].textContent) : null;
    return headings.length !== 1 || clean(headings[0].textContent) !== clean(blog.liveBlogUpdate[index].headline) || !time || Date.parse(time) > Date.parse(blog.liveBlogUpdate[index].datePublished);
  })) return null;
  for (const [property, expected] of [["article:published_time", first], ["article:modified_time", current]]) {
    if ([...document.head.querySelectorAll(`meta[property="${property}"]`)].some(node => instant(node.content) !== expected)) return null;
  }
  // The record dates the current entire article. It deliberately grants no
  // pre-close timestamp to a paragraph or an earlier live-post heading.
  return { version: YAHOO_LIVE_ARTICLE_VERSION, title, canonical: identity.canonical, initialPublishedAt: first, currentVersionAt: current, origin: { key: "publisher:finance.yahoo.com", identified: true, basis: "original_reporting" } };
}
