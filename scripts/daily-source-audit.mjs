import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { GDP_NOW_FEED, gdpNowCommentaryRecord, gdpNowPublishedAtCandidates, isGdpNowCommentary } from "./gdpnow-publication.mjs";
import { sourceArticleProvenance } from "./source-article-provenance.mjs";
import { nfraDocumentIdentity, nfraDocumentRecord } from "./nfra-document.mjs";
import { pdfSourceRecord } from "./pdf-source.mjs";
import { cninfoPdfIdentity, cninfoPdfPublication } from "./cninfo-pdf-publication.mjs";
import { CNINFO_HISTORY_URL, validateCninfoHistoryBody } from "./cninfo-history-request.mjs";
import { chinaPmiDocument } from "./china-pmi-release.mjs";
import { mofDocumentIdentity, mofDocumentRecord } from "./mof-document.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_CONCURRENCY = 4;
const MAX_REDIRECTS = 8;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const DEFAULT_CURL_PATH =
  process.env.STOCK_DAILY_CURL_BIN ?? "/usr/bin/curl";
const DOH_HOSTNAME = "cloudflare-dns.com";
const DOH_ADDRESS = "1.1.1.1";
const CHINA_LOCAL_TIME_HOSTS = [
  "21jingji.com",
  "caixin.com",
  "cls.cn",
  "chnfund.com",
  "cnstock.com",
  "eastmoney.com",
  "nbd.com.cn",
  "people.com.cn",
  "sina.com.cn",
  "stcn.com",
  "thepaper.cn",
  "xinhuanet.com",
  "yicai.com",
];

function externalSources(report) {
  const items = [
    ...(Array.isArray(report?.drivers) ? report.drivers : []),
    ...(Array.isArray(report?.aiChainUpdates) ? report.aiChainUpdates : []),
  ];
  return [
    ...new Set(
      items
        .flatMap((item) => (Array.isArray(item?.evidence) ? item.evidence : []))
        .filter((item) => item?.kind !== "market_data")
        .map((item) => item?.source)
        .filter((source) => typeof source === "string" && source.trim()),
    ),
  ];
}

function ipv4Bytes(address) {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)
  ) {
    return null;
  }
  return parts.map(Number);
}

function ipv6Bytes(address) {
  if (address.includes("%")) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const embedded = ipv4Bytes(normalized.slice(lastColon + 1));
    if (!embedded) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(
      (embedded[0] << 8) |
      embedded[1]
    ).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[\da-f]{1,4}$/u.test(group))
  ) {
    return null;
  }
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function hasPrefix(bytes, prefix, bits) {
  const completeBytes = Math.floor(bits / 8);
  for (let index = 0; index < completeBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[completeBytes] & mask) === (prefix[completeBytes] & mask);
}

function ipv4InRange(bytes, prefix, bits) {
  return hasPrefix(bytes, ipv4Bytes(prefix), bits);
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    const denied = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !denied.some(([prefix, bits]) => ipv4InRange(bytes, prefix, bits));
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;
    const mappedIpv4 =
      bytes.slice(0, 10).every((byte) => byte === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;
    if (mappedIpv4) {
      return isPublicAddress(bytes.slice(12).join("."));
    }
    const globalUnicast = hasPrefix(bytes, [0x20, 0, ...Array(14).fill(0)], 3);
    const special2001 = hasPrefix(
      bytes,
      [0x20, 0x01, ...Array(14).fill(0)],
      23,
    );
    const sixToFour = hasPrefix(
      bytes,
      [0x20, 0x02, ...Array(14).fill(0)],
      16,
    );
    return globalUnicast && !special2001 && !sixToFour;
  }
  return false;
}

function normalizeHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export async function publicDestination(value, resolver) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`外部证据 URL 无效：${value}`);
  }
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password
  ) {
    throw new Error(`外部证据必须使用标准 HTTPS 地址：${value}`);
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error(`外部证据禁止访问本机或内网地址：${value}`);
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error(`外部证据禁止访问本机或内网地址：${value}`);
  }
  const destination =
    addresses.find(({ family }) => family === 4) ?? addresses[0];
  const destinations = [destination, ...addresses.filter((item) => item.address !== destination.address)];
  return { url, destination, destinations };
}

async function dohQuery(hostname, type, runner, curlPath, signal) {
  const query = new URL(`https://${DOH_HOSTNAME}/dns-query`);
  query.searchParams.set("name", hostname);
  query.searchParams.set("type", type);
  const { stdout } = await runner(
    curlPath,
    [
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "20",
      "--retry",
      "1",
      "--proto",
      "=https",
      "--connect-to",
      `${DOH_HOSTNAME}:443:${DOH_ADDRESS}:443`,
      "--proxy-header",
      `Host: ${DOH_HOSTNAME}:443`,
      "--header",
      "Accept: application/dns-json",
      query.toString(),
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024, signal },
  );
  const response = JSON.parse(stdout);
  if (response?.Status !== 0 || !Array.isArray(response?.Answer)) return [];
  const expectedType = type === "A" ? 1 : 28;
  return response.Answer
    .filter((answer) => answer?.type === expectedType && isIP(answer?.data))
    .map((answer) => ({
      address: answer.data,
      family: expectedType === 1 ? 4 : 6,
    }));
}

async function resolveWithDoh(
  hostname,
  { runner = execFileAsync, curlPath = DEFAULT_CURL_PATH, signal } = {},
) {
  const ipv4 = await dohQuery(hostname, "A", runner, curlPath, signal);
  if (ipv4.length > 0) return ipv4;
  return dohQuery(hostname, "AAAA", runner, curlPath, signal);
}

