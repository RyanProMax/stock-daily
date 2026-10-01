import {
  assertNumbersGrounded,
  assertFactsNumbersInExcerpt,
  assertFinancialCopyIncludesMetrics,
  hasCausalPassage,
  readerText,
  publicComparison,
  requiresFinancialComparisons,
  stableHash,
  bodySupportsDeterministicTarget,
} from "./daily-workflow-core.mjs";
import { assertGdpNowCopy } from "./gdpnow-publication.mjs";
import { normalizedEvidenceText } from "./daily-source-audit.mjs";
import { verifiedExternalSourceType } from "./source-registry.mjs";
import { validateRecapTradingData } from "./recap-market-data.mjs";
import { hasMeasuredMagnitude, magnitudeEvidenceForObservation, validateMagnitudeObservationIds } from "./recap-magnitude.mjs";
import { attributionEvidenceIds, recapAttributionCandidates, validateRecapAttribution, hasConstituentAttribution } from "./recap-attribution.mjs";
import { auditRecapRateFactors, hasUnknownRatePublication } from "./recap-rate-factors.mjs";
import { verifiedCompanyOutlooks, assertCompanyOutlookDescriptions } from "./company-outlook.mjs";

export const RECAP_VERSION = "verified-complete-recap-v1";
const SIZE_EVIDENCE = /成交|量能|缩量|放量|振幅|波幅|盘中|涨跌家数|抵消|对冲|分化|权重|\b(?:volume|turnover|intraday|range|breadth|offset|counter|divergen|weight|narrow|restrain|limit)\w*/iu;

export function recapTargets(envelope) {
  const benchmark = envelope.markets.find((item) =>
    item.symbol === (envelope.market === "CN" ? "SSE" : "SPX"),
  );
  if (!benchmark || envelope.sectorPerformance.length !== 11 || envelope.aiChainPerformance.length !== 8) {
    throw new Error("完整复盘缺少大盘、11 个行业或 8 个 AI 环节");
  }
  const targets = [
    { ...benchmark, kind: "market" },
    ...envelope.sectorPerformance.map((item) => ({ ...item, kind: "sector" })),
    ...envelope.aiChainPerformance.map((item) => ({ ...item, kind: "ai_layer" })),
  ];
  if (new Set(targets.map((item) => item.symbol)).size !== 20) throw new Error("复盘目标重复");
  return targets;
}

function returnValue(value, label) {
  if (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?%$/u.test(value)) throw new Error(`${label} 缺少有效收盘收益率`);
  return Number(value.slice(0, -1));
}

