import { assertFactsNumbersInExcerpt, hasCausalPassage } from "./daily-workflow-core.mjs";
import { normalizedEvidenceText } from "./daily-source-audit.mjs";
import { backgroundEvidenceInWindow, isCalendarDate, officialReleaseDateInWindow } from "./evidence-timing.mjs";
import { verifiedExternalSourceType } from "./source-registry.mjs";
import { verifiedRateFactor, reportedRateFactorMatch, assertRateFactorAnchors, hasUnknownRatePublication } from "./recap-rate-factors.mjs";

export const ATTRIBUTION_VERSION = "verified-recap-attribution-v2";
const DIRECTIONS = ["positive", "negative", "flat"];
const GENERIC_TERMS = /^(?:market|markets|stock|stocks|shares|prices?|demand|supply|costs?|growth|rates?|interest rates|earnings|news|report|rose|fell|美国|中国|市场|股票|需求|供给|成本|利率|上涨|下跌)$/iu;
const CALENDAR_TERM = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday)$/iu;
const NUMERIC_ANCHOR = /^[+-]?(?:US\$|\$|USD\s*|¥)?[+-]?\d[\d,.]*(?:\s*(?:%|ppts?|pp|percentage points?|basis points?|bps?|points?|美元|个百分点|百分点|基点|USD))?$/iu;

function assessmentText(value, label, min, max) {
  // These are private audit assessments, never copied into the public recap.
  // Applying reader prose restrictions here suppresses valid rejection reasons
  // such as "the evidence only establishes exposure", causing needless retries.
  if (typeof value !== "string") throw new Error(`${label} 缺失`);
  const text = value.normalize("NFC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
  if (text.includes("\uFFFD") || [...text].length < min || [...text].length > max) throw new Error(`${label} 长度或编码无效`);
  return text;
}

function verified(source) {
  return source && source.excerptHash && source.verifiedAt && source.timingChecked === true && ["first_party", "publisher"].includes(source.sourceType) && verifiedExternalSourceType(source.url) === source.sourceType;
}

function freshRoot(source, envelope, macroData = null) {
  if (source?.kind === "macro_observation") return verifiedRateFactor(source, macroData, envelope);
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
  if (!verified(source) || source.kind !== "background" || source.role !== "facts" || source.sourceType !== "first_party" || source.causalConnection !== false || !backgroundEvidenceInWindow(source.publishedAt, envelope) || !Array.isArray(source.backgroundSubjects)) return false;
  return source.targets.includes(target.symbol) || (source.scope === "company" && source.subjectIdentityChecked === true && target.kind === "ai_layer" && source.backgroundSubjects.length === 1 && target.constituents.some(item => source.backgroundSubjects.includes(item.symbol)));
}

function mechanismsCover(sources, target) {
  const subjects = new Set(sources.flatMap(source => source.backgroundSubjects ?? []));
  // One issuer's exposure never establishes the four-stock basket's exposure.
  return subjects.has(target.symbol) || (target.kind === "ai_layer" && target.constituents?.length === 4 && target.constituents.every(item => subjects.has(item.symbol)));
}

function directlyCovers(source, symbol) {
  return source.targets.includes(symbol) && (source.scope !== "company" || (source.companySubjectChecked === true && source.companySubjects?.includes(symbol)));
}

function constituentClaims(source, symbol) {
  return source?.scope === "company" && source.companySubjectChecked === true && source.targets.length === 1 && source.targets[0] === symbol && source.companySubjects?.length === 1 && source.companySubjects[0] === symbol;
}

export function hasConstituentAttribution(entry) {
  return entry.chains.some(chain => (chain.subjectTargets?.length ?? 0) > 0);
}

function subjectDirectionsMatch(directions, change) {
  if (typeof change !== "string" || !/^[+-]?\d+(?:\.\d+)?%$/u.test(change)) return false;
  const move = Number(change.slice(0, -1));
  return move === 0 ? directions.has("flat") || (directions.has("positive") && directions.has("negative")) : directions.has(move > 0 ? "positive" : "negative");
}

function independent(root, report) {
  const a = new URL(root.url).hostname.replace(/^www\./u, ""), b = new URL(report.url).hostname.replace(/^www\./u, "");
  return root.url !== report.url && a !== b && normalizedEvidenceText(root.supportingExcerpt) !== normalizedEvidenceText(report.supportingExcerpt);
}

function chronology(root, report, envelope, confirmation = report) {
  if (root.kind === "macro_observation") return Boolean(reportedRateFactorMatch(root, report, envelope));
  if (isCalendarDate(root.publishedAt)) {
    // Keep unknown official publication hours unknown. A separate, verified
    // pre-close factual report can establish that this value was public.
    const zone = envelope.market === "CN" ? "Asia/Shanghai" : "America/New_York";
    const time = Date.parse(confirmation?.publishedAt);
    if (!verified(confirmation) || confirmation.kind === "background" || !["facts", "causal"].includes(confirmation.role) || isCalendarDate(confirmation.publishedAt) || !Number.isFinite(time) || time < Date.parse(envelope.session.windowStart) || time > Date.parse(envelope.session.windowEnd) || time > Date.parse(report.publishedAt)) return false;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(time)).map(item => [item.type, item.value]));
    return `${parts.year}-${parts.month}-${parts.day}` >= root.publishedAt;
  }
  return Date.parse(root.publishedAt) <= Date.parse(report.publishedAt);
}

