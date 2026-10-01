import { readFile } from "node:fs/promises";
import { stableHash, bodySupportsDeterministicTarget } from "./daily-workflow-core.mjs";
import { readExternalSource, sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates, normalizedEvidenceText } from "./daily-source-audit.mjs";
import { backgroundEvidenceInWindow } from "./evidence-timing.mjs";

const CONFIG = new URL("../data/recap-transmission-sources.json", import.meta.url);
const FACTOR = /demand|supply|costs?|rates?|financing|regulat/iu;

function completeRiskSentences(section) {
  const offsets = [], footers = [...section.matchAll(/\n\d{1,3}\nFund Summaries\nX(?:[A-Z]{2}|LRE)\n/gu)];
  let clean = "", cursor = 0;
  for (const footer of footers) {
    for (let index = cursor; index < footer.index; index++) { offsets.push(index); clean += section[index]; }
    offsets.push(footer.index); clean += " "; cursor = footer.index + footer[0].length;
  }
  for (let index = cursor; index < section.length; index++) { offsets.push(index); clean += section[index]; }
  return [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(clean)].map(item => {
    const start = item.index + item.segment.length - item.segment.trimStart().length;
    const end = item.index + item.segment.trimEnd().length;
    return section.slice(offsets[start], offsets[end - 1] + 1).trim();
  }).filter(Boolean);
}

function derive(snapshot, envelope, plan) {
  const config = snapshot.config;
  const url = new URL(snapshot.finalUrl);
  if (url.href !== config.url || url.protocol !== "https:" || url.hostname !== "www.sec.gov" || !/^\/Archives\/edgar\/data\/1064641\/\d+\/[^/]+\.htm$/u.test(url.pathname) || snapshot.status !== 200 || snapshot.contentType !== "text/html" || Buffer.byteLength(snapshot.rawHtml) > 8 * 1024 * 1024 || stableHash(snapshot.rawHtml) !== snapshot.sourceHash) throw new Error("行业背景原文的权威地址、响应或冻结哈希不一致");
  const body = Buffer.from(snapshot.rawHtml);
  const text = sourceBodyText(body, snapshot.contentType);
  if (!normalizedEvidenceText(text).includes(normalizedEvidenceText(config.issuer))) throw new Error("行业背景原文未确认基金发行主体");
  const dates = sourcePublishedDateCandidates(body, snapshot.contentType, snapshot.finalUrl);
  if (dates.length !== 1 || !backgroundEvidenceInWindow(dates[0], envelope)) throw new Error("行业背景缺少明确、未过期的原始申报日期");
  const sources = [], gaps = [];
  for (const anomaly of plan.anomalies.filter(item => item.kind === "sector")) {
    try {
      const name = config.sectors[anomaly.target];
      if (!name) throw new Error("缺少对应基金的原始风险标题");
      const heading = `${name} Sector Risk:`;
      const at = text.indexOf(heading);
      if (at < 0) throw new Error("原文未包含对应行业风险段落");
      const tail = text.slice(at + heading.length);
      const next = /\n[A-Z][^\n:]{1,100} Risk:/u.exec(tail);
      const section = heading + tail.slice(0, next ? next.index : 3_000);
      const sentences = completeRiskSentences(section), first = sentences[0];
      // Segment an unpaged view, then recover the full original sentence.
      // A footer cannot orphan a subject or remove an economic qualification.
      const factor = (name === "Utilities" ? sentences.slice(1).find(item => /inverse relationship.*interest rates/iu.test(item)) : null) ?? sentences.slice(1).find(item => FACTOR.test(item) && heading.length + item.length + 1 <= 700);
      if (!first || !factor || heading.length + factor.length + 1 > 700) throw new Error("未找到完整且有传导因素的原始句子");
      const prefix = first.length + factor.length + 1 <= 700 ? first : heading;
      let excerpt = `${prefix}\n${factor}`;
      if (!bodySupportsDeterministicTarget(excerpt, envelope, anomaly.target)) {
        const between = section.slice(heading.length, section.indexOf(factor) + factor.length);
        const marker = /\nFund Summaries\n(X(?:[A-Z]{2}|LRE))\n/u.exec(between);
        if (marker?.[1] !== anomaly.target) throw new Error("风险正文未确认对应基金代码");
        excerpt = `${prefix}\n${marker[1]}\n${factor}`;
      }
      if (excerpt.length > 700) throw new Error("完整原始段落超过可核验长度");
      sources.push({ originalUrl: config.url, sourceLabel: "SEC", title: `${config.issuer}: ${heading.slice(0, -1)}`, publishedAt: dates[0], kind: "background", supportingExcerpt: excerpt, facts: `${anomaly.observation.name}基金的一手风险披露说明，该行业的结构性暴露可能影响经营表现；这是此前披露的风险机制，不能单独证明本次交易日的价格原因。`, scope: "sector", targets: [anomaly.target], hypothesisIds: [anomaly.hypotheses[1].id], causalConnection: false, comparisons: [], role: "facts", anomalyId: anomaly.id });
    } catch (error) { gaps.push({ target: anomaly.target, reason: error.message }); }
  }
  return { sources, gaps };
}