// These observations are arithmetic on the frozen collection, never causal
// evidence. In particular, representative stocks have no sector weights.
export function recapObservations(envelope, tradingData = null) {
  const trading = new Map((tradingData ? validateRecapTradingData(tradingData, envelope).entries : []).map(item => [item.symbol, item]));
  const targets = recapTargets(envelope);
  const benchmark = returnValue(targets[0].change, targets[0].symbol);
  return targets.map(target => {
    const change = returnValue(target.change, target.symbol);
    const representatives = (target.constituents ?? []).map(item => {
      if (item.asOf !== envelope.marketAsOf) throw new Error(`${target.symbol} 代表股交易日不一致`);
      return { symbol: item.symbol, name: item.name, nameEn: item.nameEn, change: returnValue(item.change, item.symbol), source: item.source };
    });
    const moves = representatives.map(item => item.change);
    const mean = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
    const pp = value => `${value.toFixed(2)} 个百分点 (${value.toFixed(2)} percentage points)`;
    const observation = {
      target: target.symbol, asOf: envelope.marketAsOf,
      closingReturn: target.change,
      relativeToBenchmark: pp(change - benchmark),
      representativeCount: representatives.length,
      risingRepresentatives: moves.filter(value => value > 0).length,
      fallingRepresentatives: moves.filter(value => value < 0).length,
      flatRepresentatives: moves.filter(value => value === 0).length,
      representativeSpread: moves.length ? pp(Math.max(...moves) - Math.min(...moves)) : null,
      representatives,
      trading: trading.get(target.symbol) ?? null,
      representativeTrading: representatives.map(item => trading.get(item.symbol)).filter(Boolean),
      limitations: ["Closing returns establish neither net fund flow nor weighted sector contribution.", "Representative dispersion is not whole-sector breadth and does not identify a news catalyst.", "Intraday range and volume comparisons are established only for individual instruments with validated trading observations; synthetic AI basket range is unobserved.", "Provider adjustment flags and corporate-action leads require first-party verification; a dividend or share change can affect price comparisons without a corresponding business shock."],
    };
    if (target.benchmarkKind === "equal_weight_basket") {
      // Constituents are stored to two decimal places. Their average may
      // differ from the full-precision collected basket by at most 0.01pp.
      if (moves.length !== 4 || Math.abs(mean - change) > 0.010001) throw new Error(`${target.symbol} 等权篮子收益无法由成分复核`);
      observation.equalWeight = {
        contributions: representatives.map(item => ({ symbol: item.symbol, contribution: pp(item.change / moves.length) })),
        positiveContribution: pp(moves.filter(value => value > 0).reduce((a, b) => a + b, 0) / moves.length),
        negativeContribution: pp(moves.filter(value => value < 0).reduce((a, b) => a + b, 0) / moves.length),
        reconstructedReturn: `${mean.toFixed(2)}%`,
        roundingTolerance: "0.01 个百分点 (0.01 percentage points)",
      };
    }
    observation.magnitudeEvidence = magnitudeEvidenceForObservation(observation);
    return observation;
  });
}

export function completeRecapPlan(envelope, tradingData = null) {
  const observations = new Map(recapObservations(envelope, tradingData).map(item => [item.target, item]));
  return {
    contractVersion: "stock-daily-market-plan-v1",
    market: envelope.market,
    marketAsOf: envelope.marketAsOf,
    anomalies: recapTargets(envelope).map((metric) => {
      const id = `recap-${stableHash(metric.symbol).slice(0, 12)}`;
      const name = envelope.market === "CN" ? metric.name : metric.nameEn ?? metric.name;
      const market = envelope.market === "CN" ? "A股" : "US";
      const adjustmentTargets = new Set(observations.get(metric.symbol).representativeTrading.filter(item => item.adjustmentReview?.status === "requires_primary_verification").map(item => item.symbol));
      const movers = [...(metric.constituents ?? [])]
        .sort((a, b) => Number(adjustmentTargets.has(b.symbol)) - Number(adjustmentTargets.has(a.symbol)) || Math.abs(returnValue(b.change, b.symbol)) - Math.abs(returnValue(a.change, a.symbol)) || a.symbol.localeCompare(b.symbol))
        .slice(0, 2);
      const companyNames = movers.map(item => envelope.market === "CN" ? item.name : item.nameEn ?? item.name).join(" ");
      const targetNames = `${name}${companyNames ? ` ${companyNames}` : ""}`;
      return {
        id, kind: metric.kind, target: metric.symbol, researchPurpose: "comprehensive_recap",
        observation: metric,
        quantitativeObservations: observations.get(metric.symbol),
        title: name, observedMove: `${name} ${metric.change}`,
        direction: metric.direction === "up" ? "positive" : metric.direction === "down" ? "negative" : "mixed",
        researchQuestion: `Explain ${name} ${metric.change}: event, transmission, competing forces and why the move was limited or amplified. Distinguish closing return from intraday range.`,
        hypotheses: [
          { id: `${id}-event`, category: "company_event", claim: "A verified company or industry catalyst changed cash-flow expectations." },
          { id: `${id}-macro`, category: "macro_policy", claim: "A verified macro or policy shock affected this target through financing, demand or valuation." },
          { id: `${id}-offset`, category: "alternative", claim: "Opposing forces, constituent dispersion or documented positioning limited or amplified the net move." },
        ],
        factQueries: [`${envelope.marketAsOf} ${market} ${targetNames} ${envelope.market === "CN" ? "收盘 新闻 公告" : "stocks news market close"}${adjustmentTargets.size ? (envelope.market === "CN" ? " 分红 除权除息" : " dividend split ex-date") : ""}`],
        causalQueries: [`${envelope.marketAsOf} ${market} ${targetNames} ${envelope.market === "CN" ? "涨跌 原因 分化" : "stocks rose fell why sector"}`],
      };
    }),
  };
}

