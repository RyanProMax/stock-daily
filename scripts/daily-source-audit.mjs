import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_CONCURRENCY = 4;
const MAX_REDIRECTS = 8;
const DEFAULT_CURL_PATH =
  process.env.STOCK_DAILY_CURL_BIN ?? "/usr/bin/curl";
const DOH_HOSTNAME = "cloudflare-dns.com";
const DOH_ADDRESS = "1.1.1.1";

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

async function publicDestination(value, resolver) {
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
  return { url, destination };
}

async function dohQuery(hostname, type, runner, curlPath) {
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
    { encoding: "utf8", maxBuffer: 256 * 1024 },
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
  { runner = execFileAsync, curlPath = DEFAULT_CURL_PATH } = {},
) {
  const ipv4 = await dohQuery(hostname, "A", runner, curlPath);
  if (ipv4.length > 0) return ipv4;
  return dohQuery(hostname, "AAAA", runner, curlPath);
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
