import { stableHash } from "./daily-workflow-core.mjs";
import { recapTargets } from "./complete-recap.mjs";
import { yahooLiveArticleIdentity } from "./yahoo-live-article.mjs";

export const RECAP_DISCOVERY_QUERY_BUDGET = 4;
export const RECAP_REPAIR_QUERY_BUDGET = 12;
export const NARRATIVE_QUERY_BUDGET = 12;
export function completeRecapQueryLimit(targetCount) {
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 40) throw new Error("复盘目标数量无效");
  return 4 * targetCount + RECAP_DISCOVERY_QUERY_BUDGET + RECAP_REPAIR_QUERY_BUDGET + NARRATIVE_QUERY_BUDGET;
}
export function availableRecapRepairQueries(limit, consumed, reserved = 0) {
  return Math.min(RECAP_REPAIR_QUERY_BUDGET, Math.max(0, limit - consumed - reserved - NARRATIVE_QUERY_BUDGET));
}

export function assertRecapStageTargets(role, payload, schema) {
  if (!["recap_attributor", "recap_writer", "recap_reviewer"].includes(role)) return;
  const expected = recapTargets(payload.envelope), bounds = schema.properties?.entries;
  if (!Number.isInteger(bounds?.minItems) || !Number.isInteger(bounds?.maxItems) || !Array.isArray(payload.targets) || payload.targets.length < bounds.minItems || payload.targets.length > bounds.maxItems || stableHash(payload.targets) !== stableHash(expected)) throw new Error("复盘输入目标与冻结行情或输出目标数量不一致，未启动原始调用");
}

export function recapDiscoveryQueries(envelope) {
  if (envelope.market !== "US") throw new Error("该收盘报道发现仅适用于美国市场");
  return [
    `${envelope.marketAsOf} US stock market close Yahoo Finance Dow S&P 500 Nasdaq`,
    `${envelope.marketAsOf} site:finance.yahoo.com/markets/live stock market today Treasury yields stocks close`,
  ];
}

export function validateRecapDiscoveryOutput(output, envelope) {
  const queries = recapDiscoveryQueries(envelope);
  if (output?.contractVersion !== "stock-daily-recap-discovery-v1" || output.market !== envelope.market || output.marketAsOf !== envelope.marketAsOf || stableHash(output.queries) !== stableHash(queries) || !Array.isArray(output.sourceUrls) || output.sourceUrls.length > 8 || output.sourceUrls.some(url => typeof url !== "string" || url.length > 2048)) throw new Error("收盘报道发现的交易日、实际查询或地址结构无效");
  const seen = new Set(), leads = [];
  for (const url of output.sourceUrls) {
    const identity = yahooLiveArticleIdentity(url);
    if (!identity || seen.has(identity.canonical)) continue;
    seen.add(identity.canonical);
    leads.push({ url, discoveryOnly: true });
  }
  return leads;
}
