import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Readability } from "@mozilla/readability";
import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { classifyNewsKind } from "./market-attribution.mjs";

const execFileAsync = promisify(execFile);
const auditedNews = JSON.parse(
  await readFile(new URL("../data/audited-news.json", import.meta.url), "utf8"),
);

const USER_AGENT = "StockDaily/1.0 (+https://stock-daily-4ip.pages.dev)";
const DISCOVERY_WINDOW_MS = 96 * 60 * 60 * 1000;
const LIVE_AUDIT_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 20_000;
const MAX_CANDIDATES_PER_SOURCE = 48;
const MAX_HYDRATION_PER_MARKET = 14;
const WORD_SEGMENTER = new Intl.Segmenter(["zh", "en"], {
  granularity: "word",
});
const TITLE_STOP_WORDS = new Set([
  "after",
  "amid",
  "before",
  "chair",
  "china",
  "could",
  "determine",
  "first",
  "from",
  "fared",
  "friday",
  "into",
  "indexes",
  "major",
  "market",
  "monday",
  "news",
  "saturday",
  "said",
  "says",
  "statement",
  "stock",
  "stocks",
  "sunday",
  "that",
  "the",
  "this",
  "thursday",
  "tuesday",
  "under",
  "update",
  "wednesday",
  "with",
  "word",
  "years",
  "中国",
  "公司",
  "市场",
  "消息",
  "今日",
  "最新",
]);
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
  "mc_cid",
  "mc_eid",
  "oc",
  "ref_src",
  "spm",
]);

export const NEWS_TARGET_PER_MARKET = 5;
export const NEWS_MAX_PER_MARKET = 6;

export function getNewsBudget(reportDate) {
  const weekday = new Date(`${reportDate}T12:00:00Z`).getUTCDay();
  return {
    minimumPerMarket: weekday === 0 || weekday === 6 ? 3 : 4,
    targetPerMarket: NEWS_TARGET_PER_MARKET,
    maximumPerMarket: NEWS_MAX_PER_MARKET,
  };
}

export const NEWS_SOURCES = Object.freeze([
  {
    id: "nbs-latest",
    label: "国家统计局",
    type: "rss",
    url: "https://www.stats.gov.cn/sj/zxfb/rss.xml",
    regions: ["CN"],
    tier: "official",
    timezoneOffset: "+08:00",
  },
  {
    id: "nbs-interpretation",
    label: "国家统计局",
    type: "rss",
    url: "https://www.stats.gov.cn/sj/sjjd/rss.xml",
    regions: ["CN"],
    tier: "official",
    timezoneOffset: "+08:00",
  },
  {
    id: "wallstreetcn-a-stock",
    label: "华尔街见闻",
    type: "wallstreetcn",
    channel: "a-stock-channel",
    regions: ["CN"],
    tier: "publisher",
  },
  {
    id: "wallstreetcn-us-stock",
    label: "华尔街见闻",
    type: "wallstreetcn",
    channel: "us-stock-channel",
    regions: ["US"],
    tier: "publisher",
  },
  {
    id: "cls-telegraph",
    label: "财联社",
    type: "cls",
    regions: ["CN"],
    tier: "publisher",
  },
  {
    id: "federal-reserve",
    label: "Federal Reserve",
    type: "rss",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    regions: ["US"],
    tier: "official",
  },
  {
    id: "bea-releases",
    label: "U.S. Bureau of Economic Analysis",
    type: "bea",
    url: "https://www.bea.gov/news/current-releases",
    regions: ["US"],
    tier: "official",
  },
  {
    id: "sec-press",
    label: "U.S. Securities and Exchange Commission",
    type: "rss",
    url: "https://www.sec.gov/news/pressreleases.rss",
    regions: ["US"],
    tier: "official",
  },
  {
    id: "eia-press",
    label: "U.S. Energy Information Administration",
    type: "rss",
    url: "https://www.eia.gov/rss/press_rss.xml",
    regions: ["US"],
    tier: "official",
  },
  {
    id: "marketwatch",
    label: "MarketWatch",
    type: "rss",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    regions: ["US"],
    tier: "publisher",
  },
  {
    id: "wsj-markets",
    label: "The Wall Street Journal",
    type: "rss",
    url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    regions: ["US"],
    tier: "publisher",
  },
  {
    id: "yahoo-finance",
    label: "Yahoo Finance",
    type: "rss",
    url: "https://finance.yahoo.com/news/rssindex",
    regions: ["US"],
    tier: "publisher",
  },
]);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function compactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => typeof value === "string"),
  );
}

async function fetchText(url, { headers = {}, source = "source" } = {}) {
  const requestHeaders = compactHeaders({
    Accept: "*/*",
    "User-Agent": USER_AGENT,
    ...headers,
  });
  let fetchError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: requestHeaders,
        redirect: "follow",
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        body: await response.text(),
        finalUrl: response.url,
        contentType: response.headers.get("content-type") ?? "",
      };
    } catch (error) {
      fetchError = error;
      if (attempt === 0) await delay(250);
    }
  }

  try {
    const curlHeaders = Object.entries(requestHeaders).flatMap(([key, value]) => [
      "--header",
      `${key}: ${value}`,
    ]);
    const result = await execFileAsync(
      "curl",
      [
        "-L",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        String(SOURCE_TIMEOUT_MS / 1000),
        ...curlHeaders,
        url,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return { body: result.stdout, finalUrl: url, contentType: "" };
  } catch (curlError) {
    throw new Error(
      `${source}: ${safeError(fetchError)}; curl ${safeError(curlError)}`,
    );
  }
}

function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textValue).find(Boolean) ?? "";
  }
  if (typeof value === "object") {
    return textValue(
      value["#text"] ??
        value["#cdata"] ??
        value._text ??
        value.value ??
        value.title,
    );
  }
  return "";
}

