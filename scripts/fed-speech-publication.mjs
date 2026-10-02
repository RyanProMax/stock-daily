import { JSDOM } from "jsdom";

export const FED_SPEECH_FEED = "https://www.federalreserve.gov/feeds/speeches.xml";
export const FED_SPEECH_VERSION = "bound-fed-speech-publication-v1";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();

export function englishPublicationDate(value) {
  const match = /^([A-Za-z]+) (\d{1,2}), (20\d{2})$/u.exec(clean(value));
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (month < 0) return null;
  const date = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

export function newYorkPublicationDate(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(parsed).map(item => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function fedSpeechArticleIdentity(source) {
  let url; try { url = new URL(source); } catch { return null; }
  const match = /^\/newsevents\/speech\/([a-z]+)(20\d{6})[a-z]\.htm$/u.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.federalreserve.gov" || url.search || url.hash || url.username || url.password || !match) return null;
  return { speaker: match[1], date: match[2] };
}

export function fedSpeechArticleRecord(body, source) {
  const identity = fedSpeechArticleIdentity(source);
  if (!identity) return null;
  const document = new JSDOM(Buffer.from(body).toString("utf8")).window.document;
  const headers = document.querySelectorAll("#article > .heading");
  if (headers.length !== 1) return null;
  const titles = headers[0].querySelectorAll("h3.title"), dates = headers[0].querySelectorAll(".article__time");
  if (titles.length !== 1 || dates.length !== 1 || clean(titles[0].textContent).length < 8) return null;
  const publicationDate = englishPublicationDate(dates[0].textContent);
  if (!publicationDate || publicationDate.replaceAll("-", "") !== identity.date) return null;
  return { title: clean(titles[0].textContent), speaker: identity.speaker, publicationDate };
}

export function fedSpeechPublicationRecord(articleBody, feedBody, source) {
  const article = fedSpeechArticleRecord(articleBody, source);
  if (!article) return null;
  let document; try { document = new JSDOM(Buffer.from(feedBody).toString("utf8"), { contentType: "text/xml" }).window.document; } catch { return null; }
  const matches = [...document.querySelectorAll("rss > channel > item")].filter(item => [...item.querySelectorAll(":scope > link, :scope > guid")].some(node => clean(node.textContent) === source));
  if (matches.length !== 1) return null;
  const item = matches[0];
  if (["title", "link", "guid", "category", "pubDate"].some(name => item.querySelectorAll(`:scope > ${name}`).length !== 1)) return null;
  const get = name => clean(item.querySelector(`:scope > ${name}`).textContent);
  const title = /^([^,]+), (.+)$/u.exec(get("title"));
  if (get("link") !== source || get("guid") !== source || get("category") !== "Speech" || !title || title[1].toLowerCase() !== article.speaker || title[2] !== article.title) return null;
  const raw = get("pubDate"), clock = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (20\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d (?:GMT|UTC|[+-](?:[01]\d|2[0-3])[0-5]\d)$/u.exec(raw);
  if (!clock || !Number.isFinite(Date.parse(raw))) return null;
  const month = MONTHS.findIndex(value => value.startsWith(clock[3]));
  const calendarDate = `${clock[4]}-${String(month + 1).padStart(2, "0")}-${clock[2].padStart(2, "0")}`;
  const calendar = new Date(`${calendarDate}T12:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== calendarDate || new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(calendar) !== clock[1]) return null;
  const publishedAt = new Date(raw).toISOString();
  if (newYorkPublicationDate(publishedAt) !== article.publicationDate) return null;
  return { version: FED_SPEECH_VERSION, ...article, publishedAt, metadataUrl: FED_SPEECH_FEED, timeBasis: "official_rss_publication" };
}

export function fedSpeechRecordFromOpened(opened) {
  const receipts = (opened.metadataReceipts ?? []).filter(item => item.finalUrl === FED_SPEECH_FEED);
  if (receipts.length !== 1 || !Buffer.isBuffer(opened.rawBody) || !Buffer.isBuffer(receipts[0].rawBody) || receipts[0].status < 200 || receipts[0].status >= 300 || !/^(?:application|text)\/xml(?:;|$)/iu.test(receipts[0].contentType)) return null;
  return fedSpeechPublicationRecord(opened.rawBody, receipts[0].rawBody, opened.finalUrl);
}
