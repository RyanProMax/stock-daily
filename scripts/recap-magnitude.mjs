import { stableHash } from "./daily-workflow-core.mjs";

const fixed = value => Number(value).toFixed(2);
const pp = value => `${fixed(value)} 个百分点 (${fixed(value)} percentage points)`;
const ratio = value => `${fixed(value)} 倍 (${fixed(value)} times)`;

// Input is produced only after the frozen quotations and original daily bars
// pass validation. These are measurement records, never news or causal claims.
export function magnitudeEvidenceForObservation(observation) {
  const records = [];
  const add = (kind, values, required, terms, limitation) => records.push({
    id: `measure-${stableHash(observation.target).slice(0, 12)}-${kind}`,
    target: observation.target, kind, values, required, terms, limitation,
  });
  const bar = observation.trading;
  if (bar) {
    add("session-path", {
      openingGap: `${fixed(bar.openingGap)}%`, openToClose: `${fixed(bar.openToClose)}%`,
      closingReturn: bar.closingReturnDisplay,
      roundingTolerance: "0.01 个百分点 (0.01 percentage points)",
      relation: bar.openingGap * bar.openToClose < 0 ? "offset" : "reinforce_or_zero",
      source: bar.source,
    }, [bar.openingGap, bar.openToClose], {
      zh: "开盘|缺口", en: "open|gap",
    }, "Both return components use the previous close as denominator. Their sum establishes the net closing return, not the cause of either component.");
    add("session-range", {
      intradayRange: bar.intradayRangeDisplay, closingReturn: bar.closingReturnDisplay,
      source: bar.source,
    }, [bar.intradayRange], {
      zh: "振幅|波幅|日内", en: "intraday|range",
    }, "High minus low divided by the previous close; distinct from the closing return and never proof of a catalyst.");
    if (bar.baselineSessions === 20 && bar.rangeVsPrior20Median !== null) add("range-baseline", {
      rangeRatio: ratio(bar.rangeVsPrior20Median), baselineSessions: 20, source: bar.source,
    }, [bar.rangeVsPrior20Median], { zh: "中位数", en: "median" }, "The baseline excludes the current session. A range ratio measures relative amplitude, not its economic cause.");
    if (bar.baselineSessions === 20 && bar.volumeVsPrior20Median !== null) add("volume-baseline", {
      volumeRatio: ratio(bar.volumeVsPrior20Median), baselineSessions: 20, source: bar.source,
    }, [bar.volumeVsPrior20Median], { zh: "成交|交易量", en: "volume" }, "Trading volume in this instrument is not industry-wide activity or net capital flow, and alone cannot establish what limited prices.");
  }
  if (observation.equalWeight) {
    const positive = observation.representatives.filter(item => item.change > 0).reduce((sum, item) => sum + item.change / 4, 0);
    const negative = observation.representatives.filter(item => item.change < 0).reduce((sum, item) => sum + item.change / 4, 0);
    add("basket-offset", {
      positiveContribution: pp(positive), negativeContribution: pp(negative),
      reconstructedReturn: observation.equalWeight.reconstructedReturn,
      constituentCount: 4, roundingTolerance: observation.equalWeight.roundingTolerance,
      sources: observation.representatives.map(item => item.source),
    }, [positive, negative], {
      zh: "等权", en: "equal[ -]weight",
    }, "Exact arithmetic for the supplied four-stock equal-weight basket, within its rounding tolerance. It does not identify constituent catalysts, intraday basket extremes, industry breadth or sector-index contributions.");
  }
  return { target: observation.target, records };
}

export function hasMeasuredMagnitude(profile, selectedIds = profile.records.map(item => item.id)) {
  const selected = new Set(selectedIds);
  const kinds = new Set(profile.records.filter(item => selected.has(item.id)).map(item => item.kind));
  return kinds.has("basket-offset") || (kinds.has("session-path") && kinds.has("session-range"));
}

function quantityAppears(copy, value, kind) {
  const number = fixed(Math.abs(value)).replace(".", "\\.");
  const unit = kind.endsWith("baseline") ? "(?:倍|times|x|×)" : kind === "basket-offset" ? "(?:个百分点|percentage points)" : kind === "session-range" ? "%" : "(?:%|个百分点|percentage points)";
  const sign = value < 0 ? "-" : "\\+?";
  return new RegExp(`(?<![\\d.+-])${sign}${number}\\s*${unit}`, "iu").test(copy);
}

export function validateMagnitudeObservationIds(values, profile, { copy, copyEn }) {
  if (!Array.isArray(values) || new Set(values).size !== values.length || values.length > 5) throw new Error(`${profile.target} 幅度观测引用无效`);
  const records = new Map(profile.records.map(item => [item.id, item]));
  const selected = values.map(id => {
    const record = records.get(id);
    if (!record) throw new Error(`${profile.target} 幅度观测不存在或属于其他目标`);
    for (const [language, text] of [["zh", copy], ["en", copyEn]]) {
      if (!new RegExp(record.terms[language], "iu").test(text) || record.required.some(value => !quantityAppears(text, value, record.kind))) throw new Error(`${profile.target} ${language} 幅度解释未展示所引用的实际观测`);
    }
    return record;
  });
  return selected;
}
