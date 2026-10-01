import { createHash } from "node:crypto";
import { verifiedFirstPartyIssuerIdentity } from "./source-registry.mjs";

export const COMPANY_OUTLOOK_VERSION = "verified-company-outlook-v1";
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// This first supported form is deliberately bounded: an identified issuer's
// own revision of a named segment's revenue-growth outlook for a future FY.
// Other forecast forms keep the existing financial-result gate until their
// subject, period and metric can be reconstructed from the original too.
export function companyOutlookDefinitions(source, original, companySubjects = source.companySubjects ?? []) {
  if (source.role !== "facts" || source.sourceType !== "first_party" || source.scope !== "company" || !["official", "event"].includes(source.kind) || source.causalConnection || source.targets?.length !== 1) return [];
  const issuer = verifiedFirstPartyIssuerIdentity(original.finalUrl);
  if (!issuer?.symbol || issuer.symbol !== source.targets[0] || companySubjects.length !== 1 || companySubjects[0] !== issuer.symbol) return [];
  const publishedYear = Number(/^((?:19|20)\d{2})-/u.exec(source.publishedAt ?? "")?.[1]);
  if (!publishedYear) return [];
  const actor = [issuer.symbol, issuer.label].map(escape).join("|");
  const pattern = new RegExp(`(?:^|(?<=[.!?])\\s)(?<statement>(?:${actor}) (?:is (?<present>raising|lowering)|(?<past>raised|lowered)) its (?<period>FY(?:20\\d{2}|\\d{2})) (?<business>[A-Za-z][A-Za-z0-9 &/-]{0,59}) segment revenue growth outlook to (?<value>[^.!?;]{5,160})\\.)`, "gu");
  const excerpt = clean(source.supportingExcerpt), body = clean(original.text);
  const definitions = [];
  for (const match of excerpt.matchAll(pattern)) {
    const { statement, present, past, period, business, value } = match.groups;
    const fiscalYear = Number(period.slice(2)) + (period.length === 4 ? 2000 : 0);
    if (fiscalYear <= publishedYear || fiscalYear > publishedYear + 5 || !body.includes(statement) || /\b(?:actual|reported|realized|consensus|beat|miss|previous|prior|compared|versus)\b/iu.test(value)) continue;
    const revision = /rais/u.test(present ?? past) ? "raised" : "lowered";
    definitions.push({ version: COMPANY_OUTLOOK_VERSION, issuer: issuer.symbol, nature: "prospective_management_outlook", fiscalYear, period, business, metric: "segment_revenue_growth", revision, statement, statementHash: hash(statement), ...outlookCopy({ issuer: issuer.symbol, period, business, revision }) });
  }
  return [...new Map(definitions.map(definition => [definition.statementHash, definition])).values()];
}

function outlookCopy({ issuer, period, business, revision }) {
  return {
    copyEn: `${issuer} ${revision} its prospective ${period} ${business} segment revenue-growth outlook. This remains management's prospective forecast and has not been realized.`,
    copyZh: `${issuer}${revision === "raised" ? "上调" : "下调"}${period} ${business}业务营收增长展望。这仍是公司的前瞻性预测，尚未实现。`,
  };
}

export function verifiedCompanyOutlooks(sources) {
  return sources.flatMap(source => {
    if (source.companyOutlookEvidenceVersion !== COMPANY_OUTLOOK_VERSION || source.companySubjectChecked !== true) return [];
    const derived = companyOutlookDefinitions(source, { finalUrl: source.url, text: source.supportingExcerpt });
    if (JSON.stringify(derived) !== JSON.stringify(source.companyOutlooks)) throw new Error("公司展望定义与已核验的发行人、原始引文或未来财年不一致");
    return derived;
  });
}

// Never exempt an arbitrary sentence merely because it says "forecast".
// Only the code-derived, explicitly prospective bilingual description can be
// removed before applying the ordinary gate to the remaining financial copy.
// Mixed results and surprise claims still require actual/baseline comparisons.
export function prospectiveCompanyCopyRemainder(copy, definitions) {
  let remainder = clean(copy), matched = false;
  for (const definition of definitions) {
    if (definition.version !== COMPANY_OUTLOOK_VERSION || definition.nature !== "prospective_management_outlook" || definition.metric !== "segment_revenue_growth" || !["raised", "lowered"].includes(definition.revision) || definition.statementHash !== hash(definition.statement)) throw new Error("公司展望描述未绑定有效原文定义");
    const canonical = outlookCopy(definition);
    if (canonical.copyEn !== definition.copyEn || canonical.copyZh !== definition.copyZh) throw new Error("公司展望描述与代码生成的预测口径不一致");
    for (const sentence of [canonical.copyEn, canonical.copyZh]) {
      if (remainder.includes(sentence)) {
        remainder = remainder.replaceAll(sentence, " ");
        matched = true;
      }
    }
  }
  return { remainder: clean(remainder), matched };
}

export function hasUnverifiedResultOrSurprise(copy) {
  return /\b(?:beat|beating|miss|missed|consensus|outperformed|underperformed|realized|achieved|delivered|recorded|posted|reported results|topped estimates|exceeded estimates)\b|超(?:出|过)?预期|不及预期|高于预期|低于预期|好于预期|逊于预期|一致预期|实际(?:收入|营收|业绩|利润)|已实现|已经实现|录得|实现了/iu.test(copy);
}

export function hasOtherFinancialStatement(copy) {
  const remaining = copy.replace(/\b(?:earnings expectations|expected earnings)\b/giu, " ");
  return /财报|业绩|季报|年报|营收|收入|利润|每股收益|指引|\b(?:revenue|sales|profit|income|eps|guidance|earnings|financial results?|quarterly results?)\b/iu.test(remaining);
}

export function assertCompanyOutlookDescriptions(copy, definitions, label, language) {
  const value = clean(copy);
  for (const definition of definitions) {
    const descriptions = language === "zh" ? [definition.copyZh] : language === "en" ? [definition.copyEn] : [definition.copyZh, definition.copyEn];
    if (!descriptions.some(description => value.includes(description))) throw new Error(`${label} 缺少对应公司展望的完整预测描述`);
  }
}