function zonedTime(value) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("X 原文缺少带时区的发布时间");
  return Date.parse(value);
}

function hasMissingThreadContext(text) {
  return /(?:\b(?:a|this|the) thread\b|\bthread\s*:|🧵|[（(]\s*\d{1,2}\s*\/\s*(?:[2-9]|[1-9]\d)\s*[）)]|(?:^|\s)1\/(?:[2-9]|[1-9]\d)(?=$|\s)|后续见|续帖|下一条)/iu.test(text);
}

export function verifySocialLeads(payload, registry, envelope) {
  const allowed = new Map(registry.map((item) => [item.handle.toLowerCase(), item]));
  const end = Date.parse(envelope.session?.wrapDeadline ?? envelope.session?.windowEnd ?? `${envelope.marketAsOf}T${envelope.market === "CN" ? "09" : "22"}:00:00Z`);
  const leads = [], rejected = [];
  for (const candidate of payload.candidates ?? []) {
    try {
      const url = new URL(candidate.url);
      const match = /^\/([A-Za-z0-9_]+)\/status\/(\d+)\/?$/u.exec(url.pathname);
      const author = allowed.get(String(candidate.authorHandle).toLowerCase());
      if (!author || url.protocol !== "https:" || url.hostname !== "x.com" || !match || match[1].toLowerCase() !== author.handle.toLowerCase() || !author.markets.includes(envelope.market)) throw new Error("X 账号或原文链接不匹配白名单");
      const published = zonedTime(candidate.publishedAt);
      // X snowflakes encode creation time. An altered URL/date cannot be
      // turned into same-session evidence by a generated timestamp.
      const created = Number((BigInt(match[2]) >> 22n) + 1288834974657n);
      if (Math.abs(created - published) > 2_000 || published > end || published < end - 72 * 3_600_000) throw new Error("X 原文时间与帖子 ID 或交易窗口不一致");
      if (candidate.platform !== "x" || typeof candidate.facts !== "string" || candidate.facts.trim().length < 40) throw new Error("X 原文正文缺失");
      const textComplete = candidate.textComplete === true && Number.isInteger(candidate.originalTextLength) && candidate.originalTextLength === [...candidate.facts].length && candidate.originalTextLength <= 6000;
      if (candidate.textComplete !== undefined && !textComplete) throw new Error("X 原帖完整性或文本长度不一致");
      leads.push({
        id: `x-${match[2]}`, url: url.href, authorHandle: author.handle,
        sourceLabel: author.label, authority: author.authority,
        publishedAt: new Date(published).toISOString(), text: candidate.facts,
        textComplete,
        threadContextMissing: hasMissingThreadContext(candidate.facts),
        layers: author.layers, identityEvidence: author.identityEvidence,
        coverage: author.coverage ?? ["ai"],
        // Original access verifies attribution, not factual correctness.
        verification: "original_discovery", factualAuthority: false,
      });
    } catch (error) { rejected.push({ url: candidate.url, reason: error.message }); }
  }
  return {
    status: payload.diagnostics?.status ?? "unavailable",
    attempted: true, checkedAt: new Date().toISOString(),
    registryHash: stableHash(registry),
    diagnostics: payload.diagnostics ?? {},
    leads: [...new Map(leads.map((item) => [item.id, item])).values()], rejected,
  };
}