function plainText(value) {
  if (typeof value !== "string") return "";
  return (JSDOM.fragment(value).textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTextKey(value) {
  return plainText(String(value))
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function cleanTitle(value, sourceId = "") {
  let title = plainText(textValue(value)).slice(0, 240);
  if (sourceId.startsWith("google-news")) {
    title = title.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/u, "").trim();
  }
  return title;
}

export function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || TRACKING_PARAMETERS.has(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLocaleLowerCase();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function usefulFacts(value, title) {
  if (typeof value !== "string") return "";
  const facts = plainText(value).slice(0, 900);
  if (facts.length < 30) return "";
  const normalizedFacts = normalizeTextKey(facts);
  const normalizedTitle = normalizeTextKey(title);
  if (
    normalizedFacts === normalizedTitle ||
    normalizedFacts.replace(normalizedTitle, "").length < 18
  ) {
    return "";
  }
  if (
    /^(sign up|subscribe|read more|click here|latest news|breaking news|点击查看|查看更多|责任编辑)/iu.test(
      facts,
    )
  ) {
    return "";
  }
  if (
    /comprehensive up-to-date news coverage|aggregated from sources all over the world|enable javascript and cookies|access denied|robot check|captcha|markets are gearing up|continue\s*[»›]|rare signal is flashing|double down signal|total conviction/iu.test(
      facts,
    )
  ) {
    return "";
  }
  const factKey = normalizeTextKey(facts);
  const titleTerms = [...WORD_SEGMENTER.segment(plainText(title))]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.toLocaleLowerCase())
    .filter((term) => {
      const normalized = normalizeTextKey(term);
      return (
        !/^\d+(?:\.\d+)?$/u.test(term) &&
        !TITLE_STOP_WORDS.has(term) &&
        (/[^\x00-\x7F]/u.test(term)
          ? normalized.length >= 2
          : normalized.length >= 4)
      );
    });
  const matchingTerms = titleTerms.filter((term) =>
    factKey.includes(normalizeTextKey(term)),
  );
  const requiredTermMatches = /[^\x00-\x7F]/u.test(title)
    ? Math.min(1, titleTerms.length)
    : Math.min(2, titleTerms.length);
  if (
    titleTerms.length > 0 &&
    matchingTerms.length < requiredTermMatches
  ) {
    return "";
  }
  return facts;
}

function nodeLink(value) {
  for (const link of Array.isArray(value) ? value : [value]) {
    if (typeof link === "string" && link.startsWith("http")) return link;
    if (link && typeof link === "object") {
      const href = link["@_href"] ?? link.href ?? textValue(link);
      const relation = link["@_rel"] ?? link.rel ?? "alternate";
      if (
        typeof href === "string" &&
        href.startsWith("http") &&
        (!relation || relation === "alternate")
      ) {
        return href;
      }
    }
  }
  return "";
}

function parsePublishedAt(value, timezoneOffset) {
  const dateText = textValue(value).trim();
  if (!dateText) return Number.NaN;
  if (
    timezoneOffset &&
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/u.test(dateText)
  ) {
    return Date.parse(`${dateText.replace(" ", "T")}${timezoneOffset}`);
  }
  if (/^\d{13}$/u.test(dateText)) return Number(dateText);
  if (/^\d{10}$/u.test(dateText)) return Number(dateText) * 1000;
  return Date.parse(dateText);
}

function feedEntries(parsed) {
  const channel = Array.isArray(parsed?.rss?.channel)
    ? parsed.rss.channel[0]
    : parsed?.rss?.channel;
  if (channel) return channel.item ?? [];
  if (parsed?.feed) return parsed.feed.entry ?? [];
  const rdf = parsed?.["rdf:RDF"] ?? parsed?.RDF;
  return rdf?.item ?? [];
}

export function parseFeed(
  xml,
  source,
  now = Date.now(),
  regions = ["US"],
  options = {},
) {
  const parser = new XMLParser({
    attributeNamePrefix: "@_",
    cdataPropName: "#cdata",
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
    textNodeName: "#text",
    trimValues: true,
  });
  const parsed = parser.parse(xml);
  const entries = feedEntries(parsed);
  const items = Array.isArray(entries) ? entries : entries ? [entries] : [];
  const cutoff = now - DISCOVERY_WINDOW_MS;
  const sourceId = options.sourceId ?? source;

  return items
    .map((entry) => {
      const title = cleanTitle(entry.title, sourceId);
      const url = canonicalizeUrl(
        nodeLink(entry.link) ||
          textValue(entry.guid) ||
          textValue(entry.id),
      );
      const dateText = textValue(
        entry.pubDate ??
          entry.pubTime ??
          entry.published ??
          entry.updated ??
          entry["dc:date"] ??
          entry.date,
      );
      const timestamp = parsePublishedAt(
        dateText,
        options.timezoneOffset,
      );
      const facts = usefulFacts(
        textValue(
          entry.description ??
            entry.summary ??
            entry["content:encoded"] ??
            entry.content,
        ),
        title,
      );
      const entrySource = cleanTitle(entry.source) || source;

      if (
        title.length < 8 ||
        !url.startsWith("https://") ||
        !Number.isFinite(timestamp) ||
        timestamp < cutoff ||
        timestamp > now
      ) {
        return null;
      }
      return {
        title,
        url,
        source: entrySource,
        publishedAt: new Date(timestamp).toISOString(),
        regions: [...regions],
        ...(facts ? { facts } : {}),
        _sourceId: sourceId,
        _tier:
          entrySource !== source ? "discovery" : options.tier ?? "publisher",
      };
    })
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES_PER_SOURCE);
}

function titleFromFacts(value) {
  const firstSentence = plainText(value).split(/(?<=[。！？!?])\s*/u)[0] ?? "";
  return firstSentence.slice(0, 90);
}

const CN_MARKET_PATTERN =
  /\ba[- ]?shares?\b|\bchina\b|a股|上证|沪指|深证|创业板|科创板|沪深|北证|港股|恒生|中国|我国|国产|国内(?:市场|经济|企业|产业|需求|消费|生产)|人民币|央行|人民银行|证监会|中基协|中证|国务院|国家统计局|发改委|商务部|财政部|工信部|上交所|深交所|港交所/u;
const US_MARKET_PATTERN =
  /\bu\.?s\.?\b|\bwall street\b|\bnasdaq\b|\bs&p\b|\bdow\b|\btreasur|\bfederal reserve\b|\bsec\b|\beia\b|\balphabet\b|\bgoogle\b|\btesla\b|\bapple\b|\bmicrosoft\b|\bnvidia\b|\bmeta\b|\bamazon\b|美股|美国|华尔街|纳斯达克|标普|道琼斯|美联储|美债/u;

export function classifyMarketRegions(value, fallbackRegions = []) {
  const text = plainText(value).toLocaleLowerCase();
  const regions = [];
  if (CN_MARKET_PATTERN.test(text)) regions.push("CN");
  if (US_MARKET_PATTERN.test(text)) regions.push("US");
  return regions.length > 0
    ? regions
    : [...new Set(fallbackRegions)].filter(
        (region) => region === "CN" || region === "US",
      );
}

async function fetchWallstreetCn(source, referenceTime) {
  const url = new URL(
    "https://api-one.wallstcn.com/apiv1/content/lives",
  );
  url.searchParams.set("channel", source.channel);
  url.searchParams.set("limit", "100");
  const response = await fetchText(url, {
    headers: { Accept: "application/json" },
    source: source.label,
  });
  const payload = JSON.parse(response.body);
  const cutoff = referenceTime - DISCOVERY_WINDOW_MS;

  return (payload?.data?.items ?? [])
    .map((entry) => {
      const timestamp = Number(entry.display_time) * 1000;
      const rawFacts = plainText(entry.content_text ?? entry.content ?? "");
      const title = cleanTitle(entry.title) || titleFromFacts(rawFacts);
      const facts = usefulFacts(rawFacts, title);
      const regions = classifyMarketRegions(
        `${title} ${rawFacts.slice(0, 500)}`,
        source.regions,
      );
      if (
        title.length < 8 ||
        !entry.uri?.startsWith("https://") ||
        !Number.isFinite(timestamp) ||
        timestamp < cutoff ||
        timestamp > referenceTime
      ) {
        return null;
      }
      return {
        title,
        url: canonicalizeUrl(entry.uri),
        source: source.label,
        publishedAt: new Date(timestamp).toISOString(),
        regions,
        ...(facts ? { facts } : {}),
        _sourceId: source.id,
        _tier: source.tier,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES_PER_SOURCE);
}

async function fetchCls(source, referenceTime) {
  const cutoff = referenceTime - DISCOVERY_WINDOW_MS;
  const entries = [];
  let cursor = Math.floor(referenceTime / 1000);

  for (let page = 0; page < 2; page += 1) {
    const parameters = new URLSearchParams({
      appName: "CailianpressWeb",
      last_time: String(cursor),
      os: "web",
      refresh_type: "1",
      rn: "30",
      sv: "7.7.5",
    });
    parameters.sort();
    const sha1 = createHash("sha1").update(parameters.toString()).digest("hex");
    parameters.append("sign", createHash("md5").update(sha1).digest("hex"));
    const url = new URL("https://www.cls.cn/v1/roll/get_roll_list");
    url.search = parameters;
    const response = await fetchText(url, {
      headers: {
        Accept: "application/json",
        Referer: "https://www.cls.cn/telegraph",
      },
      source: source.label,
    });
    const rows = JSON.parse(response.body)?.data?.roll_data ?? [];
    if (rows.length === 0) break;
    entries.push(...rows);
    cursor = Math.min(...rows.map((entry) => Number(entry.ctime))) - 1;
    if (cursor * 1000 < cutoff) break;
  }

  return entries
    .map((entry) => {
      const timestamp = Number(entry.ctime) * 1000;
      const rawFacts = plainText(entry.brief ?? entry.content ?? "");
      const title =
        cleanTitle(entry.title) ||
        cleanTitle(rawFacts.match(/^【([^】]+)】/u)?.[1]) ||
        titleFromFacts(rawFacts);
      const facts = usefulFacts(rawFacts, title);
      const urlValue = `https://www.cls.cn/detail/${entry.id}`;
      const regions = classifyMarketRegions(
        `${title} ${rawFacts.slice(0, 500)}`,
        Array.isArray(entry.stock_list) && entry.stock_list.length > 0
          ? source.regions
          : [],
      );
      if (
        entry.is_ad ||
        regions.length === 0 ||
        title.length < 8 ||
        !urlValue.startsWith("https://") ||
        !Number.isFinite(timestamp) ||
        timestamp < cutoff ||
        timestamp > referenceTime
      ) {
        return null;
      }
      return {
        title,
        url: canonicalizeUrl(urlValue),
        source: source.label,
        publishedAt: new Date(timestamp).toISOString(),
        regions,
        ...(facts ? { facts } : {}),
        _sourceId: source.id,
        _tier: source.tier,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES_PER_SOURCE);
}

export function parseBeaReleases(
  html,
  source,
  referenceTime = Date.now(),
) {
  const cutoff = referenceTime - DISCOVERY_WINDOW_MS;
  const document = new JSDOM(html, { url: source.url }).window.document;
  return [...document.querySelectorAll("tr.release-row")]
    .map((row) => {
      const link = row.querySelector("a[href]");
      const time = row.querySelector("time[datetime]");
      const title = cleanTitle(link?.textContent ?? "", source.id);
      const timestamp = Date.parse(time?.getAttribute("datetime") ?? "");
      let url = "";
      try {
        url = canonicalizeUrl(
          new URL(link?.getAttribute("href") ?? "", source.url),
        );
      } catch {
        return null;
      }
      if (
        title.length < 8 ||
        !url.startsWith("https://") ||
        !Number.isFinite(timestamp) ||
        timestamp < cutoff ||
        timestamp > referenceTime
      ) {
        return null;
      }
      return {
        title,
        url,
        source: source.label,
        publishedAt: new Date(timestamp).toISOString(),
        regions: [...source.regions],
        _sourceId: source.id,
        _tier: source.tier,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES_PER_SOURCE);
}

async function fetchBeaReleases(source, referenceTime) {
  const response = await fetchText(source.url, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    source: source.label,
  });
  return parseBeaReleases(response.body, source, referenceTime);
}

async function fetchSource(source, referenceTime) {
  if (source.type === "wallstreetcn") {
    return fetchWallstreetCn(source, referenceTime);
  }
  if (source.type === "cls") {
    return fetchCls(source, referenceTime);
  }
  if (source.type === "bea") {
    return fetchBeaReleases(source, referenceTime);
  }
  const response = await fetchText(source.url, {
    headers: {
      Accept:
        "application/atom+xml, application/rss+xml, application/xml, text/xml",
    },
    source: source.label,
  });
  return parseFeed(
    response.body,
    source.label,
    referenceTime,
    source.regions,
    {
      sourceId: source.id,
      tier: source.tier,
      timezoneOffset: source.timezoneOffset,
    },
  );
}

export async function discoverNewsCandidates(referenceTime = Date.now()) {
  const sources = await Promise.all(
    NEWS_SOURCES.map(async (source) => {
      const startedAt = Date.now();
      try {
        const items = await fetchSource(source, referenceTime);
        return {
          id: source.id,
          status: "ok",
          candidateCount: items.length,
          durationMs: Date.now() - startedAt,
          items,
        };
      } catch (error) {
        return {
          id: source.id,
          status: "error",
          candidateCount: 0,
          durationMs: Date.now() - startedAt,
          error: safeError(error),
          items: [],
        };
      }
    }),
  );
  return {
    candidates: sources.flatMap((source) => source.items),
    sources,
  };
}

function sourceScore(item) {
  if (item._tier === "audited") return 16;
  if (item._tier === "official") return 8;
  if (item._tier === "publisher") return 2;
  return -3;
}

export function relevanceScore(item) {
  const title = plainText(item.title).toLocaleLowerCase();
  const facts = plainText(item.facts ?? "").toLocaleLowerCase();
  const haystack = `${title} ${facts.slice(0, 360)}`;
  const signals = [
    [
      /\bstock market\b|\bnasdaq\b|\bs&p\b|\bdow\b|a股|上证|沪指|深证|创业板|科创板|沪深\s*300|北证|两市|成交额|北向资金|美股|华尔街/u,
      8,
    ],
    [
      /\bfederal reserve\b|\bfed\b|\btreasury\b|\byield\b|\binflation\b|\binterest rate\b|\becb\b|\bboj\b|央行|人民银行|利率|通胀|国债|收益率|人民币/u,
      7,
    ],
    [
      /\bgdp\b|\bjobs\b|\bpayroll\b|\bunemployment\b|\bconsumer spending\b|工业增加值|社会消费品|零售额|就业|失业率|外资|房地产|经济增长/u,
      6,
    ],
    [
      /\boil\b|\bopec\b|\bgold\b|\bsilver\b|\bcopper\b|原油|油价|黄金|白银|铜价|有色|煤炭|天然气/u,
      5,
    ],
    [
      /\bbig tech\b|\bai\b|\bsemiconductor\b|\bnvidia\b|\bapple\b|\bmicrosoft\b|\balphabet\b|\bamazon\b|\btesla\b|\bmeta\b|人工智能|半导体|芯片|新能源|汽车|医药|银行|券商|保险/u,
      5,
    ],
    [
      /\btariff\b|\btrade deal\b|\bsanction\b|\bgeopolit|关税|贸易|制裁|出口|进口|供应链/u,
      5,
    ],
    [
      /\bearnings\b|\bguidance\b|\brevenue\b|\bprofit\b|\bforecast\b|财报|业绩|营收|净利润|预增|预亏|回购|增持|并购|重组|ipo/u,
      5,
    ],
    [
      /\bsec\b|\beia\b|证监会|国务院|国家统计局|发改委|商务部|财政部|交易所/u,
      4,
    ],
  ];
  const penalties = [
    [
      /\binheritance\b|\bsocial security\b|\bretirement\b|\bwedding\b|\badhd\b|\bmy home\b|\bshould i\b|\blife savings\b|\bfinancial adviser\b|\bpersonal finance\b/u,
      -14,
    ],
    [
      /\betfs?\b|\bstocks? to (buy|watch)\b|\bworth (watching|buying)\b|\binvestment opportunit|\bwinners may\b|\bbetter buy\b|\bbuy now\b|\btime to buy\b|\bnext big .{0,12} stock\b|\blooks? attractive\b|牛股|荐股|抄底|买入评级|目标价|值得买|投资机会/u,
      -14,
    ],
    [
      /\bcathie wood\b|\bark invest\b|\bbeaten-down\b|\buys? .{0,24}\bstock\b|\bstrategist\b|\bportfolio manager\b|券商研报|机构认为|分析师(?:认为|看好|称|表示|[:：])|证券认为|研报认为|首席投资官|首席策略师|市场策略师/u,
      -14,
    ],
    [
      /(?:venture capital|风险投资).{0,24}(?:partner|合伙人).{0,24}(?:said|表示)/u,
      -14,
    ],
    [
      /^(?:中信|国泰|海通|华泰|申万|招商|银河|广发|光大).{0,16}[：:].{0,12}(?:看好|建议|预计|观点)/u,
      -16,
    ],
    [
      /\bopportunit(?:y|ies) to buy\b|\bbuy .{0,30} before\b|\bto buy before\b|首席投资官|首席策略师|市场策略师/u,
      -16,
    ],
    [
      /电报解读|这家公司|另一家|全面切入.{0,20}供应链|目标公司/u,
      -22,
    ],
    [
      /\bannounces? departure\b|\bsteps? down\b|\bappoints?\b|\bnames? .{0,30} (?:director|officer|chief)\b|离任|卸任|任命|人事变动/u,
      -18,
    ],
    [
      /\bapproval rating\b|\bopinion poll\b|\belection poll\b|选举|民调|支持率/u,
      -14,
    ],
    [
      /\bquietest\b|\bhuge bullish signal\b|\bsecret\b|\bgiant\b|\breality check\b|重磅|突发/u,
      -6,
    ],
    [
      /十大消息|早报|周末股市|消息速报|资讯一览|一周市场|weekly review/u,
      -22,
    ],
    [/新闻联播|要闻\d+条|主要内容有/u, -24],
    [
      /(?:提醒[:：]?)?下周.{0,20}(?:大事|提醒|日历|发布业绩报告)|大事提醒|业绩日历|earnings calendar|will (?:release|report) (?:results|earnings)/u,
      -18,
    ],
    [
      /近\d+家|不完全统计|本周披露.{0,20}(?:公告|进展)|最新公告汇总/u,
      -14,
    ],
    [
      /ipo.*(?:受理|注册|辅导)|(?:受理|同意|启动).{0,12}ipo|上市聆讯|新股申购|发行申请|辅导备案/u,
      -12,
    ],
    [
      /\bprice forecast\b|\bcan .{0,24} extend gains\b|\bworst-case scenario\b|走势预测|后市预测/u,
      -10,
    ],
    [/\bearnings call summary\b|\bconference call summary\b|\btranscript\b/u, -8],
    [/\bcorn\b|\bsoybean/u, -3],
    [/\broundup\b|\bmarket talk\b/u, -4],
  ];

  const matchedSignals = signals
    .filter(([pattern]) => pattern.test(haystack))
    .map(([, weight]) => weight)
    .sort((left, right) => right - left);
  const signalScore = matchedSignals
    .slice(0, 3)
    .reduce(
      (score, weight, index) => score + (index === 0 ? weight : Math.min(weight, 3)),
      0,
    );
  const penaltyScore = penalties.reduce(
    (score, [pattern, weight]) =>
      score + (pattern.test(haystack) ? weight : 0),
    0,
  );

  return (
    signalScore +
    penaltyScore +
    sourceScore(item) +
    (usefulFacts(item.facts, item.title) ? 2 : 0) -
    (/\/personal-finance\//u.test(item.url) ? 14 : 0)
  );
}

export function isOpinionNoise(item) {
  const title = plainText(item.title).toLocaleLowerCase();
  const facts = plainText(item.facts ?? "").toLocaleLowerCase();
  const chineseOpinionTitle =
    /(?:投资人|私募|机构|投行|券商|证券|银行|分析师|策略师|市场情报团队|研究团队|摩根大通|高盛|花旗|美银|瑞银|野村).{0,30}(?:认为|表示|称|发声|观点|看好|建议|预计|推演|情景|预测|研判)|(?:对股市|对a股|对美股).{0,16}(?:最为有利|最佳结果|最糟糕结果)/u;
  const englishOpinionTitle =
    /\b(?:analyst|strategist|portfolio manager|chief investment officer|jpmorgan|goldman sachs|citigroup|bank of america|ubs|nomura)\b.{0,48}\b(?:says?|sees?|expects?|predicts?|forecasts?|recommends?|scenario)\b/u;
  const pendingEventPreviewTitle =
    /^(?:fed meeting live|federal reserve live|美联储(?:会议|决议)(?:直播|前瞻))|(?:\bfed(?:eral reserve)?\b|美联储).{0,42}(?:\bexpected to (?:hold|cut|raise)\b|预计(?:按兵不动|降息|加息))/u;
  const personalCommentaryFacts =
    /(?:知名)?(?:私募)?投资人.{0,18}(?:密集发声|朋友圈发文|个人观点)|(?:朋友圈|社交平台).{0,12}(?:发文|表示).{0,28}(?:产业|市场|股市|a股|美股)/u;
  const analystRatingFacts =
    /\b(?:buy|sell|hold|overweight|underweight) rating\b|\bprice target\b|\bmarket overreacting\b|买入评级|卖出评级|目标价/u;
  const technicalPredictionTitle =
    /\b(?:bullish|bearish)\b.{0,36}\b(?:chart|pattern|shape|signal)\b|\bcharts?\b.{0,48}\b(?:signals?|suggests?|points to)\b.{0,36}\b(?:gains?|losses?|upside|downside)\b/u;
  return (
    chineseOpinionTitle.test(title) ||
    englishOpinionTitle.test(title) ||
    pendingEventPreviewTitle.test(title) ||
    technicalPredictionTitle.test(title) ||
    personalCommentaryFacts.test(facts.slice(0, 360)) ||
    analystRatingFacts.test(`${title} ${facts.slice(0, 520)}`)
  );
}

export function topicKey(value) {
  const normalized = plainText(value).toLocaleLowerCase();
  if (
    /\btreasury\b|\byield\b|\binterest rate\b|\bfederal reserve\b|\bfed\b|\becb\b|\binflation\b|\bmortgage\b|国债|收益率|利率|美联储|央行|通胀|人民币/u.test(
      normalized,
    )
  ) {
    return "rates";
  }
  if (/\bopec\b|\boil\b|\bcrude\b|欧佩克|原油|油价|天然气/u.test(normalized)) {
    return "energy";
  }
  if (/\bgold\b|\bsilver\b|\bcopper\b|黄金|白银|铜价|有色/u.test(normalized)) {
    return "metals";
  }
  if (
    /\btariff\b|\btrade deal\b|\bsanction\b|关税|贸易|制裁|出口|进口|供应链/u.test(
      normalized,
    )
  ) {
    return "trade";
  }
  if (
    /\bstock market\b|\bnasdaq\b|\bs&p\b|\bdow\b|\bbig tech\b|a股|上证|沪指|深证|创业板|科创板|沪深\s*300|美股|纳斯达克|标普|道琼斯|三大指数|成交额/u.test(
      normalized,
    )
  ) {
    return "equities";
  }
  if (
    /\bearnings\b|\bguidance\b|\brevenue\b|\bprofit\b|财报|业绩|营收|利润|回购|增持|并购|重组|ipo/u.test(
      normalized,
    )
  ) {
    return "earnings";
  }
  if (
    /\bgdp\b|\bjobs\b|\bpayroll\b|\bunemployment\b|\bconsumer spending\b|工业增加值|社会消费品|零售额|就业|失业率|外资|经济增长/u.test(
      normalized,
    )
  ) {
    return "macro";
  }
  if (
    /人工智能|半导体|芯片|新能源|汽车|医药|消费|银行|券商|保险|房地产|电力|煤炭/u.test(
      normalized,
    )
  ) {
    return "industry";
  }
  return `other:${normalizeTextKey(normalized).slice(0, 36)}`;
}

function titleSimilarity(left, right) {
  const leftKey = normalizeTextKey(left);
  const rightKey = normalizeTextKey(right);
  if (!leftKey || !rightKey) return 0;
  if (leftKey === rightKey) return 1;
  const shorter =
    leftKey.length <= rightKey.length ? leftKey : rightKey;
  const longer = shorter === leftKey ? rightKey : leftKey;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.68) {
    return 0.9;
  }
  if (shorter.length < 10) return 0;
  const leftPairs = new Set(
    Array.from({ length: leftKey.length - 1 }, (_, index) =>
      leftKey.slice(index, index + 2),
    ),
  );
  const rightPairs = new Set(
    Array.from({ length: rightKey.length - 1 }, (_, index) =>
      rightKey.slice(index, index + 2),
    ),
  );
  const overlap = [...leftPairs].filter((pair) => rightPairs.has(pair)).length;
  return (2 * overlap) / (leftPairs.size + rightPairs.size);
}

function mergeCandidate(current, incoming) {
  const currentFacts = usefulFacts(current.facts, current.title);
  const incomingFacts = usefulFacts(incoming.facts, incoming.title);
  const currentSourceScore = sourceScore(current);
  const incomingSourceScore = sourceScore(incoming);
  const preferred =
    incomingSourceScore > currentSourceScore ||
    (incomingSourceScore === currentSourceScore &&
      incomingFacts.length > currentFacts.length)
      ? incoming
      : current;
  return {
    ...preferred,
    regions: [...new Set([...current.regions, ...incoming.regions])],
    facts: incomingFacts.length > currentFacts.length ? incomingFacts : currentFacts,
  };
}

export function deduplicateNews(candidates) {
  const deduplicated = [];
  for (const candidate of candidates) {
    const regions = [...new Set(candidate.regions ?? [])].filter(
      (region) => region === "CN" || region === "US",
    );
    if (
      regions.length === 0 ||
      typeof candidate.title !== "string" ||
      typeof candidate.url !== "string"
    ) {
      continue;
    }
    const normalized = {
      ...candidate,
      title: cleanTitle(candidate.title, candidate._sourceId),
      url: canonicalizeUrl(candidate.url),
      regions,
    };
    const duplicateIndex = deduplicated.findIndex(
      (existing) =>
        existing.url === normalized.url ||
        titleSimilarity(existing.title, normalized.title) >= 0.86,
    );
    if (duplicateIndex >= 0) {
      deduplicated[duplicateIndex] = mergeCandidate(
        deduplicated[duplicateIndex],
        normalized,
      );
    } else {
      deduplicated.push(normalized);
    }
  }
  return deduplicated;
}

function stripInternalFields(item) {
  const {
    _score,
    _sourceId,
    _tier,
    ...published
  } = item;
  return published;
}

export function selectNews(
  candidates,
  {
    perMarket = NEWS_TARGET_PER_MARKET,
    minimumScore = 4,
    sourceLimit = 2,
    topicLimit = 2,
    includeInternal = false,
  } = {},
) {
  const ranked = deduplicateNews(candidates)
    .filter((item) => !isOpinionNoise(item))
    .map((item) => ({ ...item, _score: relevanceScore(item) }))
    .filter((item) => item._score >= minimumScore)
    .sort(
      (left, right) =>
        right._score - left._score ||
        right.publishedAt.localeCompare(left.publishedAt) ||
        left.source.localeCompare(right.source),
    );
  const selected = new Map();

  for (const market of ["CN", "US"]) {
    const perSource = new Map();
    const perTopic = new Map();
    const alreadySelected = [...selected.values()].filter((item) =>
      item.regions.includes(market),
    );
    for (const item of alreadySelected) {
      perSource.set(item.source, (perSource.get(item.source) ?? 0) + 1);
      const topic = topicKey(item.title);
      perTopic.set(topic, (perTopic.get(topic) ?? 0) + 1);
    }
    let marketCount = alreadySelected.length;

    for (const limits of [
      { source: sourceLimit, topic: topicLimit },
      { source: sourceLimit + 2, topic: topicLimit + 1 },
    ]) {
      for (const item of ranked) {
        if (
          marketCount >= perMarket ||
          !item.regions.includes(market) ||
          selected.has(item.url)
        ) {
          continue;
        }
        const sourceKey = item.source;
        const topic = topicKey(item.title);
        if (
          (perSource.get(sourceKey) ?? 0) >= limits.source ||
          (perTopic.get(topic) ?? 0) >= limits.topic
        ) {
          continue;
        }
        selected.set(item.url, item);
        perSource.set(sourceKey, (perSource.get(sourceKey) ?? 0) + 1);
        perTopic.set(topic, (perTopic.get(topic) ?? 0) + 1);
        marketCount += 1;
      }
      if (marketCount >= perMarket) break;
    }
  }

  return [...selected.values()].map((item) =>
    includeInternal ? item : stripInternalFields(item),
  );
}

function factsCandidates(html, title, url) {
  const candidates = [];
  const document = new JSDOM(html, { url }).window.document;
  for (const selector of [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
  ]) {
    const content = document.querySelector(selector)?.getAttribute("content");
    if (content) candidates.push(content);
  }

  try {
    const article = new Readability(document.cloneNode(true), {
      charThreshold: 80,
    }).parse();
    if (article?.excerpt) candidates.push(article.excerpt);
    if (article?.textContent) {
      candidates.push(
        ...article.textContent
          .split(/\n{2,}|(?<=[。！？.!?])\s+/u)
          .map((part) => part.trim())
          .filter(Boolean)
          .slice(0, 80),
      );
    }
  } catch {
    // Metadata and visible paragraphs remain deterministic fallbacks.
  }

  candidates.push(
    ...[...document.querySelectorAll("article p, main p, p")]
      .slice(0, 80)
      .map((paragraph) => paragraph.textContent ?? ""),
  );

  return candidates
    .map((candidate, index) => {
      const facts = usefulFacts(candidate, title);
      const directionalSignals =
        facts.match(
          /\d|rose|fell|grew|declined|increased|decreased|beat|missed|raised|lowered|增长|下降|上涨|下跌|提高|降低|改善|恶化|罚款|发布|推出/giu,
        )?.length ?? 0;
      return {
        facts,
        index,
        score:
          Math.min(directionalSignals, 8) * 5 +
          Math.min(facts.length, 500) / 30,
      };
    })
    .filter((candidate) => candidate.facts)
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

export function extractArticleFacts(html, title, url) {
  return factsCandidates(html, title, url)[0]?.facts ?? "";
}

export function shouldHydrateFacts(item, existingFacts) {
  if (!existingFacts) return true;
  if (item?._tier === "official") return true;
  if (/(?:\.{3}|…)\s*$/u.test(existingFacts)) return true;
  return existingFacts.length < 80;
}

async function hydrateNewsFacts(item) {
  const existingFacts = usefulFacts(item.facts, item.title);
  if (!shouldHydrateFacts(item, existingFacts)) {
    return { ...item, facts: existingFacts };
  }

  try {
    const response = await fetchText(item.url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      source: item.source,
    });
    const hydratedFacts = extractArticleFacts(
      response.body,
      item.title,
      response.finalUrl || item.url,
    );
    const facts = hydratedFacts || existingFacts;
    if (!facts) {
      throw new Error(`${item.source} 正文没有可核验的事实摘要：${item.title}`);
    }
    return {
      ...item,
      url: canonicalizeUrl(response.finalUrl || item.url),
      facts,
    };
  } catch (error) {
    if (existingFacts) {
      return { ...item, facts: existingFacts };
    }
    throw error;
  }
}

async function mapSettledWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          try {
            results[index] = {
              status: "fulfilled",
              value: await worker(items[index], index),
            };
          } catch (reason) {
            results[index] = { status: "rejected", reason };
          }
        }
      },
    ),
  );
  return results;
}

function validateAuditedNews(reportDate, referenceTime) {
  const entries = auditedNews[reportDate];
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const publishedAt = Date.parse(entry.publishedAt);
    if (
      typeof entry.title !== "string" ||
      !entry.url?.startsWith("https://") ||
      !entry.source ||
      !usefulFacts(entry.facts, entry.title) ||
      !Number.isFinite(publishedAt) ||
      publishedAt > referenceTime ||
      !Array.isArray(entry.regions) ||
      entry.regions.length === 0 ||
      entry.regions.some((region) => region !== "CN" && region !== "US")
    ) {
      throw new Error(`${reportDate} 的审计新闻清单存在无效字段或时间穿越`);
    }
    return {
      ...entry,
      url: canonicalizeUrl(entry.url),
      _sourceId: `audited:${entry.source}`,
      _tier: "audited",
    };
  });
}

