import xSources from "../data/ai-x-sources.json" with { type: "json" };
import issuerDomains from "../data/issuer-domains.json" with { type: "json" };
import { validateIssuerDomainRecords } from "./issuer-domain-identity.mjs";

// These issuer domains already have a first-party identity reference in the
// reviewed original-source registry. Specialist/KOL websites are not issuers.
const VERIFIED_ISSUERS = new Map();
for (const source of xSources) if (source.authority === "first_party" && source.identityEvidence) {
  for (const domain of source.canonicalDomains) if (!VERIFIED_ISSUERS.has(domain)) VERIFIED_ISSUERS.set(domain, source.label);
}
const FILING_ISSUERS = validateIssuerDomainRecords(issuerDomains);
for (const source of FILING_ISSUERS) if (!VERIFIED_ISSUERS.has(source.domain)) VERIFIED_ISSUERS.set(source.domain, source.label);

const FIRST_PARTY_SOURCE_DOMAINS = [
  ...VERIFIED_ISSUERS.keys(),
  "bea.gov",
  "bls.gov",
  "cmegroup.com",
  "cninfo.com.cn",
  "commerce.gov",
  "conference-board.org",
  "csrc.gov.cn",
  "csindex.com.cn",
  "customs.gov.cn",
  "dol.gov",
  "eia.gov",
  "energy.gov",
  "fda.gov",
  "federalreserve.gov",
  "gov.cn",
  "hkex.com.hk",
  "hkexnews.hk",
  "miit.gov.cn",
  "mof.gov.cn",
  "nasdaq.com",
  "ndrc.gov.cn",
  "nyse.com",
  "nvidia.com",
  "pbc.gov.cn",
  "safe.gov.cn",
  "samr.gov.cn",
  "sec.gov",
  "salesforce.com",
  "sse.com.cn",
  "stats.gov.cn",
  "szse.cn",
  "treasury.gov",
  "usda.gov",
  "whitehouse.gov",
];

const ESTABLISHED_PUBLISHER_HOSTS = new Set([
  "21jingji.com",
  "apnews.com",
  "barrons.com",
  "bloomberg.com",
  "caixin.com",
  "cls.cn",
  "chnfund.com",
  "cnbc.com",
  "cnstock.com",
  "finance.eastmoney.com",
  "finance.sina.com.cn",
  "finance.yahoo.com",
  "ft.com",
  "kiplinger.com",
  "latimes.com",
  "m.nbd.com.cn",
  "marketbeat.com",
  "marketwatch.com",
  "moneyweek.com",
  "nbd.com.cn",
  "people.com.cn",
  "reuters.com",
  "stcn.com",
  "thepaper.cn",
  "wap.eastmoney.com",
  "wsj.com",
  "wtop.com",
  "wral.com",
  "xinhuanet.com",
  "yicai.com",
]);

const SOURCE_LABELS = new Map([
  ...VERIFIED_ISSUERS.entries(),
  ["21jingji.com", "21世纪经济报道"],
  ["apnews.com", "Associated Press"],
  ["barrons.com", "Barron's"],
  ["bloomberg.com", "Bloomberg"],
  ["caixin.com", "财新"],
  ["cls.cn", "财联社"],
  ["chnfund.com", "中国基金报"],
  ["cnbc.com", "CNBC"],
  ["cnstock.com", "上海证券报"],
  ["conference-board.org", "The Conference Board"],
  ["finance.eastmoney.com", "东方财富"],
  ["finance.sina.com.cn", "新浪财经"],
  ["finance.yahoo.com", "Yahoo Finance"],
  ["fred.stlouisfed.org", "Federal Reserve Economic Data"],
  ["ft.com", "Financial Times"],
  ["kiplinger.com", "Kiplinger"],
  ["marketwatch.com", "MarketWatch"],
  ["nbd.com.cn", "每日经济新闻"],
  ["reuters.com", "Reuters"],
  ["stcn.com", "证券时报"],
  ["csindex.com.cn", "中证指数有限公司"],
  ["gtimg.cn", "腾讯证券行情"],
  ["nasdaq.com", "Nasdaq"],
  ["nyse.com", "New York Stock Exchange"],
  ["sse.com.cn", "上海证券交易所"],
  ["szse.cn", "深圳证券交易所"],
  ["thepaper.cn", "澎湃新闻"],
  ["wsj.com", "The Wall Street Journal"],
  ["wral.com", "WRAL"],
  ["xinhuanet.com", "新华社"],
  ["yicai.com", "第一财经"],
]);

export function publishableExternalSourceDomains() {
  return [
    ...new Set([
      ...FIRST_PARTY_SOURCE_DOMAINS,
      ...ESTABLISHED_PUBLISHER_HOSTS,
    ]),
  ].sort();
}

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function verifiedFirstPartyIssuerLabel(source) {
  let hostname; try { hostname = new URL(source).hostname.toLowerCase(); } catch { return null; }
  for (const [domain, label] of VERIFIED_ISSUERS) if (hostnameMatches(hostname, domain)) return label;
  return null;
}

export function verifiedFirstPartyIssuerIdentity(source) {
  let hostname; try { hostname = new URL(source).hostname.toLowerCase(); } catch { return null; }
  const filing = FILING_ISSUERS.find(record => hostnameMatches(hostname, record.domain));
  if (filing) return { domain: filing.domain, label: filing.label };
  for (const [domain, label] of VERIFIED_ISSUERS) if (hostnameMatches(hostname, domain)) return { domain, label };
  return null;
}

export function verifiedExternalSourceType(source, platform = "web") {
  if (platform === "x") return "expert";
  let hostname, pathname;
  try {
    const url = new URL(source);
    hostname = url.hostname.toLocaleLowerCase();
    pathname = url.pathname.toLocaleLowerCase();
  } catch {
    return "expert";
  }
  // Exchange-hosted editorial and syndicated releases are reporting, not an
  // issuer/regulator's primary disclosure merely because of the host name.
  if (hostnameMatches(hostname, "nasdaq.com") && /^\/(?:articles|press-release|news-and-insights)(?:\/|-|$)/u.test(pathname)) return "publisher";
  if ((hostname === "e.nyse.com" && pathname === "/mac-desk-midday-market-update") || (hostnameMatches(hostname, "nyse.com") && pathname === "/xbcf7t9")) return "publisher";
  if (
    FIRST_PARTY_SOURCE_DOMAINS.some((domain) =>
      hostnameMatches(hostname, domain),
    )
  ) {
    return "first_party";
  }
  const publisherHostname = hostname.replace(/^www\./u, "");
  if (
    [...ESTABLISHED_PUBLISHER_HOSTS].some((domain) =>
      hostnameMatches(publisherHostname, domain),
    )
  ) {
    return "publisher";
  }
  return "expert";
}

export function isPublishableExternalSource(source, platform = "web") {
  return verifiedExternalSourceType(source, platform) !== "expert";
}

export function verifiedExternalSourceLabel(source) {
  let hostname;
  try {
    hostname = new URL(source).hostname.toLocaleLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
  for (const [domain, label] of SOURCE_LABELS) {
    if (hostnameMatches(hostname, domain)) return label;
  }
  return hostname;
}