function ids(values, sources, label, min = 1) {
  if (!Array.isArray(values) || values.length < min || new Set(values).size !== values.length || values.some((id) => !sources.has(id))) throw new Error(`${label} 缺少已核验证据或引用重复`);
  return values.map((id) => sources.get(id));
}

export function assessRecapEvidenceCoverage(envelope, ledger, { tradingData = null, macroData = null } = {}) {
  const observations = new Map(recapObservations(envelope, tradingData).map(item => [item.target, item]));
  const inferenceCandidates = new Map(recapAttributionCandidates(envelope, recapTargets(envelope), ledger, { macroData }).map(item => [item.target, item]));
  const entries = completeRecapPlan(envelope).anomalies.map(anomaly => {
    const sources = ledger.sources.filter(source => source.anomalyId === anomaly.id && source.targets.includes(anomaly.target));
    const facts = sources.filter(source => source.role === "facts" && source.sourceType === "first_party" && source.kind !== "background");
    const causal = sources.filter(source => source.role === "causal" && source.causalConnection && hasCausalPassage(source.supportingExcerpt));
    const magnitude = causal.filter(source => SIZE_EVIDENCE.test(source.supportingExcerpt));
    const measured = observations.get(anomaly.target).magnitudeEvidence;
    const inference = inferenceCandidates.get(anomaly.target);
    const direct = facts.length && causal.length && facts.some(fact => causal.some(cause => cause.url !== fact.url));
    const gaps = [];
    if (!direct && !inference.reportedEligible && !inference.inferredIngredientsPresent && !inference.constituentIngredientsPresent) {
      if (!facts.length) gaps.push("official_facts");
      if (!causal.length) gaps.push("target_causality");
      if (!facts.some(fact => causal.some(cause => cause.url !== fact.url))) gaps.push("independent_origin");
    }
    if (!magnitude.length && !hasMeasuredMagnitude(measured)) gaps.push("magnitude");
    return { target: anomaly.target, status: gaps.length ? "incomplete" : "eligible_for_review", gaps, attributionCandidates: inference, evidenceIds: sources.map(source => source.id), magnitudeSupport: magnitude.length ? "reported" : hasMeasuredMagnitude(measured) ? "measured" : "missing", magnitudeObservationIds: measured.records.map(item => item.id) };
  });
  return { market: envelope.market, marketAsOf: envelope.marketAsOf, eligibleCount: entries.filter(entry => !entry.gaps.length).length, requiredCount: entries.length, entries };
}

// Every target shares many root/reaction pairs. Preserve every field and its
// ordering once, with per-target indexes, instead of repeating entire records
// until the native runtime refuses its input. The persisted audit stays full.
export function compactRecapCoverage(coverage) {
  const attributionPairs = [], indexes = new Map();
  const entries = coverage.entries.map(entry => {
    const { candidatePairs, ...candidates } = entry.attributionCandidates;
    const candidatePairIndexes = candidatePairs.map(pair => {
      const key = stableHash(pair);
      if (!indexes.has(key)) { indexes.set(key, attributionPairs.length); attributionPairs.push(structuredClone(pair)); }
      return indexes.get(key);
    });
    return { ...structuredClone(entry), attributionCandidates: { ...structuredClone(candidates), candidatePairIndexes } };
  });
  return { ...structuredClone(coverage), attributionPairs, entries };
}

