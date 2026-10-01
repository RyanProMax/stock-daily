// Only an explicit self-owned website declaration identifies a corporate
// domain. A competitor, SEC link, email address or a document hyperlink does
// not. The reviewed records retain the exact declaration and filing hash.
export function issuerDeclaredDomain(quote) {
  const match = /\b(?:our (?:(?:corporate|internet) )?(?:website|web site|internet address)|the company(?:'|’)s website)\s*(?:address\s*)?(?:is\s*(?:located\s*)?(?:at\s*)?|(?:,\s*)?(?:which is located\s*)?at\s*|,\s*|\s+)\s*(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?=[\s/.,;)]|$)/iu.exec(quote);
  if (!match) return null;
  const domain = match[1].toLowerCase();
  if (!/^[a-z0-9-]+\.(?:com|ai)$/u.test(domain) || /^(?:sec|example)\./u.test(domain)) return null;
  return domain;
}

export function validateIssuerDomainRecords(records) {
  if (!Array.isArray(records)) throw new Error("发行人域名身份记录无效");
  const symbols = new Set(), domains = new Set();
  for (const record of records) {
    const source = new URL(record.identityEvidence);
    const filing = /^\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})\/[^/]+\.html?$/u.exec(source.pathname);
    if (!/^[A-Z]{1,6}(?:[.-][A-Z])?$/u.test(record.symbol) || !/^\d{1,10}$/u.test(record.cik) || !record.label?.trim() || source.protocol !== "https:" || source.hostname !== "www.sec.gov" || source.username || source.password || source.port || source.search || source.hash || !filing || Number(filing[1]) !== Number(record.cik) || !/^[a-f0-9]{64}$/u.test(record.bodyHash) || typeof record.declaration !== "string" || record.declaration.length > 700 || issuerDeclaredDomain(record.declaration) !== record.domain || symbols.has(record.symbol) || domains.has(record.domain)) throw new Error("发行人域名未由唯一的自身声明、申报身份及原文哈希确认");
    symbols.add(record.symbol); domains.add(record.domain);
  }
  return records;
}