function marketCounts(items) {
  return Object.fromEntries(
    ["CN", "US"].map((market) => [
      market,
      items.filter((item) => item.regions.includes(market)).length,
    ]),
  );
}

export async function collectNews(referenceTime = Date.now(), reportDate) {
  const budget = { ...getNewsBudget(reportDate), minimumPerMarket: 0 };
  const audited = validateAuditedNews(reportDate, referenceTime);
  const useLiveSources =
    audited.length === 0 ||
    Math.abs(Date.now() - referenceTime) <= LIVE_AUDIT_WINDOW_MS;

  const discovery = useLiveSources
    ? await discoverNewsCandidates(referenceTime)
    : { candidates: [], sources: [] };
  const sourceResults = discovery.sources;
  const discovered = discovery.candidates;
  const candidates = deduplicateNews([...audited, ...discovered]);
  const hydrationQueue = selectNews(candidates, {
    perMarket: MAX_HYDRATION_PER_MARKET,
    sourceLimit: 5,
    topicLimit: 5,
    includeInternal: true,
  });
  const hydrationResults = await mapSettledWithConcurrency(
    hydrationQueue,
    4,
    hydrateNewsFacts,
  );
  const hydrated = hydrationResults
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const selected = selectNews(hydrated, {
    perMarket: budget.targetPerMarket,
    minimumScore: 8,
    includeInternal: true,
  });
  const counts = marketCounts(selected);
  return {
    news: selected.map((item) =>
      stripInternalFields({ ...item, kind: classifyNewsKind(item) }),
    ),
    diagnostics: {
      mode:
        audited.length > 0 && useLiveSources
          ? "hybrid"
          : audited.length > 0
            ? "audited"
            : "live",
      candidateCount: candidates.length,
      hydratedCount: hydrated.length,
      rejectedDuringHydration: hydrationResults.filter(
        (result) => result.status === "rejected",
      ).length,
      selectedByMarket: counts,
      minimumPerMarket: budget.minimumPerMarket,
      targetPerMarket: budget.targetPerMarket,
      sources: sourceResults.map(({ items, ...result }) => result),
    },
  };
}