export function validateCompleteRecap(value, envelope, ledger, social, { requireComplete = false, tradingData = null, attribution = null, macroData = null } = {}) {
  const targets = recapTargets(envelope);
  if (ledger.sources.some(source => source.kind === "macro_observation")) {
    if (!macroData) throw new Error("复盘观测缺少财政部原始数据");
    auditRecapRateFactors(ledger, macroData, envelope);
  }
  const attributions = attribution ? new Map(validateRecapAttribution(attribution, envelope, targets, ledger, { requireComplete, macroData }).entries.map(item => [item.target, item])) : null;
  const observations = new Map(recapObservations(envelope, tradingData).map(item => [item.target, item]));
  const sourceMap = new Map(ledger.sources.map((item) => [item.id, item]));
  if (value.contractVersion !== RECAP_VERSION || value.market !== envelope.market || value.marketAsOf !== envelope.marketAsOf || !Array.isArray(value.entries) || value.entries.length !== targets.length) throw new Error("复盘必须逐项覆盖完整的 20 个目标");
  const byTarget = new Map(value.entries.map((item) => [item.target, item]));
  if (byTarget.size !== targets.length || targets.some((target) => !byTarget.has(target.symbol))) throw new Error("复盘存在遗漏、重复或虚构目标");
  const socialMap = new Map((social.leads ?? []).map((item) => [item.id, item]));
  const entries = targets.map((target) => {
    const raw = byTarget.get(target.symbol);
    const chain = attributions?.get(target.symbol);
    const inferred = chain?.basis === "inferred";
    const decomposed = chain ? hasConstituentAttribution(chain) : false;
    if (!["explained", "partial", "unresolved"].includes(raw.status) || !["high", "medium", "low"].includes(raw.confidence)) throw new Error(`${target.symbol} 复盘状态无效`);
    if (raw.status !== "explained" && raw.confidence === "high") throw new Error(`${target.symbol} 证据不足不能标为高置信`);
    const cause = ids(raw.evidenceIds, sourceMap, target.symbol, raw.status === "unresolved" ? 0 : 2);
    const size = ids(raw.magnitudeEvidenceIds, sourceMap, `${target.symbol} 波幅`, 0);
    const measured = observations.get(target.symbol).magnitudeEvidence;
    const measurementIds = raw.magnitudeObservationIds ?? [];
    if (!Array.isArray(measurementIds)) throw new Error(`${target.symbol} 幅度观测引用无效`);
    const anomaly = completeRecapPlan(envelope).anomalies.find((item) => item.target === target.symbol);
    const linkedIds = chain ? new Set([...attributionEvidenceIds(chain), ...chain.counterEvidenceIds]) : new Set();
    if (cause.some(source => !linkedIds.has(source.id) && (source.anomalyId !== anomaly.id || !source.targets.includes(target.symbol))) || size.some(source => source.anomalyId !== anomaly.id || !source.targets.includes(target.symbol))) throw new Error(`${target.symbol} 引用了其他目标的证据`);
    if (chain && raw.status !== "unresolved" && (chain.basis === "unresolved" || attributionEvidenceIds(chain).some(id => !raw.evidenceIds.includes(id)))) throw new Error(`${target.symbol} 成稿未保留完整的已审查传导证据`);
    const causal = cause.filter((source) => source.anomalyId === anomaly.id && source.role === "causal" && source.targets.includes(target.symbol) && source.causalConnection && hasCausalPassage(source.supportingExcerpt));
    if (!inferred && !decomposed && raw.status !== "unresolved" && causal.length === 0) throw new Error(`${target.symbol} 缺少对应目标的直接因果原文`);
    if (raw.status === "explained") {
      if (!cause.some((source) => source.role === "facts" && source.sourceType === "first_party" && source.kind !== "background") || new Set(cause.map((source) => source.url)).size < 2) throw new Error(`${target.symbol} 需要官方事实与独立价格反应证据`);
      if (inferred && raw.confidence !== "medium") throw new Error(`${target.symbol} 经传导机制作出的推断只能标为中等置信`);
      if (!size.some((source) => source.anomalyId === anomaly.id && source.role === "causal" && SIZE_EVIDENCE.test(source.supportingExcerpt)) && !hasMeasuredMagnitude(measured, measurementIds)) throw new Error(`${target.symbol} 缺少成交、振幅、分化或相反力量的直接证据或完整幅度观测`);
      if (raw.confidence === "low") throw new Error(`${target.symbol} 低置信归因不能视为完成`);
      if (raw.confidence === "high") {
        const publishers = cause.filter(source => source.sourceType === "publisher");
        const identifiedOrigins = publishers.filter(source => source.provenanceChecked === true && source.reportingOrigin?.identified === true && typeof source.reportingOrigin.key === "string" && source.reportingOrigin.key.length >= 10).map(source => source.reportingOrigin.key);
        if (new Set(identifiedOrigins).size < 2 || new Set(publishers.map(source => normalizedEvidenceText(source.supportingExcerpt))).size < 2) throw new Error(`${target.symbol} 高置信归因缺少独立报道交叉佐证`);
        if (decomposed) for (const company of target.constituents) {
          const reports = chain.chains.filter(item => !item.subjectTargets?.length || item.subjectTargets.includes(company.symbol)).map(item => sourceMap.get(item.reactionEvidenceId));
          const origins = reports.filter(source => source.provenanceChecked === true && source.reportingOrigin?.identified === true && typeof source.reportingOrigin.key === "string" && source.reportingOrigin.key.length >= 10).map(source => source.reportingOrigin.key);
          if (new Set(origins).size < 2 || new Set(reports.map(source => normalizedEvidenceText(source.supportingExcerpt))).size < 2) throw new Error(`${target.symbol} ${company.symbol} 高置信解释缺少逐公司独立报道交叉佐证`);
        }
      }
    }
    const { magnitudeEvidence, ...marketObservation } = observations.get(target.symbol);
    let grounding = [JSON.stringify(target), JSON.stringify(marketObservation), ...cause.map((s) => s.supportingExcerpt), ...size.map((s) => s.supportingExcerpt)].join(" ");
    const why = readerText(raw.why, `${target.symbol} why`, raw.status === "unresolved" ? 20 : 100, 900);
    const whyEn = readerText(raw.whyEn, `${target.symbol} whyEn`, 40, 1_800);
    for (const copy of [why, whyEn]) assertGdpNowCopy(copy, cause);
    if (decomposed && raw.status !== "unresolved" && target.constituents.some(company => !bodySupportsDeterministicTarget(why, envelope, company.symbol) || !bodySupportsDeterministicTarget(whyEn, envelope, company.symbol))) throw new Error(`${target.symbol} 两种语言必须分别保留所有成分股的解释，不能只写净额或一家公司`);
    if (inferred && (!/推断|推论|推测/u.test(why) || !/\binfer(?:ence|red|ring)?\b/iu.test(whyEn))) throw new Error(`${target.symbol} 推断必须在两种语言中明确标注`);
    if (cause.some(source => source.kind === "macro_observation") && (!/观测|观察/u.test(why) || !/平价/u.test(why) || !hasUnknownRatePublication(why) || !/\bobserv(?:ation|ed)\b/iu.test(whyEn) || !/\bpar\b/iu.test(whyEn) || !hasUnknownRatePublication(whyEn))) throw new Error(`${target.symbol} 两种语言须保留观测口径与未知公布时刻，不得把它写成新闻催化`);
    const magnitude = readerText(raw.magnitude, `${target.symbol} magnitude`, 30, 600);
    const magnitudeEn = readerText(raw.magnitudeEn, `${target.symbol} magnitudeEn`, 40, 1_200);
    for (const copy of [magnitude, magnitudeEn]) assertGdpNowCopy(copy, size);
    const selectedMeasurements = validateMagnitudeObservationIds(measurementIds, measured, { copy: magnitude, copyEn: magnitudeEn });
    grounding += " " + JSON.stringify(selectedMeasurements.map(item => item.values));
    const financialCopy = `${why} ${whyEn} ${magnitude} ${magnitudeEn}`;
    const companyOutlooks = verifiedCompanyOutlooks(cause);
    assertCompanyOutlookDescriptions(why, companyOutlooks, `${target.symbol} 中文归因`, "zh");
    assertCompanyOutlookDescriptions(whyEn, companyOutlooks, `${target.symbol} 英文归因`, "en");
    if (/财报|季报|年报|每股收益|营收|季度(?:业绩|结果)|盈利指引|\b(?:EPS|revenue|quarterly results|financial results|earnings guidance)\b/iu.test(financialCopy) && requiresFinancialComparisons(financialCopy, { companyOutlooks })) {
      const comparisons = cause.flatMap((source) => source.comparisons ?? []).filter(item => /每股|营收|收入|利润|盈利|指引|\b(?:EPS|revenue|sales|profit|income|earnings|guidance)\b/iu.test(item.label));
      if (new Set(comparisons.map((item) => `${item.label}|${item.unit}|${item.actualValue}|${item.baselineValue}`)).size < 2) throw new Error(`${target.symbol} 财报归因缺少类型化实际值与预期对照`);
      if (cause.some((source) => (source.comparisons ?? []).some((item) => /EPS|每股收益/iu.test(item.label)) && source.earningsContextChecked !== true)) throw new Error(`${target.symbol} 每股收益尚未核对非经常性收益口径`);
      const metrics = [...new Map(comparisons.map(item => [`${item.label}|${item.unit}|${item.actualValue}|${item.baselineValue}`, publicComparison(item)])).values()];
      const claim = { title: "季度财报", factSummary: "财报实际值与预期", comparisons: metrics };
      assertFinancialCopyIncludesMetrics(`${why} ${magnitude}`, claim, `${target.symbol} 中文财报归因`);
      assertFinancialCopyIncludesMetrics(`${whyEn} ${magnitudeEn}`, claim, `${target.symbol} 英文财报归因`);
      grounding += " " + JSON.stringify(metrics);
    }
    for (const copy of [why, whyEn, magnitude, magnitudeEn]) {
      assertNumbersGrounded(copy, grounding, `${target.symbol} 复盘数字`);
      assertFactsNumbersInExcerpt({ facts: copy, supportingExcerpt: grounding });
    }
    if (raw.status === "unresolved" && (raw.evidenceIds.length || raw.magnitudeEvidenceIds.length || measurementIds.length)) throw new Error(`${target.symbol} 未归因状态不得夹带因果结论`);
    const alternatives = (raw.alternatives ?? []).map((item) => {
      if (!["supported", "contradicted", "unresolved"].includes(item.status)) throw new Error("竞争解释状态无效");
      const sources = ids(item.evidenceIds, sourceMap, "竞争解释", item.status === "unresolved" ? 0 : 1);
      const text = readerText(item.text, "竞争解释", 12, 500), textEn = readerText(item.textEn, "alternative", 20, 900);
      for (const copy of [text, textEn]) {
        assertGdpNowCopy(copy, sources);
        assertNumbersGrounded(copy, [JSON.stringify(target), ...sources.map((s) => s.supportingExcerpt)].join(" "), "竞争解释数字");
      }
      return { text, textEn, status: item.status, sources: sources.map(publicRecapSource) };
    });
    if (!alternatives.length) throw new Error(`${target.symbol} 未检验竞争解释`);
    const opinions = (raw.opinions ?? []).map((item) => {
      const post = socialMap.get(item.postId);
      if (!post) throw new Error("KOL 观点未引用本轮原站记录");
      if (post.textComplete !== true) throw new Error("KOL 观点缺少完整原帖，不能用截断或未确认完整性的文本署名引用");
      if (post.threadContextMissing === true || hasMissingThreadContext(post.text)) throw new Error("KOL 观点来自未核验完整上下文的串帖，须保留为研究线索");
      const corroboration = ids(item.evidenceIds, sourceMap, "KOL 事实佐证");
      const primary = corroboration.filter(source => source.sourceType === "first_party");
      if (!primary.length) throw new Error("KOL 涉及事实缺少官方佐证");
      const text = readerText(item.text, "KOL 观点", 20, 500), textEn = readerText(item.textEn, "KOL perspective", 30, 900);
      const primaryText = primary.map(source => source.supportingExcerpt).join(" ");
      for (const copy of [text, textEn]) {
        assertGdpNowCopy(copy, primary);
        assertNumbersGrounded(copy, primaryText, "KOL 事实数字的官方佐证");
        assertFactsNumbersInExcerpt({ facts: copy, supportingExcerpt: primaryText });
        // Official truth and faithful attribution are separate requirements.
        // A later official value, or another topic's official number, cannot
        // become something this author said in the selected original post.
        assertNumbersGrounded(copy, post.text, "KOL 署名内容的原帖数字");
        assertFactsNumbersInExcerpt({ facts: copy, supportingExcerpt: post.text });
      }
      return { text, textEn, authorHandle: post.authorHandle, url: post.url, publishedAt: post.publishedAt, sources: corroboration.map(publicRecapSource) };
    });
    return {
      target: target.symbol, kind: target.kind, status: raw.status, confidence: raw.confidence,
      why, whyEn, magnitude, magnitudeEn, alternatives, opinions,
      invalidateIf: readerText(raw.invalidateIf, "验证条件", 15, 500),
      invalidateIfEn: readerText(raw.invalidateIfEn, "invalidation", 25, 900),
      sources: [...new Map([...cause, ...size].map((s) => [s.id, publicRecapSource(s)])).values(), ...(observations.get(target.symbol).trading ? [publicTradingSource(observations.get(target.symbol).trading, envelope)] : []), ...observations.get(target.symbol).representativeTrading.map(item => publicTradingSource(item, envelope))],
    };
  });
  const complete = entries.every((item) => item.status === "explained");
  if (requireComplete && !complete) throw new Error(`复盘覆盖不完整：${entries.filter((item) => item.status !== "explained").map((item) => item.target).join(", ")}`);
  return {
    contractVersion: RECAP_VERSION, market: envelope.market, marketAsOf: envelope.marketAsOf,
    status: complete ? "complete" : "partial", entries,
    socialStatus: social.status === "ok" ? (social.leads.length ? "consulted" : "no_relevant_posts") : "unavailable",
  };
}