async function requestHeaders(
  value,
  destination,
  { runner = execFileAsync, curlPath = DEFAULT_CURL_PATH } = {},
) {
  const url = new URL(value);
  const hostname = normalizeHostname(url.hostname);
  const connectAddress =
    destination.family === 6
      ? `[${destination.address}]`
      : destination.address;
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const { stdout } = await runner(
    curlPath,
    [
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "30",
      "--retry",
      "1",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--connect-to",
      `${hostname}:443:${connectAddress}:443`,
      "--proxy-header",
      `Host: ${url.hostname}:443`,
      "--user-agent",
      "Mozilla/5.0 (compatible; StockDailySourceAudit/1.0)",
      "--header",
      "Accept: text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8",
      "--range",
      "0-0",
      "--output",
      nullDevice,
      "--write-out",
      "%{http_code}\t%{redirect_url}",
      url.toString(),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  const match = String(stdout).match(/^(\d{3})\t([^\r\n]*)/u);
  if (!match) throw new Error("响应状态无法识别");
  return {
    status: Number(match[1]),
    location: match[2] || undefined,
  };
}

async function requestHeadersWithNode(value, destination) {
  const url = new URL(value);
  const hostname = normalizeHostname(url.hostname);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        family: destination.family,
        servername: hostname,
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8",
          Range: "bytes=0-0",
          "User-Agent":
            "Mozilla/5.0 (compatible; StockDailySourceAudit/1.0)",
        },
        lookup: (_lookupHostname, options, callback) => {
          if (options?.all) {
            callback(null, [destination]);
            return;
          }
          callback(null, destination.address, destination.family);
        },
      },
      (response) => {
        response.resume();
        resolveRequest({
          status: Number(response.statusCode ?? 0),
          location: response.headers.location,
        });
      },
    );
    request.setTimeout(30_000, () => {
      request.destroy(new Error("Node HTTPS request timed out"));
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

async function requestContentWithNode(
  value,
  destination,
  { maxBytes = MAX_SOURCE_BYTES, signal, method = "GET", requestBody } = {},
) {
  const url = new URL(value);
  const hostname = normalizeHostname(url.hostname);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      url,
      {
        method,
        family: destination.family,
        servername: hostname,
        signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "identity",
          ...(requestBody ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Content-Length": Buffer.byteLength(requestBody) } : {}),
          "User-Agent":
            "Mozilla/5.0 (compatible; StockDailyEvidenceVerifier/1.0)",
        },
        lookup: (_lookupHostname, options, callback) => {
          if (options?.all) {
            callback(null, [destination]);
            return;
          }
          callback(null, destination.address, destination.family);
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(
              new Error(`Source body exceeds ${maxBytes} bytes`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", rejectRequest);
        response.once("end", () => {
          resolveRequest({
            status: Number(response.statusCode ?? 0),
            location: response.headers.location,
            contentType: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.setTimeout(30_000, () => {
      request.destroy(new Error("Source body request timed out"));
    });
    request.once("error", rejectRequest);
    request.end(requestBody);
  });
}

async function requestContentWithCurl(
  value,
  destination,
  {
    runner = execFileAsync,
    curlPath = DEFAULT_CURL_PATH,
    maxBytes = MAX_SOURCE_BYTES,
    signal,
    method = "GET",
    requestBody,
  } = {},
) {
  const url = new URL(value);
  const hostname = normalizeHostname(url.hostname);
  const connectAddress =
    destination.family === 6
      ? `[${destination.address}]`
      : destination.address;
  const marker = "\nSTOCK_DAILY_CONTENT_META\t";
  const { stdout } = await runner(
    curlPath,
    [
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "30",
      "--retry",
      "2",
      "--retry-all-errors",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      ...(method === "POST" ? ["--request", "POST"] : []),
      ...(requestBody ? ["--header", "Content-Type: application/x-www-form-urlencoded; charset=UTF-8", "--data-raw", requestBody] : []),
      "--connect-to",
      `${hostname}:443:${connectAddress}:443`,
      "--proxy-header",
      `Host: ${url.hostname}:443`,
      "--user-agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
      "--header",
      "Accept: text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
      "--header",
      "Accept-Encoding: identity",
      "--max-filesize",
      String(maxBytes),
      "--write-out",
      `${marker}%{http_code}\t%{redirect_url}\t%{content_type}`,
      url.toString(),
    ],
    { encoding: null, maxBuffer: maxBytes + 256 * 1024, signal },
  );
  const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const markerBuffer = Buffer.from(marker);
  const markerIndex = output.lastIndexOf(markerBuffer);
  if (markerIndex < 0) throw new Error("响应状态无法识别");
  const metadata = output
    .subarray(markerIndex + markerBuffer.length)
    .toString("utf8")
    .trim();
  const [status, location = "", contentType = ""] = metadata.split("\t");
  if (!/^\d{3}$/u.test(status)) throw new Error("响应状态无法识别");
  return {
    status: Number(status),
    location: location || undefined,
    contentType,
    body: output.subarray(0, markerIndex),
  };
}

async function requestContentWithFallback(
  value,
  destination,
  options = {},
) {
  try {
    const response = await requestContentWithNode(value, destination, options);
    if (![403, 429, 472].includes(response.status)) return response;
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    // The pinned curl request below retries transport and TLS failures.
  }
  return requestContentWithCurl(value, destination, options);
}

let entityDecoder;
function decodeHtmlEntities(value) {
  // Use the HTML standard's full entity table. In particular, &mdash; and
  // curly quote entities must compare like the visible article text.
  entityDecoder ??= new JSDOM("").window.document.createElement("textarea");
  entityDecoder.innerHTML = value;
  return entityDecoder.value;
}

function sourceEncodingCandidates(body, contentType) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headerCharset = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(
    contentType,
  )?.[1];
  const bomCharset = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? "utf-8"
    : bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
      ? "utf-16le"
      : bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))
        ? "utf-16be"
        : null;
  const htmlPrefix = bytes.subarray(0, 16 * 1024).toString("latin1");
  const metaCharset =
    /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([^\s"'/>;]+)/iu.exec(
      htmlPrefix,
    )?.[1] ??
    /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*\bcharset\s*=\s*([^\s"';/>]+)/iu.exec(
      htmlPrefix,
    )?.[1];
  return [bomCharset, headerCharset, metaCharset, "utf-8"]
    .filter(Boolean)
    .map((value) => value.toLocaleLowerCase());
}

export function decodeSourceBody(body, contentType) {
  const candidates = [
    ...new Set(sourceEncodingCandidates(body, contentType)),
  ];
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate, { fatal: true }).decode(body);
    } catch {
      // Try the next declared or default encoding.
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

function comparableArticleUrl(value, source) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(decodeHtmlEntities(value.trim()), source || undefined);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function jsonLdArticlePublishedValues(decoded, source) {
  const citedUrl = comparableArticleUrl(source, source);
  if (!citedUrl) return [];
  const values = [];
  const articleTypes = new Set([
    "article",
    "newsarticle",
    "analysisnewsarticle",
    "reportagenewsarticle",
    "blogposting",
    "report",
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = (Array.isArray(value["@type"])
      ? value["@type"]
      : [value["@type"]]
    )
      .filter((item) => typeof item === "string")
      .map((item) => item.toLocaleLowerCase());
    const mainEntity = value.mainEntityOfPage;
    const identities = [
      value.url,
      value["@id"],
      typeof mainEntity === "string" ? mainEntity : null,
      mainEntity?.url,
      mainEntity?.["@id"],
    ]
      .map((item) => comparableArticleUrl(item, source))
      .filter(Boolean);
    if (
      types.some((type) => articleTypes.has(type)) &&
      identities.includes(citedUrl) &&
      typeof value.datePublished === "string"
    ) {
      values.push(value.datePublished);
    }
    Object.values(value).forEach(visit);
  };
  for (const match of decoded.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    try {
      visit(
        JSON.parse(
          decodeHtmlEntities(match[1])
            .replace(/^\s*<!--/u, "")
            .replace(/-->\s*$/u, "")
            .trim(),
        ),
      );
    } catch {
      // Invalid structured data cannot establish a publication timestamp.
    }
  }
  return values;
}

function fedSpeechArticleDate(body, source) {
  const url = new URL(source);
  if (url.hostname !== "www.federalreserve.gov") return null;
  const date = /^\/newsevents\/speech\/[a-z]+(20\d{6})[a-z]\.htm$/u.exec(url.pathname)?.[1];
  if (!date) return null;
  const document = new JSDOM(decodeSourceBody(Buffer.from(body), "text/html")).window.document;
  const header = document.querySelector("#article > .heading");
  if (!header?.querySelector("h3.title")?.textContent.trim()) return null;
  const visible = header.querySelector(".article__time")?.textContent.trim();
  const parsed = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  const expected = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(parsed);
  return visible === expected ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : null;
}

export const BEA_RELEASE_FEED = "https://apps.bea.gov/rss/rss.xml";

function beaReleaseIdentity(body, source) {
  let url; try { url = new URL(source); } catch { return null; }
  if (url.protocol !== "https:" || !["bea.gov", "www.bea.gov"].includes(url.hostname) || !/^\/news\/20\d{2}\/[a-z0-9-]+$/u.test(url.pathname) || url.search || url.hash) return null;
  const document = new JSDOM(decodeSourceBody(Buffer.from(body), "text/html")).window.document;
  const articles = [...document.querySelectorAll("article[about]")].filter(item => item.getAttribute("about") === url.pathname);
  if (articles.length !== 1) return null;
  const article = articles[0], headers = [...article.querySelectorAll("h1")].map(item => item.textContent.trim()).filter(title => title && title !== "News Release");
  const dates = article.querySelectorAll(".release-embargo .field--name-field-release-date");
  const content = article.querySelector(".field--name-body")?.textContent ?? "";
  if (headers.length !== 1 || dates.length !== 1 || !content.slice(0, 1_000).includes("released today") || !content.slice(0, 1_000).includes("U.S. Bureau of Economic Analysis")) return null;
  const match = /^EMBARGOED UNTIL RELEASE AT (?:[1-9]|1[0-2]):[0-5]\d [ap]\.m\. (?:EDT|EST|ET), (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([A-Za-z]+) (\d{1,2}), (20\d{2})$/u.exec(dates[0].textContent.trim());
  if (!match) return null;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = months.indexOf(match[2]);
  if (month < 0) return null;
  const date = `${match[4]}-${String(month + 1).padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(parsed) !== match[1]) return null;
  return { url, date, title: headers[0] };
}

export function beaReleasePublishedAtCandidates(articleBody, feedBody, source) {
  const article = beaReleaseIdentity(articleBody, source);
  if (!article) return [];
  const key = value => {
    try { const url = new URL(value); return url.protocol === "https:" && ["bea.gov", "www.bea.gov"].includes(url.hostname) && !url.search && !url.hash ? url.pathname : null; } catch { return null; }
  };
  const document = new JSDOM(decodeSourceBody(Buffer.from(feedBody), "application/xml"), { contentType: "text/xml" }).window.document;
  const matches = [...document.querySelectorAll("rss > channel > item")].filter(item => key(item.querySelector("link")?.textContent.trim()) === article.url.pathname && key(item.querySelector("guid")?.textContent.trim()) === article.url.pathname);
  if (matches.some(item => ["link", "guid", "title", "pubDate"].some(name => item.querySelectorAll(`:scope > ${name}`).length !== 1))) return [];
  if (matches.length !== 1 || normalizedEvidenceText(matches[0].querySelector("title")?.textContent) !== normalizedEvidenceText(article.title)) return [];
  const raw = matches[0].querySelector("pubDate")?.textContent.trim() ?? "";
  const clock = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (20\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d (?:EDT|EST|GMT|UTC|[+-](?:[01]\d|2[0-3])[0-5]\d)$/u.exec(raw);
  if (!clock || !Number.isFinite(Date.parse(raw))) return [];
  const calendar = new Date(`${clock[3]} ${clock[2]}, ${clock[4]} 12:00:00 GMT`);
  if (calendar.getUTCDate() !== Number(clock[2]) || new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(calendar) !== clock[1]) return [];
  const published = new Date(raw);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(published).map(item => [item.type, item.value]));
  if (`${parts.year}-${parts.month}-${parts.day}` !== article.date) return [];
  // The embargo banner supplies the release date, never its publication
  // clock. The matching RSS publication record may show a later minute.
  return [published.toISOString()];
}

export function fedSpeechPublishedAtCandidates(articleBody, feedBody, source) {
  const articleDate = fedSpeechArticleDate(articleBody, source);
  if (!articleDate) return [];
  const document = new JSDOM(decodeSourceBody(Buffer.from(feedBody), "application/xml"), { contentType: "text/xml" }).window.document;
  const values = [];
  for (const item of document.querySelectorAll("rss > channel > item")) {
    if (
      item.querySelector("link")?.textContent.trim() !== source ||
      item.querySelector("guid")?.textContent.trim() !== source ||
      item.querySelector("category")?.textContent.trim() !== "Speech"
    ) continue;
    const raw = item.querySelector("pubDate")?.textContent.trim() ?? "";
    if (!/(?:GMT|UTC|[+-]\d{4})$/u.test(raw) || !Number.isFinite(Date.parse(raw))) continue;
    const published = new Date(raw);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(published);
    const part = (type) => parts.find((item) => item.type === type).value;
    if (`${part("year")}-${part("month")}-${part("day")}` === articleDate) values.push(published.toISOString());
  }
  return [...new Set(values)];
}

export function sourcePublishedAtCandidates(
  body,
  contentType = "text/html",
  source = "",
) {
  if (/^application\/pdf(?:;|$)/iu.test(contentType)) return [];
  if (isGdpNowCommentary(source)) return [];
  if (!/(?:html|xhtml|json|plain)/iu.test(contentType)) return [];
  const decoded = decodeSourceBody(body, contentType);
  if (mofDocumentIdentity(source)) return mofDocumentRecord(decoded, source)?.publishedAtCandidates ?? [];
  const chinaPmi = chinaPmiDocument(decoded, source);
  if (chinaPmi) return [chinaPmi.publishedAt];
  const visibleDecoded = decoded.replace(/<!--[\s\S]*?-->/gu, " ");
  const values = [];
  const isModificationLabel = (index) =>
    /(?:更新(?:时间)?|修改(?:时间)?|修订(?:时间)?|updated|modified)\s*(?:于|at|on|time)?\s*$/iu.test(
      visibleDecoded.slice(Math.max(0, index - 32), index),
    );
  const isPublicationLabel = (index) =>
    /(?:发布(?:时间|日期)?|发表(?:时间|日期)?|刊发(?:时间|日期)?|published|publication\s+date|date\s+published|posted)\s*(?:(?:于|在|at|on|time)|[:：])?\s*(?:<[^>]*>\s*)*$/iu.test(
      visibleDecoded.slice(Math.max(0, index - 160), index),
    );
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|bytedance:published_time|datePublished|pubdate|publishdate|parsely-pub-date)["'][^>]+content=["']([^"']+)["'][^>]*>/giu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|bytedance:published_time|datePublished|pubdate|publishdate|parsely-pub-date)["'][^>]*>/giu,
    /<time[^>]+(?:itemprop=["']datePublished["']|class=["'][^"']*(?:published|publish-date|article-date)[^"']*["'])[^>]+datetime=["']([^"']+)["'][^>]*>/giu,
    /<time[^>]+datetime=["']([^"']+)["'][^>]+(?:itemprop=["']datePublished["']|class=["'][^"']*(?:published|publish-date|article-date)[^"']*["'])[^>]*>/giu,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) values.push(match[1]);
  }
  for (const match of visibleDecoded.matchAll(
    /<(?:time|span|div)[^>]+class=["'][^"']*(?:publish-time|publication-time|article-time)[^"']*["'][^>]*>\s*(20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/giu,
  )) {
    values.push(match[1]);
  }
  let sourceHostname = "";
  try {
    sourceHostname = new URL(source).hostname.toLocaleLowerCase();
  } catch {
    // A source URL is optional for metadata-only unit tests.
  }
  if (sourceHostname === "cls.cn" || sourceHostname.endsWith(".cls.cn")) {
    // CLS embeds the current article's publication time as Unix seconds.
    // Match both routing and article IDs so recommendation timestamps cannot
    // make an unrelated or stale article appear current.
    const articleId = /^\/detail\/(\d+)\/?$/u.exec(new URL(source).pathname)?.[1];
    if (articleId) {
      for (const match of decoded.matchAll(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/giu)) {
        try {
          const data = JSON.parse(match[1]);
          const article = data.props?.pageProps?.articleDetail;
          if (
            data.page === "/detail/[id]" &&
            String(data.query?.id) === articleId &&
            String(article?.id) === articleId &&
            Number.isInteger(article.ctime) &&
            article.ctime >= 946684800 && article.ctime < 4102444800
          ) {
            values.push(new Date(article.ctime * 1000).toISOString());
          }
        } catch {
          // An invalid hydration block is not publication metadata.
        }
      }
    }
  }
  if (sourceHostname === "21jingji.com" || sourceHostname.endsWith(".21jingji.com")) {
    // Bind the visible date to this article's heading, not recommended stories
    // or dates mentioned in the body. The publisher displays China local time.
    const articleHeader = /<div\b[^>]*class=["']titleHead["'][^>]*>\s*<h1\b[^>]*>[\s\S]*?<\/h1>([\s\S]{0,1200}?)<div\b[^>]*class=["']newsDate["'][^>]*>\s*(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s*<\/div>/iu.exec(visibleDecoded);
    if (articleHeader) values.push(`${articleHeader[2]}T${articleHeader[3]}+08:00`);
    const authorHeader = /<div\b[^>]*class=["']titleHead["'][^>]*>\s*<h1\b[^>]*>[^<]*<\/h1>\s*<div\b[^>]*class=["']newsAuthor["'][^>]*>[\s\S]{0,1200}?<div\b[^>]*class=["']author-infos["'][^>]*>[\s\S]{0,500}?<span>[^<\d]{0,60}(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s*<\/span>/iu.exec(visibleDecoded);
    if (authorHeader) values.push(`${authorHeader[1]}T${authorHeader[2]}+08:00`);
    const desktopHeader = /<div\b[^>]*class=["']main["'][^>]*>\s*<h1\b[^>]*>[^<]*<\/h1>\s*<h6\b[^>]*>\s*(20\d{2})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/iu.exec(visibleDecoded);
    if (desktopHeader) {
      const [, year, month, day, hour, minute] = desktopHeader;
      values.push(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00+08:00`);
    }
  }
  if (sourceHostname === "nbd.com.cn" || sourceHostname.endsWith(".nbd.com.cn")) {
    for (const match of decoded.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
      try {
        const article = JSON.parse(match[1]);
        if (
          article["@context"] === "https://ziyuan.baidu.com/contexts/cambrian.jsonld" &&
          comparableArticleUrl(article["@id"], source) === comparableArticleUrl(source, source) &&
          typeof article.title === "string" && article.title.trim() &&
          /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(article.pubDate ?? "")
        ) values.push(`${article.pubDate}+08:00`);
      } catch {
        // Invalid or unrelated structured data cannot date this article.
      }
    }
  }
  if (
    sourceHostname === "finance.eastmoney.com" ||
    sourceHostname.endsWith(".eastmoney.com")
  ) {
    for (const match of visibleDecoded.matchAll(
      /<div[^>]+class=["'][^"']*infos[^"']*["'][^>]*>[\s\S]{0,500}?<div[^>]+class=["'][^"']*item[^"']*["'][^>]*>\s*(20\d{2})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/giu,
    )) {
      const [, year, month, day, hour, minute, second = "00"] = match;
      values.push(
        `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`,
      );
    }
  }
  if (
    sourceHostname === "yicai.com" ||
    sourceHostname.endsWith(".yicai.com")
  ) {
    for (const match of visibleDecoded.matchAll(
      /["']actime["']\s*,\s*["'](20\d{2}-\d{1,2}-\d{1,2}T\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}(?::?\d{2})?)?)["']/giu,
    )) {
      values.push(match[1].replace(/([+-]\d{2})$/u, "$1:00"));
    }
  }
  if (
    sourceHostname === "stcn.com" ||
    sourceHostname.endsWith(".stcn.com")
  ) {
    for (const match of visibleDecoded.matchAll(
      /<span[^>]*>\s*来源[：:][\s\S]{0,300}?<span[^>]*>\s*(20\d{2})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*<\/span>/giu,
    )) {
      const [, year, month, day, hour, minute, second = "00"] = match;
      values.push(
        `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`,
      );
    }
  }
  values.push(...jsonLdArticlePublishedValues(decoded, source));
  // A strictly bound issuer article may use the native CMS identity in its
  // metadata. Its first creation clock remains distinct from its current
  // version; verification uses the latter through article provenance.
  if (sourceHostname === "www.hpe.com") {
    const publication = sourceArticleProvenance(decoded, source)?.publication;
    if (publication?.status === "verified") values.push(publication.initialPublishedAt);
  }
  for (const match of decoded.matchAll(
    /ACCEPTANCE-DATETIME(?:>|:)[ \t]*(20\d{12})/giu,
  )) {
    const compact = match[1];
    const year = Number(compact.slice(0, 4));
    const month = Number(compact.slice(4, 6));
    const day = Number(compact.slice(6, 8));
    const hour = Number(compact.slice(8, 10));
    const minute = Number(compact.slice(10, 12));
    const second = Number(compact.slice(12, 14));
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(localAsUtc))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const shownAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    values.push(new Date(localAsUtc - (shownAsUtc - localAsUtc)).toISOString());
  }
  for (const match of visibleDecoded.matchAll(
    /(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/gu,
  )) {
    if (isModificationLabel(match.index) || !isPublicationLabel(match.index)) {
      continue;
    }
    const [, year, month, day, hour, minute, second = "00"] = match;
    values.push(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`,
    );
  }
  let chinaLocalTime = false;
  try {
    chinaLocalTime = CHINA_LOCAL_TIME_HOSTS.some(
      (domain) =>
        sourceHostname === domain || sourceHostname.endsWith(`.${domain}`),
    );
  } catch {
    // A source URL is optional for metadata-only unit tests.
  }
  if (chinaLocalTime) {
    for (const match of visibleDecoded.matchAll(
      /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\s*(?:Z|[+-]\d{2}:?\d{2}))/gu,
    )) {
      if (isModificationLabel(match.index) || !isPublicationLabel(match.index)) {
        continue;
      }
      const [, year, month, day, hour, minute, second = "00"] = match;
      values.push(
        `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`,
      );
    }
  }
  const parseCandidate = (value) => {
    const decodedValue = decodeHtmlEntities(value.trim());
    // A date's final -29 is not a timezone offset. Never manufacture a
    // midnight clock from a calendar date, even with publication metadata.
    if (!/(?:T|\s)\d{1,2}:\d{2}/u.test(decodedValue)) return Number.NaN;
    const offsetFreeChinaTime = chinaLocalTime
      ? /^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/u.exec(
          decodedValue,
        )
      : null;
    if (offsetFreeChinaTime) {
      const [, year, month, day, hour, minute, second = "00"] =
        offsetFreeChinaTime;
      return Date.parse(
        `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`,
      );
    }
    if (!/(?:Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)$/iu.test(decodedValue)) {
      return Number.NaN;
    }
    return Date.parse(decodedValue);
  };
  return [
    ...new Set(
      values
        .map(parseCandidate)
        .filter(Number.isFinite)
        .map((value) => new Date(value).toISOString()),
    ),
  ];
}

export function sourcePublishedDateCandidates(body, contentType = "text/html", source = "") {
  if (!/(?:html|xhtml)/iu.test(contentType)) return [];
  if (isGdpNowCommentary(source)) {
    const record = gdpNowCommentaryRecord(body, source);
    return record ? [record.updateDate] : [];
  }
  const decoded = decodeSourceBody(body, contentType);
  if (mofDocumentIdentity(source)) return mofDocumentRecord(decoded, source)?.publishedDateCandidates ?? [];
  const chinaPmi = chinaPmiDocument(decoded, source);
  if (chinaPmi) return [chinaPmi.publicationDate];
  const values = jsonLdArticlePublishedValues(decoded, source);
  for (const match of decoded.matchAll(/<meta[^>]+(?:property|name)=["'](?:datePublished|pubdate|publishdate|article:published_time)["'][^>]+content=["'](\d{4}-\d{2}-\d{2})["'][^>]*>/giu)) values.push(match[1]);
  for (const match of decoded.matchAll(/<meta[^>]+content=["'](\d{4}-\d{2}-\d{2})["'][^>]+(?:property|name)=["'](?:datePublished|pubdate|publishdate|article:published_time)["'][^>]*>/giu)) values.push(match[1]);
  for (const match of decoded.matchAll(/<time[^>]+(?:itemprop=["']datePublished["']|class=["'][^"']*(?:published|publish-date|article-date)[^"']*["'])[^>]+datetime=["'](\d{4}-\d{2}-\d{2})["'][^>]*>/giu)) values.push(match[1]);
  for (const match of decoded.matchAll(/<time[^>]+datetime=["'](\d{4}-\d{2}-\d{2})["'][^>]+(?:itemprop=["']datePublished["']|class=["'][^"']*(?:published|publish-date|article-date)[^"']*["'])[^>]*>/giu)) values.push(match[1]);
  let url;
  try { url = new URL(source); } catch { return []; }
  const bea = beaReleaseIdentity(body, source);
  if (bea) values.push(bea.date);
  if (url.hostname === "www.sec.gov" && /^\/Archives\/edgar\/data\/\d+\/\d+\/[^/]+\.html?$/u.test(url.pathname)) {
    const header = sourceBodyText(body, contentType).slice(0, 4_096);
    const filed = /(?:^|\n)As filed with the U\.S\. Securities and Exchange Commission on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\n|$)/u.exec(header);
    if (filed) {
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const month = months.indexOf(filed[1]);
      if (month >= 0) values.push(`${filed[3]}-${String(month + 1).padStart(2, "0")}-${filed[2].padStart(2, "0")}`);
    }
  }
  // This exact first-party series labels the date of its current release as
  // "Updated". It is a date-only release record, not generic modification
  // metadata or an invented intraday publication time.
  if (url.hostname === "www.conference-board.org" && url.pathname === "/topics/tags.cfm" && url.searchParams.get("parent") === "consumer-confidence") {
    const visible = sourceBodyText(body, contentType);
    const match = /US Consumer Confidence[^\n]*\nLatest Press Release\nUpdated:\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\n|$)/u.exec(visible);
    if (match) {
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const month = months.indexOf(match[1]);
      if (month >= 0) values.push(`${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`);
    }
  }
  return [...new Set(values.filter(value => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value))];
}

export function sourceBodyText(body, contentType = "text/html") {
  if (/^application\/pdf(?:;|$)/iu.test(contentType)) return pdfSourceRecord(body).text;
  const decoded = decodeSourceBody(body, contentType);
  if (!/(?:html|xhtml)/iu.test(contentType)) {
    return decoded.replace(/\s+/gu, " ").trim();
  }
  return decodeHtmlEntities(
    decoded
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<ix:header\b[^>]*>[\s\S]*?<\/ix:header\s*>/giu, " ")
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(?:p|div|article|section|li|h[1-6])>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();
}

export function normalizedEvidenceText(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}.+%\-]+/gu, "");
}

export function secSubmissionMetadataUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname.toLocaleLowerCase() !== "www.sec.gov") return null;
  const match = /^\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/[^/]+$/u.exec(
    url.pathname,
  );
  if (!match) return null;
  const [, cik, accession] = match;
  const filingName = `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}.txt`;
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${filingName}`;
}

export async function readExternalSource(
  source,
  {
    resolver,
    requester,
    runner = execFileAsync,
    curlPath = DEFAULT_CURL_PATH,
    maxRedirects = MAX_REDIRECTS,
    maxBytes = MAX_SOURCE_BYTES,
    signal,
    structured = false,
    includeRaw = false,
    lookupPublicationMetadata = true,
    cninfoHistory,
  } = {},
) {
  if (cninfoHistory !== undefined && (source !== CNINFO_HISTORY_URL || !structured)) throw new Error("定期披露表单仅适用于巨潮原始只读地址");
  if (cninfoHistory !== undefined) validateCninfoHistoryBody(cninfoHistory);
  const resolveDestination =
    resolver ??
    ((hostname) => ["static.cninfo.com.cn", "www.cninfo.com.cn"].includes(hostname)
      // Native DNS passes the same public-IP validation and exact TLS pinning.
      // The overseas CDN answers stall large originals on the current host.
      ? dnsLookup(hostname, { all: true, verbatim: true })
      : resolveWithDoh(hostname, { runner, curlPath, signal }));
  const requestContent =
    requester ??
    ((value, destination, options) =>
      requestContentWithFallback(value, destination, {
        ...options,
        runner,
        curlPath,
        signal,
      }));
  let current = source;
  sourceAttempts: for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    signal?.throwIfAborted();
    let resolved;
    try {
      resolved = await publicDestination(current, resolveDestination);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (String(error?.message ?? "").startsWith("外部证据")) throw error;
      resolved = await publicDestination(current, (hostname, options) =>
        dnsLookup(hostname, options),
      );
    }
    let response;
    // Retry transport failures on another already-validated CDN address. An HTTP
    // refusal, a size violation or an invalid certificate is not a retry signal.
    const destinations = resolved.destinations.slice(0, 3);
    for (let attempt = 0; attempt < destinations.length; attempt += 1) {
      try {
        response = await requestContent(resolved.url.toString(), destinations[attempt], { maxBytes, signal, ...(cninfoHistory !== undefined ? { method: "POST", requestBody: cninfoHistory } : {}) });
        break;
      } catch (error) {
        signal?.throwIfAborted();
        const retryable = [6, 7, 28, 35, 52, 56, "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code);
        if (!retryable) throw error;
        if (attempt === destinations.length - 1) {
          // This publisher serves the same fixed article path on its mobile
          // and desktop sites. Only a transport failure permits this fallback;
          // the next iteration validates and pins the desktop DNS separately.
          if (
            redirectCount < maxRedirects &&
            resolved.url.hostname === "m.21jingji.com" &&
            /^\/article\/\d{8}\/herald\/[a-f0-9]{32}\.html$/u.test(resolved.url.pathname)
          ) {
            const desktopUrl = new URL(resolved.url);
            desktopUrl.hostname = "www.21jingji.com";
            current = desktopUrl.toString();
            continue sourceAttempts;
          }
          throw error;
        }
      }
    }
    if (response.status >= 200 && response.status < 300) {
      const contentType = response.contentType || "text/html";
      if (structured) {
        const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
        if (!["application/json", "application/xml", "text/xml", "text/plain"].includes(mediaType)) {
          throw new Error(`结构化一手数据返回无效正文类型：${contentType}`);
        }
        return { source, status: response.status, finalUrl: resolved.url.toString(), contentType, rawBody: response.body, ...(cninfoHistory !== undefined ? { requestMethod: "POST", requestBody: cninfoHistory } : {}) };
      }
      if (!/(?:html|xhtml|plain|json)/iu.test(contentType) && !/^application\/pdf(?:;|$)/iu.test(contentType)) {
        throw new Error(`外部证据正文类型不受支持：${contentType}`);
      }
      let text = sourceBodyText(response.body, contentType);
      let publishedAtCandidates = sourcePublishedAtCandidates(
        response.body,
        contentType,
        resolved.url.toString(),
      );
      const metadataReceipts = [];
      let pdfDocument = /^application\/pdf(?:;|$)/iu.test(contentType) ? pdfSourceRecord(response.body) : undefined;
      if (pdfDocument) {
        const identity = cninfoPdfIdentity(response.body, resolved.url.toString());
        if (identity && lookupPublicationMetadata) {
          try {
            const destination = await publicDestination(identity.recordUrl, resolveDestination);
            const metadata = await requestContent(destination.url.toString(), destination.destination, { maxBytes: Math.min(maxBytes, 1024 * 1024), signal, method: "POST" });
            const receipt = { finalUrl: destination.url.toString(), status: metadata.status, contentType: metadata.contentType, rawBody: metadata.body, requestMethod: "POST" };
            const publication = cninfoPdfPublication(response.body, receipt, resolved.url.toString());
            if (publication) {
              pdfDocument = { ...pdfDocument, ...publication };
              if (includeRaw) metadataReceipts.push(receipt);
            }
          } catch (error) { if (signal?.aborted) throw signal.reason ?? error; }
        }
      }
      let authorityDocument;
      if (mofDocumentIdentity(resolved.url.toString())) {
        const record = /(?:html|xhtml)/iu.test(contentType) ? mofDocumentRecord(decodeSourceBody(response.body, contentType), resolved.url.toString()) : null;
        if (!record) throw new Error("财政部公告正文、身份或发布时间无法绑定原文");
        authorityDocument = { ...record, articleProvenance: sourceArticleProvenance(decodeSourceBody(response.body, contentType), resolved.url.toString()) };
        text = record.text;
        publishedAtCandidates = record.publishedAtCandidates;
      }
      const nfraIdentity = nfraDocumentIdentity(resolved.url.toString());
      if (nfraIdentity) {
        if (!lookupPublicationMetadata || !/(?:html|xhtml)/iu.test(contentType)) throw new Error("金融监管总局公告缺少对应原始正文记录");
        const destination = await publicDestination(nfraIdentity.recordUrl, resolveDestination);
        const metadata = await requestContent(destination.url.toString(), destination.destination, { maxBytes, signal });
        const receipt = { finalUrl: destination.url.toString(), status: metadata.status, contentType: metadata.contentType, rawBody: metadata.body };
        authorityDocument = nfraDocumentRecord(decodeSourceBody(response.body, contentType), receipt, resolved.url.toString());
        if (!authorityDocument) throw new Error("金融监管总局公告正文、身份或发布时间无法绑定原始记录");
        text = authorityDocument.text;
        publishedAtCandidates = authorityDocument.publishedAtCandidates;
        if (includeRaw) metadataReceipts.push(receipt);
      }
      if ([...text].length < 80) throw new Error(`外部证据正文过短：${current}`);
      if (lookupPublicationMetadata && publishedAtCandidates.length === 0 && beaReleaseIdentity(response.body, resolved.url.toString())) {
        try {
          const feed = await publicDestination(BEA_RELEASE_FEED, resolveDestination);
          const metadata = await requestContent(feed.url.toString(), feed.destination, { maxBytes, signal });
          if (metadata.status >= 200 && metadata.status < 300) {
            publishedAtCandidates = beaReleasePublishedAtCandidates(response.body, metadata.body, resolved.url.toString());
            if (includeRaw && publishedAtCandidates.length) metadataReceipts.push({ finalUrl: feed.url.toString(), status: metadata.status, contentType: metadata.contentType || "application/xml", rawBody: metadata.body });
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          // Missing or inconsistent official records leave the hour unknown.
        }
      }
      if (lookupPublicationMetadata && publishedAtCandidates.length === 0 && gdpNowCommentaryRecord(response.body, resolved.url.toString())) {
        try {
          const feed = await publicDestination(GDP_NOW_FEED, resolveDestination);
          const metadata = await requestContent(feed.url.toString(), feed.destination, { maxBytes, signal });
          if (metadata.status >= 200 && metadata.status < 300 && /^(?:application|text)\/xml(?:;|$)/iu.test(metadata.contentType ?? "")) {
            publishedAtCandidates = gdpNowPublishedAtCandidates(response.body, metadata.body, resolved.url.toString());
            if (includeRaw && publishedAtCandidates.length) metadataReceipts.push({ finalUrl: feed.url.toString(), status: metadata.status, contentType: metadata.contentType, rawBody: metadata.body });
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          // A missing or mismatched feed leaves this update's hour unknown.
        }
      }
      if (lookupPublicationMetadata && publishedAtCandidates.length === 0 && fedSpeechArticleDate(response.body, resolved.url.toString())) {
        try {
          // The page supplies only a date. Use this exact speech's official
          // RSS item for its actual publication time; never invent midnight.
          const feed = await publicDestination("https://www.federalreserve.gov/feeds/speeches.xml", resolveDestination);
          const metadata = await requestContent(feed.url.toString(), feed.destination, { maxBytes, signal });
          if (metadata.status >= 200 && metadata.status < 300) {
            publishedAtCandidates = fedSpeechPublishedAtCandidates(response.body, metadata.body, resolved.url.toString());
            if (includeRaw) metadataReceipts.push({ finalUrl: feed.url.toString(), status: metadata.status, contentType: metadata.contentType || "application/xml", rawBody: metadata.body });
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          // A missing or invalid feed item leaves the speech time unverified.
        }
      }
      const submissionUrl =
        lookupPublicationMetadata && publishedAtCandidates.length === 0
          ? secSubmissionMetadataUrl(resolved.url.toString())
          : null;
      if (submissionUrl) {
        try {
          signal?.throwIfAborted();
          const submissionDestination = await publicDestination(
            submissionUrl,
            resolveDestination,
          );
          const submission = await requestContent(
            submissionDestination.url.toString(),
            submissionDestination.destination,
            { maxBytes, signal },
          );
          if (submission.status >= 200 && submission.status < 300) {
            publishedAtCandidates = sourcePublishedAtCandidates(
              submission.body,
              submission.contentType || "text/plain",
              submissionDestination.url.toString(),
            );
            if (includeRaw) metadataReceipts.push({ finalUrl: submissionDestination.url.toString(), status: submission.status, contentType: submission.contentType || "text/plain", rawBody: submission.body });
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          // The exhibit body remains usable, but publication time stays unverified.
        }
      }
      return {
        source,
        status: response.status,
        finalUrl: resolved.url.toString(),
        contentType,
        text,
        publishedAtCandidates,
        publishedDateCandidates: pdfDocument?.publishedDateCandidates ?? authorityDocument?.publishedDateCandidates ?? sourcePublishedDateCandidates(response.body, contentType, resolved.url.toString()),
        articleProvenance: authorityDocument?.articleProvenance ?? (/(?:html|xhtml)/iu.test(contentType) ? sourceArticleProvenance(decodeSourceBody(response.body, contentType), resolved.url.toString()) : null),
        ...(includeRaw || pdfDocument ? { rawBody: response.body, metadataReceipts } : {}),
        ...(pdfDocument ? { pdfDocument } : {}),
      };
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (cninfoHistory !== undefined) throw new Error("巨潮只读披露查询不得跳转或转发表单");
      if (redirectCount === maxRedirects) {
        throw new Error(`外部证据重定向次数过多：${source}`);
      }
      current = new URL(response.location, resolved.url).toString();
      continue;
    }
    throw new Error(`外部证据返回无效响应（HTTP ${response.status}）：${current}`);
  }
  throw new Error(`外部证据重定向次数过多：${source}`);
}

async function requestHeadersWithSystemDns(
  value,
  { runner = execFileAsync, curlPath = DEFAULT_CURL_PATH } = {},
) {
  const resolved = await publicDestination(value, (hostname, options) =>
    dnsLookup(hostname, options),
  );
  try {
    const response = await requestHeaders(
      resolved.url.toString(),
      resolved.destination,
      { runner, curlPath },
    );
    if (![403, 429].includes(response.status)) return response;
  } catch {
    // The pinned Node HTTPS request below covers local curl/TLS failures.
  }
  return requestHeadersWithNode(resolved.url.toString(), resolved.destination);
}

async function requestHeadersWithFallback(
  value,
  destination,
  { runner = execFileAsync, curlPath = DEFAULT_CURL_PATH } = {},
) {
  try {
    const response = await requestHeaders(value, destination, {
      runner,
      curlPath,
    });
    if (![403, 429].includes(response.status)) return response;
    try {
      return await requestHeadersWithSystemDns(value, {
        runner,
        curlPath,
      });
    } catch {
      return response;
    }
  } catch (curlError) {
    try {
      return await requestHeadersWithSystemDns(value, {
        runner,
        curlPath,
      });
    } catch (nodeError) {
      const curlDetail = String(curlError?.message ?? "curl failed")
        .replace(/\s+/gu, " ")
        .trim();
      const nodeDetail = String(nodeError?.message ?? "Node HTTPS failed")
        .replace(/\s+/gu, " ")
        .trim();
      throw new Error(`${curlDetail}; fallback: ${nodeDetail}`);
    }
  }
}

export async function openExternalSource(
  source,
  {
    resolver,
    requester,
    runner = execFileAsync,
    curlPath = DEFAULT_CURL_PATH,
    maxRedirects = MAX_REDIRECTS,
  } = {},
) {
  const resolveDestination =
    resolver ??
    ((hostname) => resolveWithDoh(hostname, { runner, curlPath }));
  const openDestination =
    requester ??
    ((url, destination) =>
      requestHeadersWithFallback(url, destination, { runner, curlPath }));
  let current = source;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let resolved;
    try {
      resolved = await publicDestination(current, resolveDestination);
    } catch (error) {
      if (String(error?.message ?? "").startsWith("外部证据")) throw error;
      try {
        resolved = await publicDestination(current, (hostname, options) =>
          dnsLookup(hostname, options),
        );
      } catch (fallbackError) {
        if (
          String(fallbackError?.message ?? "").startsWith("外部证据")
        ) {
          throw fallbackError;
        }
        throw new Error(`外部证据无法解析：${current}`);
      }
    }
    let response;
    try {
      response = await openDestination(
        resolved.url.toString(),
        resolved.destination,
      );
    } catch (error) {
      const detail = String(error?.message ?? "打开失败")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 240);
      throw new Error(
        `外部证据无法打开：${current}${detail ? `（${detail}）` : ""}`,
      );
    }
    if (response.status >= 200 && response.status < 300) {
      return {
        source,
        status: response.status,
        finalUrl: resolved.url.toString(),
      };
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirectCount === maxRedirects) {
        throw new Error(`外部证据重定向次数过多：${source}`);
      }
      current = new URL(response.location, resolved.url).toString();
      continue;
    }
    throw new Error(`外部证据返回无效响应：${current}`);
  }
  throw new Error(`外部证据重定向次数过多：${source}`);
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
  return results;
}

export async function auditReportSources(
  report,
  { opener = openExternalSource, concurrency = DEFAULT_CONCURRENCY } = {},
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("外部证据审计并发数必须为 1–8");
  }
  const sources = externalSources(report);
  const opened = await mapWithConcurrency(sources, concurrency, opener);
  return {
    status: "audited",
    sourceCount: opened.length,
    sources: opened,
  };
}

async function main() {
  const reportPath = resolve(process.argv[2] ?? "work/daily-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  console.log(JSON.stringify(await auditReportSources(report), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
