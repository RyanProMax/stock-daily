import { sourceBodyText } from "./daily-source-audit.mjs";

export function secArchiveIdentity(source) {
  let url; try { url = new URL(source); } catch { return null; }
  const match = /^\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})\/([^/]+\.html?)$/u.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.sec.gov" || url.username || url.password || (url.port && url.port !== "443") || url.search || url.hash || !match || Number(match[1]) <= 0) return null;
  return { cik: String(Number(match[1])), accession: `${match[2].slice(0, 10)}-${match[2].slice(10, 12)}-${match[2].slice(12)}`, document: match[3] };
}

export function secCompanySubmissionsUrl(source) {
  const identity = secArchiveIdentity(source);
  return identity ? `https://data.sec.gov/submissions/CIK${identity.cik.padStart(10, "0")}.json` : null;
}

export function secCompanySubmissionTime(submissionBody, source) {
  const identity = secArchiveIdentity(source);
  if (!identity) return [];
  try {
    const value = JSON.parse(Buffer.isBuffer(submissionBody) ? submissionBody.toString("utf8") : submissionBody);
    if (String(Number(value.cik)) !== identity.cik) return [];
    const recent = value.filings?.recent;
    if (!recent || !Array.isArray(recent.accessionNumber) || recent.accessionNumber.length > 10_000 || !Array.isArray(recent.primaryDocument) || !Array.isArray(recent.acceptanceDateTime) || recent.primaryDocument.length !== recent.accessionNumber.length || recent.acceptanceDateTime.length !== recent.accessionNumber.length) return [];
    const indices = recent.accessionNumber.flatMap((accession, index) => accession === identity.accession ? [index] : []);
    if (indices.length !== 1 || recent.primaryDocument[indices[0]] !== identity.document) return [];
    const time = recent.acceptanceDateTime[indices[0]];
    if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(time) || !Number.isFinite(Date.parse(time)) || new Date(`${time.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== time.slice(0, 10)) return [];
    return [new Date(time).toISOString()];
  } catch { return []; }
}

export function secFilingIssuerIdentity(opened) {
  const archive = secArchiveIdentity(opened.finalUrl);
  if (!archive || !Buffer.isBuffer(opened.rawBody) || opened.rawBody.length > 8 * 1024 * 1024) return null;
  const values = new Map();
  for (const match of opened.rawBody.toString("utf8").matchAll(/<ix:nonNumeric\b[^>]*\bname=["']dei:(EntityCentralIndexKey|EntityRegistrantName|TradingSymbol|DocumentType)["'][^>]*>([\s\S]*?)<\/ix:nonNumeric\s*>/giu)) {
    const key = match[1].toLowerCase(), text = sourceBodyText(Buffer.from(match[2]));
    const set = values.get(key) ?? new Set(); set.add(text); values.set(key, set);
  }
  const ciks = [...(values.get("entitycentralindexkey") ?? [])].map(value => String(Number(value)));
  const names = [...(values.get("entityregistrantname") ?? [])];
  const forms = [...(values.get("documenttype") ?? [])];
  const symbols = [...(values.get("tradingsymbol") ?? [])].filter(value => /^[A-Z0-9][A-Z0-9.-]{0,11}$/u.test(value));
  if (!ciks.length || ciks.some(cik => cik !== archive.cik) || names.length !== 1 || !names[0] || forms.length !== 1 || !symbols.length) return null;
  return { ...archive, name: names[0], form: forms[0], symbols: symbols.sort() };
}