function publicTradingSource(item, envelope) {
  return { id: `quote-${stableHash(item.symbol).slice(0, 12)}`, url: item.source, label: `${item.sourceLabel} · ${item.symbol}`, publishedAt: envelope.session.windowEnd, verifiedAt: item.verifiedAt, kind: "market_data" };
}

function publicRecapSource(source) {
  const type = verifiedExternalSourceType(source.url);
  if (!["first_party", "publisher"].includes(type) || type !== source.sourceType || !source.excerptHash || !source.verifiedAt) throw new Error("复盘引用未经原文核验的来源");
  return { id: source.id, url: source.url, label: source.sourceLabel, publishedAt: source.publishedAt, verifiedAt: source.verifiedAt };
}

export function validateRecapReview(value, recap) {
  if (value.market !== recap.market || !Array.isArray(value.entries) || value.entries.length !== recap.entries.length) throw new Error("完整复盘缺少逐项独立审稿");
  const reviews = new Map(value.entries.map((item) => [item.target, item]));
  if (reviews.size !== recap.entries.length) throw new Error("复盘审稿目标重复");
  for (const entry of recap.entries) {
    const review = reviews.get(entry.target);
    if (!review || review.verdict !== "pass" || Object.keys(review.scores ?? {}).length !== 5 || ["factualAccuracy", "causality", "magnitude", "sourceIndependence", "readerUtility"].some((key) => !Number.isInteger(review.scores[key]) || review.scores[key] < 4 || review.scores[key] > 5)) throw new Error(`${entry.target} 独立审稿未通过`);
  }
  return value;
}
