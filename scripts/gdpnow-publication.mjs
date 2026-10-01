import { JSDOM } from "jsdom";

export const GDP_NOW_URL = "https://www.atlantafed.org/research-and-data/data/gdpnow";
export const GDP_NOW_COMMENTARIES = `${GDP_NOW_URL}/current-and-past-gdpnow-commentaries`;
export const GDP_NOW_FEED = "https://www.atlantafed.org/rss/GDPNow";
export const GDP_NOW_EVIDENCE_VERSION = "verified-gdpnow-update-v1";
const TITLE = "Current and Past GDPNow Commentaries";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const QUARTERS = ["first", "second", "third", "fourth"];
const key = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();

export function isGdpNowCommentary(source) {
  try { const url = new URL(source); return url.hostname === "www.atlantafed.org" && url.pathname === new URL(GDP_NOW_COMMENTARIES).pathname; } catch { return false; }
}

function calendar(month, day, year) {
  const index = MONTHS.indexOf(month);
  if (index < 0) return null;
  const date = `${year}-${String(index + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return Number.isFinite(Date.parse(date)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
}

// This rolling page contains many vintages. Only its uniquely identified
// latest dated commentary can use the current publication record.
export function gdpNowCommentaryRecord(body, source) {
  if (source !== GDP_NOW_COMMENTARIES) return null;
  const document = new JSDOM(Buffer.from(body).toString("utf8")).window.document;
  const headlines = [...document.querySelectorAll("h1")];
  const identities = document.querySelectorAll('meta[property="og:url"]');
  const titles = document.querySelectorAll('meta[property="og:title"]');
  if (headlines.length !== 1 || key(headlines[0].textContent) !== TITLE || identities.length !== 1 || identities[0].getAttribute("content") !== source || titles.length !== 1 || titles[0].getAttribute("content") !== TITLE) return null;
  const headings = [...document.querySelectorAll("h2")].map(heading => ({ heading, date: /^([A-Za-z]+) (\d{1,2}), (20\d{2})$/u.exec(key(heading.textContent)) })).filter(item => item.date);
  const dates = headings.map(({ date }) => calendar(date[1], date[2], date[3]));
  if (!dates.length || dates.some((date, index) => !date || (index && date >= dates[0]))) return null;
  // Historic entries have different wording and even native typographical
  // errors. Only a unique newest first entry can supply the latest quote.
  const { heading, date } = headings[0];
  const paragraph = heading.nextElementSibling;
  if (paragraph?.tagName !== "P" || paragraph.querySelector("script,style,noscript,template,[hidden],[aria-hidden='true']")) return null;
  const quote = key(paragraph.textContent);
  const estimate = /^The (?:initial |final )?GDPNow model estimate for real GDP growth \(seasonally adjusted annual rate\) in the (first|second|third|fourth) quarter of (20\d{2}) is (-?\d+(?:\.\d+)?) percent on ([A-Za-z]+) (\d{1,2})(?=[,. ])/u.exec(quote);
  if (!estimate || estimate[4] !== date[1] || Number(estimate[5]) !== Number(date[2])) return null;
  return { updateDate: dates[0], quarter: `${estimate[2]}:Q${QUARTERS.indexOf(estimate[1]) + 1}`, quarterName: estimate[1], estimatePercent: Number(estimate[3]), estimateDisplay: estimate[3], paragraph: quote };
}

export function gdpNowPublishedAtCandidates(articleBody, feedBody, source) {
  const record = gdpNowCommentaryRecord(articleBody, source);
  if (!record) return [];
  let document;
  try { document = new JSDOM(Buffer.from(feedBody).toString("utf8"), { contentType: "text/xml" }).window.document; } catch { return []; }
  if (["rss > channel", "rss > channel > title", "rss > channel > link"].some(selector => document.querySelectorAll(selector).length !== 1) || key(document.querySelector("rss > channel > title")?.textContent) !== "subscribeGDPNow" || key(document.querySelector("rss > channel > link")?.textContent) !== "https://www.atlantafed.org") return [];
  const title = `Latest ${record.quarterName[0].toUpperCase() + record.quarterName.slice(1)}-Quarter GDP Growth Estimate ${record.estimateDisplay} Percent`;
  const matches = [...document.querySelectorAll("rss > channel > item")].filter(item => key(item.querySelector("title")?.textContent) === title && key(item.querySelector("link")?.textContent) === GDP_NOW_URL && key(item.querySelector("description")?.textContent.split(/\n\s*\n/u)[0]) === record.paragraph);
  if (matches.length !== 1) return [];
  const item = matches[0];
  if (["title", "link", "guid", "description", "pubDate"].some(name => item.querySelectorAll(`:scope > ${name}`).length !== 1)) return [];
  const guid = key(item.querySelector("guid")?.textContent);
  if (!new RegExp(`^${GDP_NOW_URL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\?item=[a-f0-9]{32}$`, "u").test(guid)) return [];
  const raw = key(item.querySelector("pubDate")?.textContent);
  const clock = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (20\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d (?:EST|EDT|GMT|UTC|[+-](?:0\d|1[0-4])[0-5]\d)$/u.exec(raw);
  if (!clock || !Number.isFinite(Date.parse(raw)) || /[+-]14(?!00$)/u.test(raw)) return [];
  const date = calendar(MONTHS.find(month => month.startsWith(clock[3])), clock[2], clock[4]);
  if (date !== record.updateDate || new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`)) !== clock[1]) return [];
  // EST is a literal UTC-5 label, including summer. Never silently repair it
  // to EDT or assume the website's intended local time.
  return [new Date(raw).toISOString()];
}

export function gdpNowForecastDefinition(record) {
  return { version: GDP_NOW_EVIDENCE_VERSION, model: "GDPNow", nature: "model_estimate", quarter: record.quarter, updateDate: record.updateDate, estimatePercent: record.estimatePercent, unit: "percent_saar", limitation: "Running model estimate; not realized GDP or an official Atlanta Fed forecast." };
}

export function assertGdpNowCopy(copy, sources) {
  if (!sources.some(source => source.forecastDefinition?.model === "GDPNow")) return;
  if (!/GDPNow/iu.test(copy) || !/模型|估计|预测|\b(?:model|estimate|estimated|nowcast|forecast)\b/iu.test(copy)) throw new Error("GDPNow 引用须明确标注模型估计，不能写成已实现的 GDP");
}
