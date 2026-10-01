import { recapFixture } from "./complete-recap-fixture.mjs";
import { sourceBodyText, sourcePublishedAtCandidates, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { sourceArticleProvenance } from "../scripts/source-article-provenance.mjs";
import { CHINA_PMI_INDEX, CHINA_PMI_INTERPRETATION_INDEX } from "../scripts/recap-china-pmi-data.mjs";

export const releaseUrl = `${CHINA_PMI_INDEX}202609/t20260930_1965449.html`;
export const interpretationUrl = `${CHINA_PMI_INTERPRETATION_INDEX}202609/t20260930_1965450.html`;
export const releaseTitle = "2026年9月中国采购经理指数运行情况";
export const interpretationTitle = "国家统计局服务业调查中心首席统计师霍丽慧解读2026年9月中国采购经理指数";
const configurations = [
  [["PMI", "生产", "新订单", "原材料库存", "从业人员", "供应商配送时间"], [49.8, 50.4, 50.6, 48.1, 48.7, 50.1], [50.1, 51.7, 50.5, 48.2, 48.4, 50.1]],
  [["新出口订单", "进口", "采购量", "主要原材料购进价格", "出厂价格", "产成品库存", "在手订单", "生产经营活动预期"], [50.1, 48.6, 50.5, 56.6, 50.4, 48.4, 46.7, 53.8], [50, 49.2, 51, 60.8, 54, 47.6, 46, 53.8]],
  [["商务活动", "新订单", "投入品价格", "销售价格", "从业人员", "业务活动预期"], [49, 44.1, 51.1, 49.3, 45.4, 55], [50.2, 46.5, 52.5, 50.3, 45.9, 55.5]],
  [["新出口订单", "在手订单", "存货", "供应商配送时间"], [47, 42.8, 45.6, 51.2], [48.5, 43.8, 46.3, 51.3]],
];
const paragraph = text => `<p>${text}</p>`;
const tables = configurations.map(([header, previous, current]) => `<table><tr><td>单位：%</td></tr><tr>${["", ...header].map(value => `<td>${value}</td>`).join("")}</tr>${[["2026年8月", previous], ["2026年9月", current]].map(([month, values]) => `<tr><td>${month}</td>${values.map(value => `<td>${value.toFixed(1)}</td>`).join("")}</tr>`).join("")}</table>`);
const narration = (label, actual, change) => `${label}为${actual.toFixed(1)}%，${change === 0 ? "与上月持平" : `比上月${change > 0 ? "上升" : "下降"}${Math.abs(change).toFixed(1)}个百分点`}，其水平与变化需分别考察。`;
const body = [paragraph("国家统计局服务业调查中心、中国物流与采购联合会"), paragraph("一、中国制造业采购经理指数运行情况"), ...["制造业采购经理指数（PMI）", "生产指数", "新订单指数", "原材料库存指数", "从业人员指数", "供应商配送时间指数"].map((label, index) => paragraph(narration(label, configurations[0][2][index], Number((configurations[0][2][index] - configurations[0][1][index]).toFixed(1))))), paragraph("表1 中国制造业PMI及构成指数（经季节调整）"), tables[0], paragraph("表2 中国制造业其他相关指标"), tables[1], paragraph("二、中国非制造业采购经理指数运行情况"), ...["非制造业商务活动指数", "新订单指数", "投入品价格指数", "销售价格指数", "从业人员指数", "业务活动预期指数"].map((label, index) => paragraph(narration(label, configurations[2][2][index], Number((configurations[2][2][index] - configurations[2][1][index]).toFixed(1))))), paragraph("表3 中国非制造业主要分类指数（经季节调整）"), tables[2], paragraph("表4 中国非制造业其他分类指数"), tables[3], paragraph("三、中国综合PMI产出指数运行情况"), paragraph("综合PMI产出指数为50.7%，比上月上升1.2个百分点，调查显示经营活动有所变化。"), paragraph("附注 指标采用扩散指数：回答不变的百分比的一半计入其中。PMI高于50%和低于50%分别对应不同调查方向。供应商配送时间指数为逆指数。采用季节调整后的数据。新订单权数为30%，生产权数为25%，从业人员权数为20%，配送时间权数为15%，库存权数为10%。综合权重依制造业和非制造业占GDP的比重确定。")].join("");

export function pmiHtml({ interpretation = false, duplicate = true, clock = "09:30", content = null } = {}) {
  const title = interpretation ? interpretationTitle : releaseTitle;
  const text = content ?? (interpretation ? paragraph("制造业采购经理指数、非制造业商务活动指数和综合PMI产出指数分别为50.1%、50.2%和50.7%，比上月上升0.3个、1.2个和1.2个百分点。国家统计局服务业调查中心发布本月采购经理调查解读。制造业部分行业的生产与订单不同；景气调查行业范围与股票指数范围须分别识别。金融服务、房地产和建筑施工的经营调查结果存在差异，企业规模分类也不能直接等同于上市公司的股票篮子。") : body);
  return `<html><head><title>${title}</title><meta name="ArticleTitle" content="${title}"><meta name="PubDate" content="2026/09/30 ${clock}"></head><body><div class="detail-title"><h1><script>var title1 = '${title}';</script></h1><div class="detail-title-des"><h2>2026/09/30 ${clock}</h2></div></div><div class="detail-text-content"><div class="txt-content">${text}</div></div>${duplicate ? `<div class="mobile-content"><div class="mobile-news-content">${text}</div></div>` : ""}</body></html>`;
}

export function indexHtml({ interpretation = false, listedUrl, listedTitle, date = "2026-09-30", entries = true, paginated = false } = {}) {
  const title = listedTitle ?? (interpretation ? interpretationTitle : releaseTitle), url = listedUrl ?? (interpretation ? interpretationUrl : releaseUrl);
  return `<html><head><meta name="ColumnName" content="${interpretation ? "数据解读" : "数据发布"}"></head><body><ul>${entries ? `<li><a href="${url}" title="${title}">${title}</a><a href="${url}" title="${title}">${title}</a><span>${date}</span></li>` : ""}</ul><p>官方统计数据目录，保留固定条目名称及发布日期供核对。页面页脚和相关文章不属于发布正文。原文链接需核验同一发布记录与月度观察。目录还可以列出经济运行、工业生产和企业经营情况等统计发布信息，每一项都需要与对应原始发布页逐项核对。</p>${paginated ? '<script>createPageHTML(67, 0, "index", "html");</script>' : ""}</body></html>`;
}

export function pmiEnvelope() {
  const envelope = recapFixture("CN").envelope;
  envelope.marketAsOf = "2026-09-30";
  envelope.session = { ...envelope.session, previousAsOf: "2026-09-29", windowStart: "2026-09-29T07:00:00Z", windowEnd: "2026-09-30T07:00:00Z", wrapDeadline: "2026-09-30T09:00:00Z" };
  for (const metric of [...envelope.markets, ...envelope.sectorPerformance, ...envelope.aiChainPerformance]) {
    metric.asOf = envelope.marketAsOf;
    for (const company of metric.constituents ?? []) company.asOf = envelope.marketAsOf;
  }
  return envelope;
}

export function openedHtml(url, html) {
  const rawBody = Buffer.from(html), contentType = "text/html; charset=utf-8";
  return { source: url, finalUrl: url, status: 200, contentType, rawBody, text: sourceBodyText(rawBody, contentType), publishedAtCandidates: sourcePublishedAtCandidates(rawBody, contentType, url), publishedDateCandidates: sourcePublishedDateCandidates(rawBody, contentType, url), metadataReceipts: [], articleProvenance: sourceArticleProvenance(html, url), fetchedAt: "2026-10-01T12:00:00.000Z" };
}

export function pmiReader(overrides = new Map()) {
  const html = new Map([[CHINA_PMI_INDEX, indexHtml()], [CHINA_PMI_INTERPRETATION_INDEX, indexHtml({ interpretation: true })], [releaseUrl, pmiHtml()], [interpretationUrl, pmiHtml({ interpretation: true })], ...overrides]);
  return async url => { const value = html.get(url); if (value instanceof Error) throw value; if (typeof value !== "string") throw new Error("No fixture at this exact original URL"); return openedHtml(url, value); };
}
