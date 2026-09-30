import { hasCausalPassage, readerText } from "./daily-workflow-core.mjs";
import { normalizedEvidenceText } from "./daily-source-audit.mjs";
import { backgroundEvidenceInWindow, isCalendarDate, officialReleaseDateInWindow } from "./evidence-timing.mjs";
import { verifiedExternalSourceType } from "./source-registry.mjs";

export const ATTRIBUTION_VERSION = "verified-recap-attribution-v1";
const DIRECTIONS = ["positive", "negative", "flat"];
const GENERIC_TERMS = /^(?:market|markets|stock|stocks|shares|prices?|demand|supply|costs?|growth|rates?|interest rates|earnings|news|report|rose|fell|美国|中国|市场|股票|需求|供给|成本|利率|上涨|下跌)$/iu;

function verified(source) {
  return source && source.excerptHash && source.verifiedAt && source.timingChecked === true && ["first_party", "publisher"].includes(source.sourceType) && verifiedExternalSourceType(source.url) === source.sourceType;
}

function freshRoot(source, envelope) {
  if (!verified(source) || source.role !== "facts" || source.sourceType !== "first_party" || source.kind === "background") return false;
  if (isCalendarDate(source.publishedAt)) return source.kind === "official" && officialReleaseDateInWindow(source.publishedAt, envelope);
  const time = Date.parse(source.publishedAt);
  return /(?:Z|[+-]\d{2}:\d{2})$/u.test(source.publishedAt ?? "") && Number.isFinite(time) && time >= Date.parse(envelope.session.windowStart) - 72 * 3_600_000 && time <= Date.parse(envelope.session.windowEnd);
}

function reaction(source, envelope) {
  const time = Date.parse(source?.publishedAt);
  return verified(source) && source.role === "causal" && source.sourceType === "publisher" && source.causalConnection === true && hasCausalPassage(source.supportingExcerpt) && !isCalendarDate(source.publishedAt) && Number.isFinite(time) && time >= Date.parse(envelope.session.windowStart) && time <= Date.parse(envelope.session.wrapDeadline ?? envelope.session.windowEnd);
}

function background(source, envelope, target) {
  return verified(source) && source.kind === "background" && source.role === "facts" && source.sourceType === "first_party" && source.causalConnection === false && source.targets.includes(target.symbol) && backgroundEvidenceInWindow(source.publishedAt, envelope) && Array.isArray(source.backgroundSubjects);
}

function mechanismsCover(sources, target) {
  const subjects = new Set(sources.flatMap(source => source.backgroundSubjects ?? []));
  // One issuer's exposure never establishes the four-stock basket's exposure.
  return subjects.has(target.symbol) || (target.kind === "ai_layer" && target.constituents?.length === 4 && target.constituents.every(item => subjects.has(item.symbol)));
}

function independent(root, report) {
  const a = new URL(root.url).hostname.replace(/^www\./u, ""), b = new URL(report.url).hostname.replace(/^www\./u, "");
  return root.url !== report.url && a !== b && normalizedEvidenceText(root.supportingExcerpt) !== normalizedEvidenceText(report.supportingExcerpt);
}

function chronology(root, report, envelope) {
  if (isCalendarDate(root.publishedAt)) {
    // A later wrap cannot supply the missing intraday availability of a
    // same-day date-only official page. Require a contemporary timed account.
    const zone = envelope.market === "CN" ? "Asia/Shanghai" : "America/New_York";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(report.publishedAt)).map(item => [item.type, item.value]));
    return `${parts.year}-${parts.month}-${parts.day}` >= root.publishedAt && Date.parse(report.publishedAt) <= Date.parse(envelope.session.windowEnd);
  }
  return Date.parse(root.publishedAt) <= Date.parse(report.publishedAt);
}

export function recapAttributionCandidates(envelope, targets, ledger) {
  const roots = ledger.sources.filter(source => freshRoot(source, envelope));
  const reports = ledger.sources.filter(source => reaction(source, envelope));
  return targets.map(target => {
    const mechanisms = ledger.sources.filter(source => background(source, envelope, target));
    const targetReports = reports.filter(source => source.targets.includes(target.symbol));
    const targetRoots = roots.filter(source => source.targets.includes(target.symbol));
    const direct = targetRoots.some(root => targetReports.some(report => independent(root, report) && chronology(root, report, envelope)));
    const pairs = roots.flatMap(root => reports.filter(report => independent(root, report) && chronology(root, report, envelope)).map(report => ({ root: root.id, reaction: report.id })));
    return { target: target.symbol, reportedEligible: direct, inferredIngredientsPresent: mechanismsCover(mechanisms, target) && pairs.length > 0, rootEvidenceIds: roots.map(source => source.id), reactionEvidenceIds: reports.map(source => source.id), mechanismEvidenceIds: mechanisms.map(source => source.id), candidatePairs: pairs };
  });
}

