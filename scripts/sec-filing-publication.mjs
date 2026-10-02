import { newYorkPublicationDate } from "./fed-speech-publication.mjs";

export const SEC_FILING_PUBLICATION_VERSION = "bound-sec-filing-availability-v1";

function acceptanceInstant(raw) {
  if (!/^20\d{12}$/u.test(raw)) return null;
  const parts = [raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8), raw.slice(8, 10), raw.slice(10, 12), raw.slice(12)];
  const nominal = Date.parse(`${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}:${parts[4]}:${parts[5]}Z`);
  if (!Number.isFinite(nominal)) return null;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const matches = [4, 5].map(hours => new Date(nominal + hours * 3_600_000)).filter(date => {
    const local = Object.fromEntries(formatter.formatToParts(date).map(item => [item.type, item.value]));
    return [local.year, local.month, local.day, local.hour, local.minute, local.second].join("") === raw;
  });
  return matches.length === 1 ? matches[0].toISOString() : null;
}

// Bind filing availability to the exact accession, filer and document. The
// acceptance clock never establishes an earlier issuer announcement time.
export function secFilingPublicationRecord(articleBody, submissionBody, source, textFromHtml) {
  let url; try { url = new URL(source); } catch { return null; }
  const path = /^\/Archives\/edgar\/data\/([1-9]\d*)\/(\d{18})\/([A-Za-z0-9._-]+\.(?:htm|html))$/u.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.sec.gov" || url.search || url.hash || !path || typeof textFromHtml !== "function") return null;
  const [, cik, accession, filename] = path;
  const id = `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}`;
  const submission = Buffer.from(submissionBody).toString("utf8");
  const headers = [...submission.matchAll(/<SEC-HEADER>([\s\S]*?)<\/SEC-HEADER>/gu)];
  if (headers.length !== 1) return null;
  const header = headers[0][1];
  const one = pattern => { const matches = [...header.matchAll(pattern)]; return matches.length === 1 ? matches[0][1].trim() : null; };
  const headerId = one(/^ACCESSION NUMBER:\s*([^\r\n]+)/gmu);
  const filed = one(/^FILED AS OF DATE:\s*([^\r\n]+)/gmu);
  const issuerName = one(/^\s*COMPANY CONFORMED NAME:\s*([^\r\n]+)/gmu);
  const issuerCik = one(/^\s*CENTRAL INDEX KEY:\s*(\d+)[ \t]*$/gmu);
  const form = one(/^CONFORMED SUBMISSION TYPE:\s*([^\r\n]+)/gmu);
  const acceptance = one(/^<ACCEPTANCE-DATETIME>(\d+)[ \t]*$/gmu);
  const publishedAt = acceptanceInstant(acceptance ?? "");
  const documentHeaders = [...submission.matchAll(/^<SEC-DOCUMENT>([^\r\n]+)/gmu)];
  if (!publishedAt || headerId !== id || !issuerName || !issuerCik || BigInt(issuerCik) !== BigInt(cik) || !/^[A-Z0-9/-]+$/u.test(form ?? "") || documentHeaders.length !== 1 || documentHeaders[0][1].trim() !== `${id}.txt : ${filed}` || header.slice(0, header.indexOf("\n")).trim() !== `${id}.hdr.sgml : ${filed}` || filed !== newYorkPublicationDate(publishedAt).replaceAll("-", "") || filed.slice(2, 4) !== accession.slice(10, 12)) return null;
  const documents = [...submission.matchAll(/<DOCUMENT>\s*([\s\S]*?)<\/DOCUMENT>/gu)].map(match => match[1]);
  const matching = documents.filter(document => [...document.matchAll(/^<FILENAME>([^\r\n]+)/gmu)].some(match => match[1].trim() === filename));
  if (matching.length !== 1) return null;
  const document = matching[0], names = [...document.matchAll(/^<FILENAME>([^\r\n]+)/gmu)], types = [...document.matchAll(/^<TYPE>([^\r\n]+)/gmu)], texts = [...document.matchAll(/<TEXT>\s*([\s\S]*?)<\/TEXT>/gu)];
  if (names.length !== 1 || types.length !== 1 || texts.length !== 1 || !/^[A-Z0-9./-]+$/u.test(types[0][1].trim())) return null;
  const article = Buffer.from(articleBody).toString("utf8");
  let html = article;
  if (article.includes("<DOCUMENT>")) {
    const wrappers = [...article.matchAll(/<DOCUMENT>\s*([\s\S]*?)<\/DOCUMENT>/gu)];
    if (wrappers.length !== 1) return null;
    const bodyNames = [...wrappers[0][1].matchAll(/^<FILENAME>([^\r\n]+)/gmu)], bodyTypes = [...wrappers[0][1].matchAll(/^<TYPE>([^\r\n]+)/gmu)], bodyTexts = [...wrappers[0][1].matchAll(/<TEXT>\s*([\s\S]*?)<\/TEXT>/gu)];
    if (bodyNames.length !== 1 || bodyNames[0][1].trim() !== filename || bodyTypes.length !== 1 || bodyTypes[0][1].trim() !== types[0][1].trim() || bodyTexts.length !== 1) return null;
    html = bodyTexts[0][1];
  }
  const visible = value => textFromHtml(Buffer.from(value), "text/html").replace(/\s+/gu, " ").trim();
  const originalText = visible(html);
  if (originalText.length < 80 || originalText !== visible(texts[0][1])) return null;
  return { version: SEC_FILING_PUBLICATION_VERSION, accession: id, cik, issuerName, form, documentType: types[0][1].trim(), filename, publicationDate: newYorkPublicationDate(publishedAt), publishedAt, metadataUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${id}.txt`, timeBasis: "sec_filing_availability" };
}
