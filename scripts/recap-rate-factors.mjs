import { stableHash } from "./daily-workflow-core.mjs";
import { normalizedEvidenceText } from "./daily-source-audit.mjs";
import { validateRecapMacroData } from "./recap-macro-data.mjs";

const TERMS = { twoYear: 2, tenYear: 10, thirtyYear: 30 };
const dayName = date => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${date}T12:00:00Z`));

export function hasUnknownRatePublication(value) {
  return /\bpublication(?:\s+(?:time|timestamp|hour))?\b[^.!?]{0,80}\b(?:unknown|unverified)\b|\b(?:unknown|unverified)\b[^.!?]{0,80}\bpublication\b|(?:公布时刻|发布时间)[^。！？]{0,30}(?:未知|未核实)|(?:未知|未核实)[^。！？]{0,30}(?:公布时刻|发布时间)/iu.test(value);
}

// These are independently reconstructed observations, never quoted prose or
// newly timed announcements. Only the validated original Treasury book can
// create them; a model cannot declare one by copying a domain or an ID.
export function verifiedRecapRateFactors(book, envelope) {
  if (!book) return [];
  validateRecapMacroData(book, envelope);
  if (envelope.market !== "US" || !book.context || book.context.dataDate !== envelope.marketAsOf) return [];
  const context = book.context, bookHash = stableHash(book);
  return Object.entries(TERMS).map(([term, years]) => {
    const values = context.rates[term];
    const motion = values.changeBasisPoints > 0 ? "rose" : values.changeBasisPoints < 0 ? "fell" : "was unchanged";
    const summary = `${years}-year U.S. Treasury interpolated par yield observation ${motion} to ${values.display}; previous session level ${values.previousDisplay}; change ${values.changeBasisPoints > 0 ? "+" : ""}${values.changeBasisPoints.toFixed(2)} basis points. 观测日期 ${context.dataDate}，前一交易日 ${context.previousDataDate}。`;
    return {
      id: stableHash(`${bookHash}|${term}`).slice(0, 20), role: "facts", kind: "macro_observation", scope: "market_variable", targets: [`US-Treasury-${years}Y-par`], anomalyId: "treasury-observation",
      sourceType: "first_party", url: context.source, originalUrl: context.originalSource,
      sourceLabel: `U.S. Treasury · ${years}-year yield observation`,
      publishedAt: context.dataDate, timePrecision: "date", dataDate: context.dataDate,
      verifiedAt: book.snapshots.map(item => item.fetchedAt).sort().at(-1), excerptHash: stableHash(normalizedEvidenceText(summary)),
      supportingExcerpt: summary, facts: summary, excerptType: "derived_data", comparisons: [], causalConnection: false,
      observationOnly: true, timingChecked: false, publicationTimeKnown: false,
      term, years, values, macroBookHash: bookHash, limitations: context.limitations,
    };
  });
}

export function verifiedRateFactor(source, book, envelope) {
  if (source?.kind !== "macro_observation" || !book) return false;
  const original = verifiedRecapRateFactors(book, envelope).find(item => item.id === source.id);
  return Boolean(original && stableHash(original) === stableHash(source));
}

export function mergeRecapRateFactors(ledger, book, envelope) {
  const factors = verifiedRecapRateFactors(book, envelope);
  return { ...ledger, sources: [...ledger.sources.filter(source => source.kind !== "macro_observation"), ...factors] };
}

export function auditRecapRateFactors(ledger, book, envelope) {
  const expected = verifiedRecapRateFactors(book, envelope), actual = ledger.sources.filter(source => source.kind === "macro_observation");
  if (stableHash(actual) !== stableHash(expected)) throw new Error("财政部观测引用未由原始数据重建，或观测被伪装为有发布时间的新闻");
}

export function reportedRateFactorMatch(factor, report, envelope) {
  if (envelope.market !== "US" || factor.dataDate !== envelope.marketAsOf || factor.values.changeBasisPoints === 0) return null;
  const publication = new Date(report.publishedAt);
  if (!Number.isFinite(publication.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(publication).map(item => [item.type, item.value]));
  if (`${parts.year}-${parts.month}-${parts.day}` !== factor.dataDate) return null;
  // Require the same nominal US Treasury maturity and an explicit prior-
  // session comparison, rather than a generic bond/rate/cost word. Keep the
  // news quotation distinct from Treasury's indicative par-yield definition.
  const priorDay = dayName(envelope.session.previousAsOf);
  const pattern = new RegExp(`\\b${factor.years}-year (?:U\\.S\\. )?Treasury(?: (?:yield|note|bond))? (rose|fell|declined|slipped|increased|decreased) to (\\d+(?:\\.\\d+)?)% from (\\d+(?:\\.\\d+)?)% (?:late )?${priorDay}\\b`, "iu");
  const match = pattern.exec(report.supportingExcerpt);
  if (!match) return null;
  const currentPercent = Number(match[2]), previousPercent = Number(match[3]);
  const delta = currentPercent - previousPercent;
  const verbSign = /^(?:rose|increased)$/iu.test(match[1]) ? 1 : -1;
  if (delta === 0 || Math.sign(delta) !== verbSign || Math.sign(delta) !== Math.sign(factor.values.changeBasisPoints)) return null;
  // A conservative consistency screen, not equality between two instruments
  // or statistical confidence. Wider differences need additional quote/time
  // evidence; never silently broaden this bound to make a report pass.
  if (Math.abs(currentPercent - factor.values.actualPercent) > 0.10 + 1e-9 || Math.abs(previousPercent - factor.values.previousPercent) > 0.10 + 1e-9) return null;
  return { years: factor.years, currentPercent, previousPercent, changeBasisPoints: Number((delta * 100).toFixed(6)), basis: "separately reported nominal Treasury quote; not the interpolated par observation", previousSession: envelope.session.previousAsOf };
}

export function assertRateFactorAnchors(values, factor) {
  // The typed observation and timed quotation establish the common maturity
  // and session. Do not demand identical values from different definitions,
  // or pretend that the derived summary is a verbatim article quotation.
  if (!Array.isArray(values) || values.length !== 2 || values[0] !== `${factor.years}-year U.S. Treasury` || values[1] !== factor.dataDate) throw new Error("收益率观测须以相同期限与交易日作为锚点");
}
