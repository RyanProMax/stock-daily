import { backgroundEvidenceInWindow, isCalendarDate } from "./evidence-timing.mjs";

export const CNINFO_REGISTRY_URL = "https://www.cninfo.com.cn/new/data/szse_stock.json";
export const CNINFO_HISTORY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query";
const CATEGORY = "category_ndbg_szsh;category_bndbg_szsh;category_yjdbg_szsh;category_sjdbg_szsh;";
const fields = ["stock", "tabName", "pageSize", "pageNum", "column", "category", "plate", "seDate", "searchkey", "secid", "sortName", "sortType", "isHLtitle"];
const day = timestamp => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export function cninfoExchange(symbol) {
  if (/^(?:000|001|002|003|300|301)\d{3}\.SZ$/u.test(symbol)) return { column: "szse", plate: "sz" };
  if (/^(?:600|601|603|605|688|689)\d{3}\.SS$/u.test(symbol)) return { column: "sse", plate: "sh" };
  throw new Error("巨潮公司代码与交易所不一致");
}

// The reviewed native stock page uses a form POST for this read-only history.
// No arbitrary endpoint, form field, search term or mutation is permitted.
export function validateCninfoHistoryBody(body) {
  if (typeof body !== "string" || body.length > 1024) throw new Error("巨潮披露查询表单无效");
  const p = new URLSearchParams(body);
  if ([...p.keys()].length !== fields.length || fields.some(field => p.getAll(field).length !== 1) || [...p.keys()].some(field => !fields.includes(field))) throw new Error("巨潮披露查询字段无效");
  const stock = /^(\d{6}),([A-Za-z0-9]{3,40})$/u.exec(p.get("stock"));
  if (!stock) throw new Error("巨潮披露查询缺少唯一证券及机构身份");
  const exchange = cninfoExchange(`${stock[1]}.${p.get("column") === "szse" ? "SZ" : "SS"}`);
  const dates = p.get("seDate").split("~");
  if (dates.length !== 2 || dates.some(date => !isCalendarDate(date)) || dates[0] > dates[1] || Date.parse(dates[1]) - Date.parse(dates[0]) > 400 * 86_400_000) throw new Error("巨潮披露查询日期范围无效");
  const expected = { tabName: "fulltext", pageSize: "30", pageNum: "1", column: exchange.column, category: CATEGORY, plate: exchange.plate, searchkey: "", secid: "", sortName: "time", sortType: "desc", isHLtitle: "true" };
  if (Object.entries(expected).some(([field, value]) => p.get(field) !== value)) throw new Error("巨潮披露查询不是已验证的完整定期报告请求");
  return body;
}

export function cninfoHistoryBody(entity, envelope) {
  if (envelope.market !== "CN" || !Number.isFinite(Date.parse(envelope.session.windowStart))) throw new Error("巨潮披露查询缺少中国市场交易窗口");
  const exchange = cninfoExchange(entity.symbol), start = Date.parse(envelope.session.windowStart);
  const body = new URLSearchParams({ stock: `${entity.symbol.slice(0, 6)},${entity.orgId}`, tabName: "fulltext", pageSize: "30", pageNum: "1", ...exchange, category: CATEGORY, seDate: `${day(start - 400 * 86_400_000)}~${day(start - 86_400_000)}`, searchkey: "", secid: "", sortName: "time", sortType: "desc", isHLtitle: "true" }).toString();
  return validateCninfoHistoryBody(body);
}

export function cninfoRegistryIdentity(value, symbol) {
  cninfoExchange(symbol);
  if (!Array.isArray(value?.stockList) || value.stockList.length > 20_000) throw new Error("巨潮原始公司名录无效");
  const rows = value.stockList.filter(item => item.code === symbol.slice(0, 6) && item.category === "A股");
  if (rows.length !== 1 || !/^[A-Za-z0-9]{3,40}$/u.test(rows[0].orgId ?? "") || typeof rows[0].zwjc !== "string" || rows[0].zwjc.length < 2 || rows[0].zwjc.length > 30) throw new Error("巨潮原始名录未唯一确认公司及机构身份");
  return { symbol, code: rows[0].code, orgId: rows[0].orgId, name: rows[0].zwjc };
}

export function cninfoLatestPeriodic(value, entity, envelope) {
  // One complete bounded native page is sufficient for ordinary periodic
  // filings. A truncated history is a gap, never proof that an old file is latest.
  if (!Array.isArray(value?.announcements) || value.announcements.length > 30 || value.hasMore !== false || !Number.isInteger(value.totalAnnouncement) || value.totalAnnouncement !== value.announcements.length || value.totalRecordNum !== value.totalAnnouncement) throw new Error("巨潮定期披露列表不完整或超过单页边界");
  const seen = new Set(), candidates = [], range = new URLSearchParams(cninfoHistoryBody(entity, envelope)).get("seDate").split("~");
  for (const a of value.announcements) {
    if (a.secCode !== entity.code || a.orgId !== entity.orgId || !/^[^<>]{2,30}$/u.test(a.secName ?? "") || !/^\d{10}$/u.test(a.announcementId ?? "") || seen.has(a.announcementId) || !Number.isSafeInteger(a.announcementTime)) throw new Error("巨潮披露记录的发行主体、日期或唯一身份无效");
    seen.add(a.announcementId);
    const date = day(a.announcementTime);
    if (date < range[0] || date > range[1]) throw new Error("巨潮披露记录超出原始查询日期范围");
    const normalizedTitle = String(a.announcementTitle ?? "").normalize("NFKC").replace(/\s+/gu, "");
    if (/摘要|公告|提示/u.test(normalizedTitle)) continue;
    const period = /^(?:[^<>]{2,70}[:：]?)?(20\d{2})年(年度|半年度|第?一季度|第?三季度)报告(?:\((?:更新|修订|更正)(?:版|稿|后)?\))?$/u.exec(normalizedTitle);
    if (!period) {
      if (/20\d{2}年(?:年度|半年度|第?一季度|第?三季度)报告/u.test(normalizedTitle)) throw new Error("巨潮完整定期报告标题存在未支持格式，不能回退到较旧报告");
      continue;
    }
    const periodEnd = `${period[1]}-${period[2] === "年度" ? "12-31" : period[2] === "半年度" ? "06-30" : period[2].includes("一") ? "03-31" : "09-30"}`;
    if (date <= periodEnd) throw new Error("巨潮报告的披露日期没有晚于相应报告期末");
    if (a.adjunctType !== "PDF" || a.adjunctUrl !== `finalpage/${date}/${a.announcementId}.PDF` || !backgroundEvidenceInWindow(date, envelope)) continue;
    // A literal issuer prefix, when present, must be this record's own name.
    const title = normalizedTitle.replace(/\((?:更新|修订|更正)(?:版|稿|后)?\)$/u, "");
    const prefix = title.slice(0, title.search(/20\d{2}年/u));
    if (prefix && prefix.replace(/[:：]$/u, "") !== a.secName && !/^[^<>]{3,70}(?:股份)?有限公司[:：]?$/u.test(prefix)) throw new Error("巨潮完整报告标题的发行人前缀不符");
    candidates.push({ symbol: entity.symbol, orgId: entity.orgId, name: a.secName, announcementId: a.announcementId, title: a.announcementTitle, publishedAt: date, url: `https://static.cninfo.com.cn/${a.adjunctUrl}` });
  }
  candidates.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.announcementId.localeCompare(a.announcementId));
  return candidates[0] ?? null;
}