export function recapAttributionCandidates(envelope, targets, ledger, { macroData = null } = {}) {
  const roots = ledger.sources.filter(source => freshRoot(source, envelope, macroData));
  const reports = ledger.sources.filter(source => reaction(source, envelope));
  const confirmations = ledger.sources.filter(source => verified(source) && source.kind !== "background" && !isCalendarDate(source.publishedAt));
  return targets.map(target => {
    const mechanisms = ledger.sources.filter(source => background(source, envelope, target));
    const targetReports = reports.filter(source => directlyCovers(source, target.symbol));
    const targetRoots = roots.filter(source => directlyCovers(source, target.symbol));
    const pairs = roots.flatMap(root => reports.filter(report => independent(root, report)).flatMap(report => {
      if (chronology(root, report, envelope)) return [{ root: root.id, reaction: report.id, timingEvidenceIds: [] }];
      const eligible = confirmations.filter(confirmation => chronology(root, report, envelope, confirmation));
      return eligible.length ? [{ root: root.id, reaction: report.id, timingEvidenceIds: eligible.map(source => source.id) }] : [];
    }));
    const direct = pairs.some(pair => targetRoots.some(root => root.id === pair.root) && targetReports.some(report => report.id === pair.reaction));
    const directlyReportedFactor = target.kind === "market" && pairs.some(pair => roots.some(root => root.id === pair.root && root.kind === "macro_observation") && targetReports.some(report => report.id === pair.reaction));
    const constituents = (target.constituents ?? []).map(company => {
      const directlyReportedPairs = pairs.filter(pair => constituentClaims(roots.find(source => source.id === pair.root), company.symbol) && constituentClaims(reports.find(source => source.id === pair.reaction), company.symbol));
      const subjects = mechanisms.filter(source => source.backgroundSubjects.includes(company.symbol));
      return { symbol: company.symbol, observedReturn: company.change, reportedEligible: directlyReportedPairs.length > 0, inferredIngredientsPresent: subjects.length > 0 && pairs.length > 0, reportedPairs: directlyReportedPairs, mechanismEvidenceIds: subjects.map(source => source.id) };
    });
    const constituentIngredientsPresent = target.kind === "ai_layer" && target.benchmarkKind === "equal_weight_basket" && constituents.length === 4 && constituents.every(company => company.reportedEligible || company.inferredIngredientsPresent);
    return { target: target.symbol, reportedEligible: direct, inferredIngredientsPresent: (mechanismsCover(mechanisms, target) && pairs.length > 0) || directlyReportedFactor, constituentIngredientsPresent, constituents, rootEvidenceIds: roots.map(source => source.id), reactionEvidenceIds: reports.map(source => source.id), mechanismEvidenceIds: mechanisms.map(source => source.id), candidatePairs: pairs };
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
  const names = values.filter(term => typeof term === "string" && !NUMERIC_ANCHOR.test(term) && /\p{L}/u.test(term) && !GENERIC_TERMS.test(term.trim()) && !CALENDAR_TERM.test(term.trim()));
  if (!names.length || (names.length === 1 && !values.some(term => NUMERIC_ANCHOR.test(term)))) throw new Error("事件锚点必须包含具体事件或指标名称与数值，不能只有数字和月份");
  for (const term of values) {
    const normalized = normalizedEvidenceText(term);
    if (typeof term !== "string" || normalized.length < 2 || term.length > 100 || GENERIC_TERMS.test(term.trim())) throw new Error("官方事件与市场反应的共同锚点不具体或未见于两段原文");
    if (NUMERIC_ANCHOR.test(term)) {
      try {
        assertFactsNumbersInExcerpt({ facts: term, supportingExcerpt: root.supportingExcerpt });
        assertFactsNumbersInExcerpt({ facts: term, supportingExcerpt: report.supportingExcerpt });
      } catch (error) { throw new Error(`事件数值锚点与两段原文的值、单位或方向不符：${error.message}`); }
    } else if (!normalizedEvidenceText(root.supportingExcerpt).includes(normalized) || !normalizedEvidenceText(report.supportingExcerpt).includes(normalized)) throw new Error("官方事件与市场反应的共同锚点未见于两段原文");
  }
  // A same-day date-only page can be revised after close. Its factual value
  // must also occur in the timed report before it can anchor an inference.
  if (isCalendarDate(root.publishedAt) && !values.some(term => /\d/u.test(term))) throw new Error("日期精度的官方事实缺少当时报道确认的具体数值与事件锚点");
}

export function attributionEvidenceIds(entry) {
  return [...new Set(entry.chains.flatMap(chain => [chain.rootEvidenceId, chain.reactionEvidenceId, ...(chain.timingEvidenceId ? [chain.timingEvidenceId] : []), ...chain.mechanismEvidenceIds]))];
}

export function validateRecapAttribution(value, envelope, targets, ledger, { requireComplete = false, macroData = null } = {}) {
  if (value?.contractVersion !== ATTRIBUTION_VERSION || value.market !== envelope.market || value.marketAsOf !== envelope.marketAsOf || !Array.isArray(value.entries) || value.entries.length !== targets.length) throw new Error("复盘传导审查必须覆盖全部目标与相同交易日");
  const map = new Map(ledger.sources.map(source => [source.id, source]));
  const entries = new Map(value.entries.map(entry => [entry.target, entry]));
  if (entries.size !== targets.length || targets.some(target => !entries.has(target.symbol))) throw new Error("复盘传导审查存在遗漏或重复目标");
  for (const target of targets) {
    const entry = entries.get(target.symbol);
    if (!["reported", "inferred", "unresolved"].includes(entry.basis) || entry.observedReturn !== target.change || !Array.isArray(entry.chains)) throw new Error(`${target.symbol} 归因依据或实际方向无效`);
    const decomposed = hasConstituentAttribution(entry);
    if (entry.chains.length > (decomposed ? 8 : 3) || (decomposed && (target.kind !== "ai_layer" || target.benchmarkKind !== "equal_weight_basket" || target.constituents?.length !== 4 || new Set(target.constituents.map(company => company.symbol)).size !== 4 || target.constituents.some(company => company.asOf !== envelope.marketAsOf)))) throw new Error(`${target.symbol} 公司分解只适用于四只已确认成分的等权篮子`);
    const subjectDirections = new Map((decomposed ? target.constituents : []).map(company => [company.symbol, new Set()]));
    selected(entry.counterEvidenceIds, map, "反证", 0, 6);
    assessmentText(entry.counterAssessment, "反证分析", 40, 1_200);
    if (entry.basis === "unresolved") {
      if (requireComplete || (entry.chains.length && (!decomposed || entry.chains.some(chain => !chain.subjectTargets?.length)))) throw new Error(`${target.symbol} 未完成事件传导审查`);
      if (!entry.chains.length) continue;
    }
    if (!entry.chains.length) throw new Error(`${target.symbol} 缺少事件传导链`);
    for (const chain of entry.chains) {
      const subjects = chain.subjectTargets ?? [], basis = chain.basis ?? entry.basis;
      if (!Array.isArray(subjects) || subjects.length > 4 || new Set(subjects).size !== subjects.length || subjects.some(symbol => !subjectDirections.has(symbol)) || !["reported", "inferred"].includes(basis) || (entry.basis === "reported" && basis !== "reported")) throw new Error(`${target.symbol} 分链主体或报道／推断依据无效`);
      if (chain.timingEvidenceId !== null && typeof chain.timingEvidenceId !== "string") throw new Error(`${target.symbol} 当时事实确认的引用字段无效`);
      const [root, report] = selected([chain.rootEvidenceId, chain.reactionEvidenceId], map, "事件与市场反应", 2, 2);
      const confirmation = chain.timingEvidenceId == null ? report : selected([chain.timingEvidenceId], map, "当时的事实确认")[0];
      if (!freshRoot(root, envelope, macroData)) throw new Error(`${target.symbol} 官方事件 ${root.id} 未核验、过时或缺少原始观测数据`);
      if (!reaction(report, envelope)) throw new Error(`${target.symbol} 反应引用 ${report.id} 的 role=${report.role} 不满足已核验的 causal 角色、原文因果或会话时间；请使用该目标 candidatePairs 中的 reaction 引用，否则保留 unresolved`);
      if (!independent(root, report) || !chronology(root, report, envelope, confirmation)) throw new Error(`${target.symbol} 官方事件、独立反应或时间先后不成立`);
      const observedFactor = root.kind === "macro_observation";
      if (observedFactor) {
        if (basis !== "inferred" || chain.timingEvidenceId !== null || !reportedRateFactorMatch(root, report, envelope)) throw new Error(`${target.symbol} 观测不能伪装为当日有发布时间的事件或确定归因`);
        assertRateFactorAnchors(chain.eventAnchors, root);
        if (!/observation|observed|观测|观察/iu.test(chain.limitations) || !hasUnknownRatePublication(chain.limitations) || !/\bpar\b|平价/iu.test(chain.limitations)) throw new Error(`${target.symbol} 观测推断须区分平价收益率与报道报价，并保留未知发布时间`);
      } else {
        try { anchors(chain.eventAnchors, root, report); }
        catch (error) { throw new Error(`${target.symbol} 事件 ${root.id} 与反应 ${report.id} 的 eventAnchors=${JSON.stringify(chain.eventAnchors)} 无效：${error.message}。请逐项使用两段引文实际共有的连续词句或数值，不能用概括句、译文或公司别名替代；不足时保留 unresolved。`); }
      }
      if (chain.timingEvidenceId) {
        if (!isCalendarDate(root.publishedAt)) throw new Error(`${target.symbol} 精确发布时间来源无需附加未知时刻确认`);
        anchors(chain.eventAnchors, root, confirmation);
      }
      if (!DIRECTIONS.includes(chain.expectedDirection)) throw new Error(`${target.symbol} 传导方向无效`);
      assessmentText(chain.transmission, "传导机制", 50, 1_200);
      assessmentText(chain.limitations, "传导局限", 30, 900);
      const directMarketFactor = observedFactor && target.kind === "market" && report.targets.includes(target.symbol);
      const mechanisms = selected(chain.mechanismEvidenceIds, map, "背景传导", basis === "inferred" && !directMarketFactor ? 1 : 0);
      if (mechanisms.some(source => !background(source, envelope, target))) throw new Error(`${target.symbol} 背景传导证据类型或适用对象无效`);
      if (basis === "reported") {
        if (subjects.length ? subjects.some(symbol => !constituentClaims(root, symbol) || !constituentClaims(report, symbol)) : !directlyCovers(root, target.symbol) || !directlyCovers(report, target.symbol)) throw new Error(`${target.symbol} 报道归因未直接对应分链主体`);
      } else if (!directMarketFactor && (subjects.length ? subjects.some(symbol => !mechanisms.some(source => source.backgroundSubjects.includes(symbol))) : !mechanismsCover(mechanisms, target))) throw new Error(`${target.symbol} 推断缺少全部适用对象的一手传导披露`);
      for (const symbol of subjects.length ? subjects : subjectDirections.keys()) subjectDirections.get(symbol).add(chain.expectedDirection);
    }
    if (decomposed) {
      for (const company of target.constituents) if ((entry.basis !== "unresolved" || subjectDirections.get(company.symbol).size) && !subjectDirectionsMatch(subjectDirections.get(company.symbol), company.change)) throw new Error(`${target.symbol} 尚未解释 ${company.symbol} 的实际涨跌，不能用其他公司或净额抵消补齐`);
      const mean = target.constituents.reduce((sum, company) => sum + Number(company.change.slice(0, -1)) / 4, 0);
      if (!Number.isFinite(mean) || Math.abs(mean - Number(target.change.slice(0, -1))) > 0.010001) throw new Error(`${target.symbol} 公司分解不能重建同日等权收盘收益`);
    }
    const move = Number(target.change.slice(0, -1));
    const observed = move > 0 ? "positive" : move < 0 ? "negative" : "flat";
    const directions = new Set(entry.chains.map(chain => chain.expectedDirection));
    if (entry.basis !== "unresolved" && (observed === "flat" ? !(directions.has("flat") || (directions.has("positive") && directions.has("negative"))) : !directions.has(observed))) throw new Error(`${target.symbol} 传导方向无法解释实际涨跌，缺少相反力量`);
  }
  return value;
}
