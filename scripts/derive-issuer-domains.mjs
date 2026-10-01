import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sourceBodyText } from "./daily-source-audit.mjs";
import { secFilingIssuerIdentity, secCompanySubmissionTime } from "./sec-filing-identity.mjs";
import { issuerDeclaredDomain, validateIssuerDomainRecords } from "./issuer-domain-identity.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function original(receipt) {
  const body = Buffer.from(receipt.bodyBase64, "base64");
  if (!body.length || body.length > 8 * 1024 * 1024 || body.toString("base64") !== receipt.bodyBase64 || digest(body) !== receipt.bodyHash || receipt.status !== 200) throw new Error("发行人身份原文字节或响应不一致");
  return body;
}

export function deriveIssuerDomainRecords(book) {
  if (book.registry?.url !== "https://www.sec.gov/files/company_tickers.json" || book.registry.finalUrl !== book.registry.url || book.registry.contentType.split(";", 1)[0] !== "application/json") throw new Error("缺少官方股票代码原文");
  const registry = JSON.parse(original(book.registry)), records = [], gaps = [];
  for (const filing of book.filings) {
    const rawBody = original(filing.snapshot);
    const issuer = secFilingIssuerIdentity({ finalUrl: filing.snapshot.finalUrl, rawBody });
    const entities = Object.values(registry).filter(item => item.ticker === filing.symbol);
    const profiles = book.profiles.filter(item => item.symbol === filing.symbol);
    const receipt = profiles[0]?.receipt, profile = receipt ? JSON.parse(original(receipt)) : null;
    const profileUrl = issuer ? `https://data.sec.gov/submissions/CIK${issuer.cik.padStart(10, "0")}.json` : null;
    if (!issuer || !["10-K", "20-F", "40-F"].includes(issuer.form) || !issuer.symbols.includes(filing.symbol) || !/(?:html|xhtml)/iu.test(filing.snapshot.contentType) || filing.snapshot.source !== filing.snapshot.finalUrl || entities.length !== 1 || String(entities[0].cik_str) !== issuer.cik || profiles.length !== 1 || receipt.url !== profileUrl || receipt.finalUrl !== profileUrl || receipt.contentType.split(";", 1)[0] !== "application/json" || String(Number(profile.cik)) !== issuer.cik || !profile.name?.trim() || !profile.tickers?.includes(filing.symbol) || secCompanySubmissionTime(original(receipt), filing.snapshot.finalUrl).length !== 1) throw new Error("年报发行人、股票代码和受理记录未对应同一身份");
    const text = sourceBodyText(rawBody, filing.snapshot.contentType);
    const declarations = [...text.matchAll(/\b(?:our (?:(?:corporate|internet) )?(?:website|web site|internet address)|the company(?:'|’)s website)[^\n]{0,650}/giu)].map(match => match[0]);
    const declaration = declarations.find(value => issuerDeclaredDomain(value));
    if (!declaration) { gaps.push({ symbol: filing.symbol, reason: "年报未包含可唯一提取的根域名自身声明" }); continue; }
    const domain = issuerDeclaredDomain(declaration), at = declaration.toLowerCase().indexOf(domain);
    // The exact self-owned clause ends at its original domain. It cannot
    // accidentally include a later SEC/competitor domain in the paragraph.
    records.push({ symbol: filing.symbol, cik: issuer.cik, label: profile.name, domain, identityEvidence: filing.snapshot.finalUrl, bodyHash: filing.snapshot.bodyHash, declaration: declaration.slice(0, at + domain.length + (/^[.,;]/u.test(declaration.slice(at + domain.length)) ? 1 : 0)) });
  }
  return { records: validateIssuerDomainRecords(records), gaps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const book = JSON.parse(await readFile(process.argv[2], "utf8"));
  process.stdout.write(JSON.stringify(deriveIssuerDomainRecords(book), null, 2) + "\n");
}
