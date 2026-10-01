import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { issuerDeclaredDomain, validateIssuerDomainRecords } from "../scripts/issuer-domain-identity.mjs";
import { deriveIssuerDomainRecords } from "../scripts/derive-issuer-domains.mjs";
import issuerDomains from "../data/issuer-domains.json" with { type: "json" };
import { verifiedExternalSourceType, verifiedFirstPartyIssuerIdentity } from "../scripts/source-registry.mjs";

const registryUrl = "https://www.sec.gov/files/company_tickers.json", profileUrl = "https://data.sec.gov/submissions/CIK0001645590.json";
const filingUrl = "https://www.sec.gov/Archives/edgar/data/1645590/000164559026000001/hpe.htm";
function receipt(url, value, contentType = "application/json") {
  const rawBody = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return { url, source: url, finalUrl: url, status: 200, contentType, bodyHash: createHash("sha256").update(rawBody).digest("hex"), bodyBase64: rawBody.toString("base64") };
}
function book(declaration = "Our website is located at www.hpe.com.") {
  const html = '<ix:nonNumeric name="dei:EntityCentralIndexKey">1645590</ix:nonNumeric><ix:nonNumeric name="dei:EntityRegistrantName">Hewlett Packard Enterprise Co</ix:nonNumeric><ix:nonNumeric name="dei:TradingSymbol">HPE</ix:nonNumeric><ix:nonNumeric name="dei:DocumentType">10-K</ix:nonNumeric>' + `<p>A competitor uses www.competitor.com. ${declaration} The SEC website is www.sec.gov.</p>`;
  return { registry: receipt(registryUrl, { 0: { ticker: "HPE", cik_str: 1645590 } }), profiles: [{ symbol: "HPE", receipt: receipt(profileUrl, { cik: 1645590, name: "Hewlett Packard Enterprise Co", tickers: ["HPE"], filings: { recent: { accessionNumber: ["0001645590-26-000001"], primaryDocument: ["hpe.htm"], acceptanceDateTime: ["2026-01-28T14:00:00Z"] } } }) }], filings: [{ symbol: "HPE", snapshot: receipt(filingUrl, html, "text/html") }] };
}

test("issuer domains deterministically retain their exact self-owned declaration, original hash and verified ticker identity", () => {
  const value = book(), derived = deriveIssuerDomainRecords(value);
  assert.deepEqual(derived.gaps, []); assert.equal(derived.records.length, 1);
  assert.equal(derived.records[0].domain, "hpe.com"); assert.equal(derived.records[0].symbol, "HPE");
  assert.equal(derived.records[0].bodyHash, value.filings[0].snapshot.bodyHash);
  assert.equal(derived.records[0].declaration, "Our website is located at www.hpe.com.");
  assert.deepEqual(deriveIssuerDomainRecords(value), derived);
  assert.deepEqual(deriveIssuerDomainRecords(book("The company uses a supplier's website www.other.com.")).records, []);
  for (const quote of ["A competitor's website is www.other.com.", "Contact us at person@example.com.", "Our website has links to www.sec.gov.", "Our website is https://ir.other.com.", "Our website is https://other.com.evil.example."]) assert.equal(issuerDeclaredDomain(quote), null);
});

test("substituted original bytes, wrong issuer filings and altered profile ticker identities cannot identify an official domain", () => {
  const value = book();
  for (const mutate of [
    b => b.filings[0].snapshot.bodyHash = "0".repeat(64),
    b => b.filings[0].snapshot.finalUrl = filingUrl.replace("data/1645590", "data/999"),
    b => b.profiles[0].receipt = receipt(profileUrl, { cik: 1645590, name: "Wrong issuer", tickers: ["OTHER"] }),
    b => b.registry = receipt(registryUrl, { 0: { ticker: "HPE", cik_str: 999 } }),
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => deriveIssuerDomainRecords(changed)); }
  for (const mutate of [r => r.domain = "competitor.com", r => r.cik = "999", r => r.bodyHash = "invalid", r => r.identityEvidence = "https://mirror.example/hpe.htm"]) {
    const record = structuredClone(deriveIssuerDomainRecords(value).records[0]); mutate(record); assert.throws(() => validateIssuerDomainRecords([record]));
  }
});

test("reviewed annual declarations expand corporate identity without promoting lookalikes, social commentary or independent performance claims", () => {
  assert.equal(validateIssuerDomainRecords(issuerDomains), issuerDomains); assert.equal(issuerDomains.length, 27);
  for (const record of issuerDomains) {
    assert.equal(verifiedExternalSourceType(`https://www.${record.domain}/news/release`), "first_party");
    assert.equal(verifiedFirstPartyIssuerIdentity(`https://investors.${record.domain}/release`).domain, record.domain);
    assert.equal(verifiedExternalSourceType(`https://www.${record.domain}.evil.example/release`), "expert");
    assert.equal(verifiedExternalSourceType(`https://www.${record.domain}/release`, "x"), "expert");
  }
  assert.equal(verifiedExternalSourceType("https://semianalysis.com/report"), "expert");
  assert.equal(verifiedExternalSourceType("https://trendforce.com/news"), "expert");
  assert.equal(verifiedExternalSourceType("https://e.nyse.com/mac-desk-midday-market-update"), "publisher");
  assert.equal(verifiedExternalSourceType("https://www.nyse.com/xbcf7t9"), "publisher");
  assert.equal(verifiedExternalSourceType("https://www.nyse.com/market-data/quotes"), "first_party");
});
