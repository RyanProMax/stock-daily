import { JSDOM } from "jsdom";

export const CHINA_PMI_RELEASE_VERSION = "verified-nbs-pmi-release-v1";
export const CHINA_PMI_EVIDENCE_VERSION = "verified-nbs-pmi-survey-v1";
const compact = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, "").trim();
const clean = value => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const period = (year, month) => `${year}-${String(month).padStart(2, "0")}`;
const previousPeriod = value => { const [year, month] = value.split("-").map(Number); return period(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1); };
const round = value => Number(value.toFixed(6));

export function isChinaPmiArticle(source) {
  try {
    const url = new URL(source);
    return url.origin === "https://www.stats.gov.cn" && !url.username && !url.password && !url.search && !url.hash && /^\/(?:sj\/(?:zxfb|sjjd)|zwfwck\/sjfb)\/20\d{4}\/t20\d{6}_[1-9]\d{5,9}\.html$/u.test(url.pathname);
  } catch { return false; }
}

// This is the native, reviewed NBS article template, not arbitrary PubDate
// metadata or a timestamp inferred from an article path. Never execute its JS.
export function chinaPmiDocument(html, source) {
  if (!isChinaPmiArticle(source)) return null;
  const document = new JSDOM(html).window.document;
  const title = clean(document.querySelector("title")?.textContent).replace(/\s*[-_]\s*国家统计局$/u, "");
  const titleMatch = /^(?:(?:国家统计局服务业调查中心首席统计师[^\d]{2,12}解读))?(20\d{2})年([1-9]|1[0-2])月中国采购经理指数(?:运行情况)?$/u.exec(title);
  if (!titleMatch) return null;
  const pathname = new URL(source).pathname, interpretation = title.includes("解读");
  if ((!interpretation && !title.endsWith("运行情况")) || (pathname.startsWith("/sj/zxfb/") && interpretation) || (pathname.startsWith("/sj/sjjd/") && !interpretation)) return null;
  const header = [...document.querySelectorAll(".detail-title, .center_xilan > .xilan_tit")];
  if (header.length !== 1) return null;
  const titleScripts = [...header[0].querySelectorAll("script")].flatMap(node => [...node.textContent.matchAll(/\bvar title1 = '([^'\r\n]*)';/gu)].map(match => match[1]));
  if (titleScripts.length !== 1 || compact(titleScripts[0]) !== compact(title)) return null;
  const titleMetas = [...document.querySelectorAll('meta[name="ArticleTitle"]')];
  if (titleMetas.length > 1 || (pathname.startsWith("/sj/") && titleMetas.length !== 1) || (titleMetas.length && compact(titleMetas[0].content) !== compact(title))) return null;
  const clockNodes = [...document.querySelectorAll(".detail-title-des > h2, .center_xilan > .xilan_titf")];
  if (!clockNodes.length) return null;
  const clocks = clockNodes.map(node => {
    const clone = node.cloneNode(true); clone.querySelectorAll("script,style").forEach(item => item.remove());
    if (pathname.startsWith("/zwfwck/") && !/发布时间：/u.test(clone.textContent)) return [];
    return [...clean(clone.textContent).matchAll(/(?:发布时间：)?(20\d{2})[-/](\d{2})[-/](\d{2})\s+([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?/gu)].map(match => `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}+08:00`);
  }).flat();
  if (clocks.length !== 1) return null;
  const date = clocks[0].slice(0, 10), instant = Date.parse(clocks[0]);
  if (!Number.isFinite(instant) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return null;
  const pubMetas = [...document.querySelectorAll('meta[name="PubDate"]')];
  if (pubMetas.length > 1 || (pathname.startsWith("/sj/") && pubMetas.length !== 1) || (pubMetas.length && pubMetas[0].content.replaceAll("/", "-").replace(" ", "T") + (pubMetas[0].content.length === 16 ? ":00" : "") + "+08:00" !== clocks[0])) return null;
  // A visibly modified article cannot borrow its original creation clock.
  if (document.querySelector('meta[name="dateModified"],meta[property="article:modified_time"]') || clockNodes.some(node => /更新时间|修改时间|修订时间/u.test(node.textContent))) return null;
  const pathDate = /\/t(\d{4})(\d{2})(\d{2})_/u.exec(new URL(source).pathname);
  if (date !== `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`) return null;
  const bodies = [...document.querySelectorAll(".detail-text-content > .txt-content, .mobile-content > .mobile-news-content, .center_xilan > .xilan_con")];
  if (!bodies.length || bodies.length > 2) return null;
  const records = bodies.map(node => {
    const clone = node.cloneNode(true); clone.querySelectorAll("script,style,noscript,svg").forEach(item => item.remove());
    const paragraphs = [...clone.querySelectorAll("p")].filter(item => !item.closest("table")).map(item => clean(item.textContent)).filter(Boolean);
    const tables = [...clone.querySelectorAll("table")].map(table => [...table.rows].map(row => [...row.cells].map(cell => compact(cell.textContent))));
    return { paragraphs, tables };
  });
  if (records.length === 2 && JSON.stringify(records[0]) !== JSON.stringify(records[1])) return null;
  if (records[0].paragraphs.join("").length < 80) return null;
  const observationPeriod = period(Number(titleMatch[1]), Number(titleMatch[2]));
  if (![date.slice(0, 7), previousPeriod(date.slice(0, 7))].includes(observationPeriod)) return null;
  return { version: CHINA_PMI_RELEASE_VERSION, title, period: observationPeriod, publicationDate: date, publishedAt: new Date(instant).toISOString(), interpretation, ...records[0] };
}

const TABLES = [
  { key: "manufacturing", header: ["PMI", "生产", "新订单", "原材料库存", "从业人员", "供应商配送时间"], fields: ["pmi", "production", "newOrders", "rawMaterialInventory", "employment", "supplierDeliveryTime"] },
  { key: "manufacturingOther", header: ["新出口订单", "进口", "采购量", "主要原材料购进价格", "出厂价格", "产成品库存", "在手订单", "生产经营活动预期"], fields: ["newExportOrders", "imports", "purchases", "inputPrices", "outputPrices", "finishedGoodsInventory", "backlog", "expectations"] },
  { key: "nonManufacturing", header: ["商务活动", "新订单", "投入品价格", "销售价格", "从业人员", "业务活动预期"], fields: ["activity", "newOrders", "inputPrices", "outputPrices", "employment", "expectations"] },
  { key: "nonManufacturingOther", header: ["新出口订单", "在手订单", "存货", "供应商配送时间"], fields: ["newExportOrders", "backlog", "inventory", "supplierDeliveryTime"] },
];

function parseTable(rows, config, currentPeriod) {
  const firstData = rows.findIndex(row => /^(20\d{2})年([1-9]|1[0-2])月$/u.test(row[0] ?? ""));
  if (firstData < 2 || compact(rows[0].join("")) !== "单位:%" || JSON.stringify(rows.slice(1, firstData).flat().filter(Boolean)) !== JSON.stringify(config.header)) throw new Error(`PMI ${config.key} 表头或单位不符`);
  const data = rows.slice(firstData).map(row => {
    const match = /^(20\d{2})年([1-9]|1[0-2])月$/u.exec(row[0] ?? "");
    if (!match || row.length !== config.fields.length + 1 || row.slice(1).some(value => !/^\d{1,3}\.\d$/u.test(value) || Number(value) > 100)) throw new Error(`PMI ${config.key} 表格行或扩散指数值无效`);
    return { period: period(Number(match[1]), Number(match[2])), ...Object.fromEntries(config.fields.map((field, index) => [field, Number(row[index + 1])])) };
  });
  if (data.length < 2 || data.length > 24 || data.at(-1).period !== currentPeriod || data.some((row, index) => index > 0 && previousPeriod(row.period) !== data[index - 1].period)) throw new Error("PMI 月份缺失、重复、乱序或与标题不符");
  const current = data.at(-1), previous = data.at(-2);
  return Object.fromEntries(config.fields.map(field => [field, { actual: current[field], previous: previous[field], changePercentagePoints: round(current[field] - previous[field]), relativeTo50: current[field] > 50 ? "above" : current[field] < 50 ? "below" : "at", unit: "diffusion_index_percent", baselineBasis: "previous_month_in_same_release_table" }]));
}

export function deriveChinaPmiContext(release, interpretation = null) {
  if (!release || release.interpretation || release.tables.length !== 4 || (interpretation && (!interpretation.interpretation || interpretation.period !== release.period || interpretation.publicationDate !== release.publicationDate))) throw new Error("PMI 正文、四张数据表或解读月份不符");
  const groups = Object.fromEntries(TABLES.map((config, index) => [config.key, parseTable(release.tables[index], config, release.period)]));
  const prose = compact(release.paragraphs.join(""));
  for (const term of ["扩散指数", "回答不变的百分比的一半", "供应商配送时间指数为逆指数", "季节调整后的数据", "PMI高于50%", "低于50%", "权数为30%", "权数为25%", "权数为20%", "权数为15%", "权数为10%", "占GDP的比重"]) if (!prose.includes(term)) throw new Error(`PMI 原文未确认指标定义：${term}`);
  // Cross-check all narrated table-backed monthly changes. A changed table
  // must never coexist with an unchanged narrative without rejection.
  const regions = [prose.split("一、中国制造业采购经理指数运行情况")[1]?.split("表1")[0], prose.split("二、中国非制造业采购经理指数运行情况")[1]?.split("表3")[0]];
  const labels = [["制造业采购经理指数（PMI）", "pmi"], ["生产指数", "production"], ["新订单指数", "newOrders"], ["原材料库存指数", "rawMaterialInventory"], ["从业人员指数", "employment"], ["供应商配送时间指数", "supplierDeliveryTime"]];
  for (const [regionIndex, entries] of [[0, labels], [1, [["非制造业商务活动指数", "activity"], ["新订单指数", "newOrders"], ["投入品价格指数", "inputPrices"], ["销售价格指数", "outputPrices"], ["从业人员指数", "employment"], ["业务活动预期指数", "expectations"]]]]) {
    for (const [label, field] of entries) {
      const escaped = compact(label).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = new RegExp(`${escaped}为(\\d+\\.\\d)%[，,](?:比上月(上升|下降)(\\d+\\.\\d)个百分点|与上月持平)`, "u").exec(regions[regionIndex] ?? "");
      const metric = groups[regionIndex === 0 ? "manufacturing" : "nonManufacturing"][field];
      const delta = match?.[2] ? Number(match[3]) * (match[2] === "上升" ? 1 : -1) : 0;
      if (!match || Number(match[1]) !== metric.actual || Math.abs(delta - metric.changePercentagePoints) > 1e-6) throw new Error(`PMI 表格与${label}原文当值或环比不一致`);
    }
  }
  const composite = /综合PMI产出指数为(\d+\.\d)%[，,]比上月(上升|下降)(\d+\.\d)个百分点/u.exec(prose);
  if (!composite) throw new Error("PMI 综合产出当值和环比缺失");
  const delta = Number(composite[3]) * (composite[2] === "上升" ? 1 : -1);
  const compositeOutput = { actual: Number(composite[1]), previous: round(Number(composite[1]) - delta), changePercentagePoints: delta, unit: "diffusion_index_percent", baselineBasis: "derived_from_narrated_monthly_change" };
  if ([compositeOutput.actual, compositeOutput.previous].some(value => value < 0 || value > 100)) throw new Error("PMI 综合产出范围无效");
  if (interpretation) {
    const interpreted = compact(interpretation.paragraphs.join(""));
    const headline = /制造业采购经理指数、非制造业商务活动指数和综合PMI产出指数分别为(\d+\.\d)%、(\d+\.\d)%和(\d+\.\d)%[，,]比上月(上升|下降)(\d+\.\d)个、(\d+\.\d)个和(\d+\.\d)个百分点/u.exec(interpreted);
    const metrics = [groups.manufacturing.pmi, groups.nonManufacturing.activity, compositeOutput];
    if (!headline || metrics.some((metric, index) => Number(headline[index + 1]) !== metric.actual || Math.abs(Number(headline[index + 5]) * (headline[4] === "上升" ? 1 : -1) - metric.changePercentagePoints) > 1e-6)) throw new Error("PMI 官方解读与发布表格的当值或环比不一致，或解读格式尚未核验");
  }
  return {
    authority: "国家统计局服务业调查中心、中国物流与采购联合会", period: release.period, previousPeriod: previousPeriod(release.period), publishedAt: release.publishedAt,
    groups, compositeOutput, seasonalAdjustment: "seasonally_adjusted", threshold: 50,
    releasePassages: release.paragraphs.filter(value => /(?:指数|行业)/u.test(value) && !/附注|计算方法|调查方法|调查范围|主要指标解释|分类指数采用|5个扩散指数|GDP的比重|受季节因素/u.test(value) && value.length >= 24 && value.length <= 700),
    interpretationPassages: interpretation?.paragraphs.filter(value => value.length >= 24 && value.length <= 700) ?? [],
    limitations: ["Monthly seasonally adjusted survey diffusion indices measure response breadth, not the percentage change in GDP, sales, output, commodity prices or earnings.", "A value below 50 can improve month on month while remaining below the expansion threshold. Supplier delivery time is inverted when constructing manufacturing PMI; a higher printed component is not universally favorable.", "The PMI survey's industries are not CSI equity sector indices or individual listed companies. Do not infer their exposure, daily price reaction, consensus surprise, exact causal contribution or an intraday range from this release.", "Table components are rounded; do not reconstruct exact headline weights or a composite-output weight not disclosed by this release. A prior composite value derived from its stated monthly change is distinguished from a printed table value.", "Release and official interpretation share one authority origin. Survey scope statements retain their own original definitions; they are not independent corroborations."],
  };
}

export function chinaPmiSurveyDefinition(record) {
  if (!record) return null;
  if (!record.interpretation) deriveChinaPmiContext(record);
  return { version: CHINA_PMI_EVIDENCE_VERSION, authority: "国家统计局", period: record.period, measure: "monthly_survey_diffusion_index", seasonalAdjustment: "seasonally_adjusted", threshold: 50, limitation: "Monthly survey breadth is not realized output, revenue or price growth, an equity-index exposure, a consensus surprise or a causal price reaction. Release and interpretation share the same authority origin." };
}
