import { recapObservations, recapTargets } from "./complete-recap.mjs";

const GAP_COPY = {
  official_facts: "缺少适用的一手事实",
  independent_origin: "缺少来源独立的价格反应佐证",
  target_causality: "对应目标的经济传导仍待核实",
  magnitude: "净幅度或日内波幅的经济解释仍不足",
};
const GROUP_LABELS = {
  background: "历史敞口（不能单独解释当日涨跌）",
  current: "当日已核事实（尚不等于涨跌原因）",
  reaction: "已核报道中的价格联系（本项归因尚待审查）",
  earlier: "此前或时点未明的已核材料（当日适用性待审查）",
  preserved: "此前私稿保存的材料（本次尚待重新核准，不作为新核事实）",
};

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("私稿交易日无效");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("私稿交易日无效");
  return value;
}

function localDate(value) {
  const [year, month, day] = calendarDate(value).split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function returnNumber(value) {
  if (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?%$/u.test(value)) throw new Error("私稿收盘净变无效");
  const number = Number(value.slice(0, -1));
  if (!Number.isFinite(number)) throw new Error("私稿收盘净变无效");
  return number;
}

const signedPercent = value => `${value > 0 ? "+" : ""}${Object.is(value, -0) ? "0.00" : value.toFixed(2)}%`;
const percentagePoints = value => `${value > 0 ? "+" : ""}${Object.is(value, -0) ? "0.00" : value.toFixed(2)}个百分点`;
const escapeInline = value => String(value).replace(/[\r\n]+/gu, " ").replace(/[\\`*_[\]<>]/gu, "\\$&");
const localizeFactDates = value => value.replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gu, date => {
  try { return localDate(date); } catch { return date; }
});

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function applicableSource(source, target) {
  if (!source || ["failed", "invalid", "rejected"].includes(source.status) || !Array.isArray(source.targets)) return null;
  const companies = new Set((target.constituents ?? []).map(company => company.symbol));
  const directlyBound = source.targets.includes(target.symbol);
  const companyTargets = source.targets.filter(symbol => companies.has(symbol));
  if (source.scope === "company") {
    const subjects = (source.backgroundSubjects ?? []).filter(symbol => companies.has(symbol));
    if (companyTargets.length) return { subjects: companyTargets };
    if (directlyBound && subjects.length) return { subjects };
    // A whole-target reported company connection may already be bound to the
    // target in the verified ledger. Preserve it as a candidate, not a cause.
    if (directlyBound && source.kind !== "background") return { subjects: [] };
    return null;
  }
  if (!directlyBound) return null;
  if (["market", "market_variable", "event_only"].includes(source.scope)) return target.kind === "market" ? { subjects: [] } : null;
  if (["sector", "subsector"].includes(source.scope)) return target.kind === "sector" ? { subjects: [] } : null;
  if (source.scope === "ai_layer") return target.kind === "ai_layer" ? { subjects: [] } : null;
  return null;
}

function evidenceGroup(source, asOf, market) {
  if (source.kind === "background") return "background";
  if (source.role === "causal" || source.kind === "market_wrap") return "reaction";
  let date = source.publishedAt;
  if (typeof date === "string" && /(?:Z|[+-]\d{2}:\d{2})$/u.test(date) && Number.isFinite(Date.parse(date))) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: market === "US" ? "America/New_York" : "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(date));
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    date = `${fields.year}-${fields.month}-${fields.day}`;
  }
  return date === asOf ? "current" : "earlier";
}

function validatedEntries(recap, envelope, targets) {
  if (recap === null) return new Map();
  if (recap?.market !== envelope.market || recap?.marketAsOf !== envelope.marketAsOf || !Array.isArray(recap.entries) || recap.entries.length !== targets.length) throw new Error("已验证成稿与私稿市场、交易日或目标不一致");
  const entries = new Map(recap.entries.map(entry => [entry?.target, entry]));
  if (entries.size !== targets.length || targets.some(target => !entries.has(target.symbol))) throw new Error("已验证成稿目标遗漏或重复");
  for (const entry of entries.values()) if (typeof entry.why !== "string" || typeof entry.magnitude !== "string") throw new Error("已验证成稿缺少可读正文");
  return entries;
}

/**
 * A local, incomplete reading draft. The caller owns evidence verification
 * and validation of any supplied recap; this function grants no approval and
 * performs no research. Raw worker outputs and rejected leads are not inputs.
 */
export function buildPrivateRecapDraft({ envelope, observations = null, verifiedLedger = { sources: [] }, coverage = null, roleStates = {}, validatedRecap = null, preservedDraft = null }) {
  if (!["US", "CN"].includes(envelope?.market)) throw new Error("私稿市场无效");
  const asOf = calendarDate(envelope.marketAsOf);
  const targets = recapTargets(envelope);
  for (const target of targets) {
    if (target.asOf !== asOf || (target.market && target.market !== envelope.market)) throw new Error("私稿目标交易日或市场不一致");
    returnNumber(target.change);
    for (const company of target.constituents ?? []) if (company.asOf !== asOf) throw new Error("私稿成分交易日不一致");
  }
  const baseline = recapObservations(envelope);
  const supplied = observations ?? baseline;
  if (!Array.isArray(supplied) || supplied.length !== targets.length) throw new Error("私稿观测必须覆盖20个目标");
  const observed = new Map(supplied.map(item => [item?.target, item]));
  if (observed.size !== targets.length || targets.some(target => !observed.has(target.symbol))) throw new Error("私稿观测目标遗漏或重复");
  for (const target of targets) {
    const observation = observed.get(target.symbol);
    if (observation.asOf !== asOf || Math.abs(returnNumber(observation.closingReturn) - returnNumber(target.change)) > 0.010001) throw new Error("私稿观测交易日或收盘净变不一致");
    if (observation.trading && (observation.trading.symbol !== target.symbol || observation.trading.asOf !== asOf)) throw new Error("私稿日线目标或交易日不一致");
  }
  if (!verifiedLedger || !Array.isArray(verifiedLedger.sources) || (verifiedLedger.market && verifiedLedger.market !== envelope.market) || (verifiedLedger.marketAsOf && verifiedLedger.marketAsOf !== asOf)) throw new Error("私稿核实证据的市场或交易日不一致");
  if (coverage && ((coverage.market && coverage.market !== envelope.market) || (coverage.marketAsOf && coverage.marketAsOf !== asOf))) throw new Error("私稿覆盖记录的市场或交易日不一致");
  const preserved = validatedEntries(validatedRecap, envelope, targets);
  let priorEntries = new Map();
  if (preservedDraft) {
    if (preservedDraft.approved !== false || preservedDraft.market !== envelope.market || preservedDraft.marketAsOf !== asOf || !Array.isArray(preservedDraft.entries) || preservedDraft.entries.length !== targets.length) throw new Error("此前私稿与冻结市场、交易日或目标不一致");
    priorEntries = new Map(preservedDraft.entries.map(entry => [entry.target, entry]));
    if (priorEntries.size !== targets.length || targets.some(target => !priorEntries.has(target.symbol))) throw new Error("此前私稿目标遗漏或重复");
  }
  const rejectedUrls = new Set((verifiedLedger.rejected ?? []).flatMap(source => [source.url, source.originalUrl]).map(sourceUrl).filter(Boolean));
  const baseByTarget = new Map(baseline.map(item => [item.target, item]));
  const coverageByTarget = new Map((coverage?.entries ?? []).map(item => [item.target, item]));
  const sourceIds = new Set();
  for (const source of verifiedLedger.sources) {
    if (typeof source?.id !== "string" || !source.id || sourceIds.has(source.id)) throw new Error("私稿核实证据标识缺失或重复");
    sourceIds.add(source.id);
  }
  const entries = targets.map(target => {
    const observation = observed.get(target.symbol), arithmetic = baseByTarget.get(target.symbol);
    const basket = target.benchmarkKind === "equal_weight_basket";
    const range = !basket && Number.isFinite(observation.trading?.intradayRange) && observation.trading.intradayRange >= 0 ? observation.trading.intradayRange : null;
    const rangeCopy = basket ? "篮子日内波幅尚未观测；成分股各自高低点不能合成为篮子波幅。" : range === null ? "该目标日内波幅尚未核实。" : `日内波幅为${range.toFixed(2)}%，口径为最高价减最低价、再除以前收盘价；它与收盘净变不同。`;
    const representatives = arithmetic.representatives.map(company => ({ symbol: company.symbol, name: company.name, change: signedPercent(company.change) }));
    const representativeCopy = representatives.length ? `代表标的表现：${representatives.map(company => `${company.name || company.symbol}（${company.symbol}）${company.change}`).join("；")}。这些代表标的不能代替全行业涨跌家数或行业权重。` : "";
    const equalWeightCopy = basket ? `四只代表标的等权计算中，正贡献合计${percentagePoints(arithmetic.representatives.filter(company => company.change > 0).reduce((sum, company) => sum + company.change / 4, 0))}，负贡献合计${percentagePoints(arithmetic.representatives.filter(company => company.change < 0).reduce((sum, company) => sum + company.change / 4, 0))}，相加得到${arithmetic.equalWeight.reconstructedReturn}（四舍五入容差0.01个百分点）。这是净变化的算术拆分，不能证明成分股为什么涨跌，也不能解释篮子日内波幅。` : "";
    const sources = [], sourceGroups = { background: [], current: [], reaction: [], earlier: [], preserved: [] };
    const factItems = [];
    for (const source of [...verifiedLedger.sources].sort((a, b) => a.id.localeCompare(b.id))) {
      const binding = applicableSource(source, target), url = sourceUrl(source.url ?? source.originalUrl);
      if (!binding || !url || typeof source.facts !== "string" || !source.facts.trim()) continue;
      const group = evidenceGroup(source, asOf, envelope.market);
      sources.push({ id: source.id, url, ...(sourceUrl(source.originalUrl) ? { originalUrl: sourceUrl(source.originalUrl) } : {}), sourceLabel: typeof source.sourceLabel === "string" ? source.sourceLabel : new URL(url).hostname, facts: source.facts, kind: source.kind ?? "unknown" });
      sourceGroups[group].push(source.id);
      factItems.push({ sourceId: source.id, group, subjects: [...new Set(binding.subjects)].sort() });
    }
    // Preserve earlier readable material on a same-input resume while the
    // cumulative verified ledger is being rebuilt. It stays separate from
    // current facts and never enters the real attribution/publication ledger.
    const currentIds = new Set(sources.map(source => source.id));
    const priorEntry = priorEntries.get(target.symbol);
    for (const source of priorEntry?.sources ?? []) {
      if (currentIds.has(source.id) || sourceIds.has(source.id) || [source.url, source.originalUrl].some(url => rejectedUrls.has(sourceUrl(url)))) continue;
      if (typeof source.id !== "string" || !source.id || !sourceUrl(source.url) || typeof source.facts !== "string") throw new Error("此前私稿的材料记录无效");
      sources.push({ ...source }); currentIds.add(source.id);
      sourceGroups.preserved.push(source.id);
      factItems.push({ sourceId: source.id, group: "preserved", subjects: priorEntry.factItems?.find(item => item.sourceId === source.id)?.subjects ?? [] });
    }
    const existing = preserved.get(target.symbol);
    const states = Object.values(roleStates).filter(state => state?.target === target.symbol).map(state => ({ role: state.role, status: state.status })).sort((a, b) => String(a.role).localeCompare(String(b.role)));
    const gaps = [...new Set((coverageByTarget.get(target.symbol)?.gaps ?? []).map(gap => GAP_COPY[gap] ?? "完成本项归因所需证据仍有缺口"))];
    if (states.some(state => state.status !== "completed")) gaps.push("本项已有研究尚未全部完成，不能据此认可归因");
    if (range === null) gaps.push(basket ? "缺少篮子同步分时波幅" : "缺少已核日内波幅");
    gaps.push(existing ? "已有正文仍待同一版本独立审查" : "尚无经过实际验证的当日经济解释；方向、净幅度、日内波幅及反证仍待审查");
    return {
      target: target.symbol, name: target.name ?? target.symbol, kind: target.kind,
      approved: false, status: existing ? "pending_review" : "unresolved",
      closingReturn: target.change, intradayRange: range, representatives,
      observation: `收盘净变${target.change}。${rangeCopy}`, representativeCopy, equalWeightCopy,
      why: existing?.why ?? "已核材料可供继续分析，但没有经过验证的经济解释。不能仅凭同日新闻、历史风险敞口或价格算术认定本次涨跌原因。",
      magnitude: existing?.magnitude ?? rangeCopy,
      sources, sourceGroups, factItems, roleStates: states, gaps: [...new Set(gaps)],
    };
  });
  const marketName = envelope.market === "US" ? "美股" : "A股";
  const parts = [`# ${marketName}复盘私稿 · ${localDate(asOf)}`, "", "当前报告未完成，未经独立审查，不可发布。以下逐项保留已核行情与材料；缺失解释不视为通过。"];
  for (const entry of entries) {
    const title = /^AI-(?:US|CN)-/u.test(entry.target) ? escapeInline(entry.name) : `${escapeInline(entry.name)}（${escapeInline(entry.target)}）`;
    parts.push("", `## ${title}`, "", entry.observation);
    if (entry.representativeCopy) parts.push("", entry.representativeCopy);
    if (entry.equalWeightCopy) parts.push("", entry.equalWeightCopy);
    parts.push("", entry.why, "", entry.magnitude);
    const byId = new Map(entry.sources.map(source => [source.id, source]));
    for (const [group, label] of Object.entries(GROUP_LABELS)) {
      const items = entry.factItems.filter(item => item.group === group);
      if (!items.length) continue;
      parts.push("", `${label}：`, "");
      const lines = new Map();
      for (const item of items) {
        const source = byId.get(item.sourceId), subject = item.subjects.length ? `公司层面（${item.subjects.join("、")}）：` : "";
        // Facts are already verified summaries, not original source excerpts.
        // Preserve qualifications and contrary evidence even in longer facts.
        const copy = `${subject}${escapeInline(localizeFactDates(source.facts))}`;
        const citation = `[${escapeInline(source.sourceLabel)}](${source.url})`;
        const citations = lines.get(copy) ?? [];
        if (!citations.includes(citation)) citations.push(citation);
        lines.set(copy, citations);
      }
      for (const [copy, citations] of lines) parts.push(`- ${copy} ${citations.join("、")}`);
    }
    if (!entry.sources.length) parts.push("", "尚无已核实且适用本目标的事实材料。");
    parts.push("", `待完成：${entry.gaps.join("；")}。`);
  }
  return { market: envelope.market, marketAsOf: asOf, approved: false, status: "incomplete", entries, markdown: `${parts.join("\n")}\n` };
}