export function validateRecapTransmissionData(value, envelope, plan) {
  if (value.market !== envelope.market || value.marketAsOf !== envelope.marketAsOf || !Array.isArray(value.snapshots) || value.snapshots.length > 1 || !Array.isArray(value.sources) || !Array.isArray(value.gaps)) throw new Error("行业背景冻结输入与交易日不一致");
  const derived = value.snapshots.length ? derive(value.snapshots[0], envelope, plan) : { sources: [], gaps: value.gaps };
  if (stableHash(derived.sources) !== stableHash(value.sources) || (value.snapshots.length && stableHash(derived.gaps) !== stableHash(value.gaps))) throw new Error("行业背景段落无法由冻结原文重复提取");
  return value;
}

export function transmissionSourceReader(value, fallback = readExternalSource) {
  const originals = new Map(value.snapshots.map(snapshot => [snapshot.finalUrl, snapshot]));
  const parsed = new Map();
  return async (url, options = {}) => {
    const snapshot = originals.get(url);
    if (!snapshot) return fallback(url, options);
    if (parsed.has(url)) return parsed.get(url);
    const body = Buffer.from(snapshot.rawHtml);
    const opened = { source: url, finalUrl: snapshot.finalUrl, status: snapshot.status, contentType: snapshot.contentType, rawBody: body, metadataReceipts: [], text: sourceBodyText(body, snapshot.contentType), publishedAtCandidates: sourcePublishedAtCandidates(body, snapshot.contentType, snapshot.finalUrl), publishedDateCandidates: sourcePublishedDateCandidates(body, snapshot.contentType, snapshot.finalUrl) };
    parsed.set(url, opened);
    return opened;
  };
}

export async function collectRecapTransmissionData(envelope, plan, { reader = readExternalSource, config } = {}) {
  const empty = { market: envelope.market, marketAsOf: envelope.marketAsOf, snapshots: [], sources: [], gaps: [] };
  if (envelope.market !== "US") return empty;
  config ??= JSON.parse(await readFile(CONFIG, "utf8"));
  try {
    const opened = await reader(config.url, { includeRaw: true, maxBytes: 8 * 1024 * 1024 });
    const rawHtml = opened.rawBody.toString("utf8");
    const snapshot = { config, finalUrl: opened.finalUrl, status: opened.status, contentType: opened.contentType.split(";")[0], rawHtml, sourceHash: stableHash(rawHtml), fetchedAt: new Date().toISOString() };
    return { ...empty, snapshots: [snapshot], ...derive(snapshot, envelope, plan) };
  } catch (error) {
    return { ...empty, gaps: plan.anomalies.filter(item => item.kind === "sector").map(item => ({ target: item.target, reason: `一手行业背景不可用：${error.message}` })) };
  }
}
