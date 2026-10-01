import { backgroundEvidenceInWindow, isCalendarDate, officialReleaseDateInWindow } from "./evidence-timing.mjs";

export const CORPORATE_ACTION_EVIDENCE_VERSION = "verified-cn-cash-schedule-v1";
const normalized = value => String(value ?? "").normalize("NFKC");
const calendar = value => {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/u.exec(value);
  const date = match && `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return isCalendarDate(date) ? date : null;
};
const DATE = "(\\d{4}/\\d{1,2}/\\d{1,2})";
const TABLE = `股份类别\\s+股权登记日\\s+最后交易日\\s+除权\\(息\\)日\\s+现金红利发放日\\s+A\\s*股\\s+${DATE}\\s+[－—–-]\\s+${DATE}\\s+${DATE}(?=\\s|$)`;

function rows(text) {
  return [...normalized(text).matchAll(new RegExp(TABLE, "gu"))].map(match => ({ recordDate: calendar(match[1]), effectiveDate: calendar(match[2]), cashPaymentDate: calendar(match[3]) }));
}

// This supports the inspected repeated A-share cash schedule, not arbitrary
// tables, H-share elections, bonus/rights issues or an inferred effective date.
export function cninfoCashDividendSchedule(text) {
  const body = normalized(text), dates = rows(body);
  if (dates.length !== 2 || dates.some(row => Object.values(row).some(date => !date)) || JSON.stringify(dates[0]) !== JSON.stringify(dates[1])) return null;
  const summaries = [...body.matchAll(/A\s*股(?:年度|中期)?每股现金红利人民币\s*(\d+(?:\.\d+)?)\s*元\s*\(含税\)/gu)];
  const details = [...body.matchAll(/本次\s*A\s*股(?:利润分配|权益分派)[\s\S]{0,220}?每股派发现金红利\s*人民币\s*(\d+(?:\.\d+)?)\s*元\s*\(含税\)/gu)];
  if (summaries.length !== 1 || details.length !== 1 || Number(summaries[0][1]) !== Number(details[0][1])) return null;
  const amount = Number(summaries[0][1]);
  const { recordDate, effectiveDate, cashPaymentDate } = dates[0];
  if (!Number.isFinite(amount) || amount <= 0 || recordDate >= effectiveDate || cashPaymentDate < effectiveDate) return null;
  return { type: "cash_dividend_schedule", shareClass: "A", currency: "CNY", perShareCash: amount, recordDate, effectiveDate, cashPaymentDate, status: "announced_schedule" };
}

export function verifiedCurrentCorporateAction(source, opened, envelope) {
  if (source.kind !== "corporate_action") return null;
  const pdf = opened.pdfDocument, issuer = pdf?.issuer;
  if (envelope.market !== "CN" || new URL(opened.finalUrl).origin !== "https://static.cninfo.com.cn" || !/^application\/pdf(?:;|$)/iu.test(opened.contentType ?? "") || !issuer || source.role !== "facts" || source.scope !== "company" || source.targets?.length !== 1 || source.targets[0] !== issuer.symbol || source.causalConnection !== false || source.comparisons?.length || pdf.publishedDateCandidates?.length !== 1 || source.publishedAt !== pdf.publishedDateCandidates[0]) throw new Error("公司行动必须来自对应发行人的完整一手 PDF、公司范围及原始发布日期");
  if (!/(?:利润|权益)分派(?:A股)?实施公告$/u.test(normalized(pdf.title).replace(/\s+/gu, ""))) throw new Error("公司行动公告类型不属于已核验的 A 股分派实施格式");
  const action = cninfoCashDividendSchedule(opened.text);
  if (!action || action.effectiveDate !== envelope.marketAsOf || action.recordDate !== envelope.session.previousAsOf || source.publishedAt > action.recordDate || !(officialReleaseDateInWindow(source.publishedAt, envelope) || backgroundEvidenceInWindow(source.publishedAt, envelope))) throw new Error("公司行动的两处 A 股日期表、含税金额或本期生效日未由原文一致确认");
  const quote = normalized(source.supportingExcerpt), quotedDates = rows(quote);
  const amount = /A\s*股(?:年度|中期)?每股现金红利人民币\s*(\d+(?:\.\d+)?)\s*元\s*\(含税\)/u.exec(quote);
  if (!quote.includes(issuer.name) || !amount || Number(amount[1]) !== action.perShareCash || !quotedDates.length || quotedDates.some(row => JSON.stringify(row) !== JSON.stringify({ recordDate: action.recordDate, effectiveDate: action.effectiveDate, cashPaymentDate: action.cashPaymentDate }))) throw new Error("公司行动引文必须保留发行人、A 股含税金额和完整对应日期表");
  return { version: CORPORATE_ACTION_EVIDENCE_VERSION, symbol: issuer.symbol, sourcePublicationDate: source.publishedAt, ...action, limitation: "Official announced cash schedule only; not proof that cash was credited, an exchange reference price, total investor return or whole-sector causality. Publication date and effective date are distinct." };
}

export function isVerifiedCurrentCorporateAction(source, envelope) {
  const a = source.corporateAction;
  return source.kind === "corporate_action" && source.corporateActionChecked === true && a?.version === CORPORATE_ACTION_EVIDENCE_VERSION && a.status === "announced_schedule" && a.type === "cash_dividend_schedule" && a.shareClass === "A" && a.currency === "CNY" && typeof a.perShareCash === "number" && Number.isFinite(a.perShareCash) && a.perShareCash > 0 && envelope.market === "CN" && a.effectiveDate === envelope.marketAsOf && a.recordDate === envelope.session.previousAsOf && isCalendarDate(a.cashPaymentDate) && a.cashPaymentDate >= a.effectiveDate && isCalendarDate(a.sourcePublicationDate) && a.sourcePublicationDate === source.publishedAt && a.sourcePublicationDate <= a.recordDate && (officialReleaseDateInWindow(source.publishedAt, envelope) || backgroundEvidenceInWindow(source.publishedAt, envelope)) && source.role === "facts" && source.scope === "company" && source.targets?.length === 1 && source.targets[0] === a.symbol && source.companySubjects?.length === 1 && source.companySubjects[0] === a.symbol && source.causalConnection === false && !source.comparisons?.length;
}