function selected(values, map, label, min = 1, max = 8) {
  if (!Array.isArray(values) || values.length < min || values.length > max || new Set(values).size !== values.length || values.some(id => !map.has(id))) throw new Error(`${label} 引用了缺失、重复或过多证据`);
  return values.map(id => map.get(id));
}

function anchors(values, root, report) {
  // This check prevents an unrelated official announcement from satisfying a
  // market-wrap reaction. Semantic identity still requires independent review.
  if (!Array.isArray(values) || values.length < 2 || values.length > 5 || new Set(values.map(normalizedEvidenceText)).size !== values.length) throw new Error("官方事件与市场反应缺少具体共同锚点");
  for (const term of values) {
    const normalized = normalizedEvidenceText(term);
    if (typeof term !== "string" || normalized.length < 2 || term.length > 100 || GENERIC_TERMS.test(term.trim()) || !/\p{L}/u.test(term) || !normalizedEvidenceText(root.supportingExcerpt).includes(normalized) || !normalizedEvidenceText(report.supportingExcerpt).includes(normalized)) throw new Error("官方事件与市场反应的共同锚点不具体或未见于两段原文");
  }
  // A same-day date-only page can be revised after close. Its factual value
  // must also occur in the timed report before it can anchor an inference.
  if (isCalendarDate(root.publishedAt) && !values.some(term => /\d/u.test(term) && /\p{L}/u.test(term))) throw new Error("日期精度的官方事实缺少当时报道确认的具体数值与事件锚点");
}

export function attributionEvidenceIds(entry) {
  return [...new Set(entry.chains.flatMap(chain => [chain.rootEvidenceId, chain.reactionEvidenceId, ...chain.mechanismEvidenceIds]))];
}

export function validateRecapAttribution(value, envelope, targets, ledger, { requireComplete = false } = {}) {
  if (value?.contractVersion !== ATTRIBUTION_VERSION || value.market !== envelope.market || value.marketAsOf !== envelope.marketAsOf || !Array.isArray(value.entries) || value.entries.length !== targets.length) throw new Error("复盘传导审查必须覆盖全部目标与相同交易日");
  const map = new Map(ledger.sources.map(source => [source.id, source]));
  const entries = new Map(value.entries.map(entry => [entry.target, entry]));
  if (entries.size !== targets.length || targets.some(target => !entries.has(target.symbol))) throw new Error("复盘传导审查存在遗漏或重复目标");
  for (const target of targets) {
    const entry = entries.get(target.symbol);
    if (!["reported", "inferred", "unresolved"].includes(entry.basis) || entry.observedReturn !== target.change || !Array.isArray(entry.chains) || entry.chains.length > 3) throw new Error(`${target.symbol} 归因依据或实际方向无效`);
    selected(entry.counterEvidenceIds, map, "反证", 0, 6);
    readerText(entry.counterAssessment, "反证分析", 40, 1_200);
    if (entry.basis === "unresolved") {
      if (entry.chains.length || requireComplete) throw new Error(`${target.symbol} 未完成事件传导审查`);
      continue;
    }
    if (!entry.chains.length) throw new Error(`${target.symbol} 缺少事件传导链`);
    for (const chain of entry.chains) {
      const [root, report] = selected([chain.rootEvidenceId, chain.reactionEvidenceId], map, "事件与市场反应", 2, 2);
      if (!freshRoot(root, envelope) || !reaction(report, envelope) || !independent(root, report) || !chronology(root, report, envelope)) throw new Error(`${target.symbol} 官方事件、独立反应或时间先后不成立`);
      anchors(chain.eventAnchors, root, report);
      if (!DIRECTIONS.includes(chain.expectedDirection)) throw new Error(`${target.symbol} 传导方向无效`);
      readerText(chain.transmission, "传导机制", 50, 1_200);
      readerText(chain.limitations, "传导局限", 30, 900);
      const mechanisms = selected(chain.mechanismEvidenceIds, map, "背景传导", entry.basis === "inferred" ? 1 : 0);
      if (mechanisms.some(source => !background(source, envelope, target))) throw new Error(`${target.symbol} 背景传导证据类型或适用对象无效`);
      if (entry.basis === "reported") {
        if (!root.targets.includes(target.symbol) || !report.targets.includes(target.symbol)) throw new Error(`${target.symbol} 报道归因未直接对应目标`);
      } else if (!mechanismsCover(mechanisms, target)) throw new Error(`${target.symbol} 推断缺少全部适用对象的一手传导披露`);
    }
    const move = Number(target.change.slice(0, -1));
    const observed = move > 0 ? "positive" : move < 0 ? "negative" : "flat";
    const directions = new Set(entry.chains.map(chain => chain.expectedDirection));
    if (observed === "flat" ? !(directions.has("flat") || (directions.has("positive") && directions.has("negative"))) : !directions.has(observed)) throw new Error(`${target.symbol} 传导方向无法解释实际涨跌，缺少相反力量`);
  }
  return value;
}
