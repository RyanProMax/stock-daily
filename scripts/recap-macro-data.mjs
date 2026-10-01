import { JSDOM } from "jsdom";
import { stableHash } from "./daily-workflow-core.mjs";
import { readExternalSource } from "./daily-source-audit.mjs";
import { collectRecapChinaPmiData, validateRecapChinaPmiData } from "./recap-china-pmi-data.mjs";

const ATOM = "http://www.w3.org/2005/Atom";
const DATA = "http://schemas.microsoft.com/ado/2007/08/dataservices";
const META = "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata";
const HOST = "home.treasury.gov";
const PATH = "/resource-center/data-chart-center/interest-rates/pages/xml";
const SERIES = "daily_treasury_yield_curve";
const TERMS = { twoYear: "BC_2YEAR", tenYear: "BC_10YEAR", thirtyYear: "BC_30YEAR" };
const round = value => Number(value.toFixed(6));

export function treasuryDataUrl(year) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error("财政部数据年份无效");
  return `https://${HOST}${PATH}?data=${SERIES}&field_tdr_date_value=${year}`;
}

function one(parent, namespace, name) {
  const nodes = Array.from(parent.children).filter(node => node.namespaceURI === namespace && node.localName === name);
  if (nodes.length !== 1) throw new Error(`财政部原文缺少或重复 ${name}`);
  return nodes[0];
}

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("财政部观测日期无效");
  return value;
}

export function parseTreasurySnapshot(snapshot, envelope) {
  const url = new URL(snapshot.url);
  const year = Number(url.searchParams.get("field_tdr_date_value"));
  const currentYear = Number(envelope.marketAsOf.slice(0, 4));
  if (![currentYear, ...(envelope.marketAsOf.slice(5, 7) === "01" ? [currentYear - 1] : [])].includes(year) || url.href !== treasuryDataUrl(year) || snapshot.finalUrl !== url.href || snapshot.payloadHash !== stableHash(snapshot.xml)) throw new Error("财政部数据来源或原文哈希不一致");
  if (typeof snapshot.xml !== "string" || /<!DOCTYPE|<!ENTITY/iu.test(snapshot.xml)) throw new Error("财政部 XML 不能包含实体声明");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(snapshot.fetchedAt) || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || Date.parse(snapshot.fetchedAt) < Date.parse(envelope.session.windowEnd)) throw new Error("财政部数据采集时间无效或尚未收盘");
  let document;
  try { document = new JSDOM(snapshot.xml, { contentType: "text/xml" }).window.document; }
  catch { throw new Error("财政部 XML 语法无效"); }
  const feed = document.documentElement;
  if (feed.namespaceURI !== ATOM || feed.localName !== "feed" || one(feed, ATOM, "title").textContent.trim() !== "DailyTreasuryYieldCurveRateData") throw new Error("财政部数据不是指定收益率序列");
  const updated = one(feed, ATOM, "updated").textContent.trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(updated) || !Number.isFinite(Date.parse(updated)) || Date.parse(updated) > Date.parse(snapshot.fetchedAt)) throw new Error("财政部数据修订时间无效或在采集之后");
  const rows = Array.from(feed.children).filter(node => node.namespaceURI === ATOM && node.localName === "entry").map(entry => {
    const properties = one(one(entry, ATOM, "content"), META, "properties");
    const rawDate = one(properties, DATA, "NEW_DATE").textContent.trim();
    if (!/^\d{4}-\d{2}-\d{2}T00:00:00$/u.test(rawDate)) throw new Error("财政部日线日期格式无效");
    const date = dateOnly(rawDate.slice(0, 10));
    if (Number(date.slice(0, 4)) !== year) throw new Error("财政部观测年份与请求不一致");
    const values = Object.fromEntries(Object.entries(TERMS).map(([term, field]) => {
      const node = one(properties, DATA, field), text = node.textContent.trim();
      if (node.getAttributeNS(META, "null") === "true" || !/^-?\d+(?:\.\d+)?$/u.test(text) || !Number.isFinite(Number(text)) || Number(text) < -10 || Number(text) > 100) throw new Error(`财政部 ${field} 数据缺失或无效`);
      return [term, Number(text)];
    }));
    return { date, ...values };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length || new Set(rows.map(row => row.date)).size !== rows.length) throw new Error("财政部数据为空或日期重复");
  return { rows, updated };
}

function derive(book, envelope) {
  const parsed = book.snapshots.map(snapshot => parseTreasurySnapshot(snapshot, envelope));
  const rows = parsed.flatMap(item => item.rows).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(rows.map(row => row.date)).size !== rows.length) throw new Error("财政部跨年度日期重复");
  // A US rate measured late in New York on the China trading date was not
  // available before China's close. Never use that future session in CN.
  const usable = rows.filter(row => envelope.market === "US" ? row.date <= envelope.marketAsOf : row.date < envelope.marketAsOf);
  const current = usable.at(-1), previous = usable.at(-2);
  if (!current || !previous || (envelope.market === "US" && (current.date !== envelope.marketAsOf || previous.date !== envelope.session.previousAsOf))) throw new Error("财政部当期或前一交易日缺失，不得前向填充");
  if ((Date.parse(envelope.marketAsOf) - Date.parse(current.date)) / 86_400_000 > 7) throw new Error("财政部最新可用观测过旧");
  return {
    series: SERIES, authority: "U.S. Department of the Treasury",
    dataDate: current.date, previousDataDate: previous.date,
    rates: Object.fromEntries(Object.keys(TERMS).map(term => [term, {
      actualPercent: current[term], previousPercent: previous[term],
      changeBasisPoints: round((current[term] - previous[term]) * 100),
      display: `${current[term].toFixed(2)}%`, previousDisplay: `${previous[term].toFixed(2)}%`,
      changeDisplay: `${round((current[term] - previous[term]) * 100).toFixed(2)} 基点 (basis points)`,
    }])),
    tenMinusTwoBasisPoints: round((current.tenYear - current.twoYear) * 100),
    tenMinusTwoChangeBasisPoints: round(((current.tenYear - current.twoYear) - (previous.tenYear - previous.twoYear)) * 100),
    source: `https://${HOST}/resource-center/data-chart-center/interest-rates/TextView?type=${SERIES}&field_tdr_date_value=${current.date.slice(0, 4)}`,
    originalSource: treasuryDataUrl(Number(current.date.slice(0, 4))),
    observedRevisionTimes: parsed.map(item => item.updated),
    limitations: [
      "These are interpolated par yields based on indicative bid quotations near 3:30 p.m. New York time, not actual transaction prices or a named on-the-run bond's intraday quote.",
      "The observation date is not an article publication timestamp. Feed update times describe this retrieved revision; historical publication vintages are not established.",
      "Rate movements measure a possible common factor, not the cause or exact contribution of an equity sector's return. Verify the target-specific transmission and competing forces separately.",
      ...(envelope.market === "CN" ? ["Use the last US observation before the China session date; it is external context, not evidence of a same-day Chinese policy change."] : []),
    ],
  };
}

export function validateRecapMacroData(book, envelope) {
  if (book.market !== envelope.market || book.marketAsOf !== envelope.marketAsOf || !Array.isArray(book.snapshots) || !Array.isArray(book.gaps) || book.snapshots.length > 2 || new Set(book.snapshots.map(item => item.url)).size !== book.snapshots.length) throw new Error("复盘宏观数据日期或结构无效");
  if (book.gaps.length) {
    if (book.gaps.length !== 1 || book.gaps[0].series !== SERIES || book.context !== null || typeof book.gaps[0].reason !== "string" || !book.gaps[0].reason) throw new Error("复盘宏观缺口记录无效");
    book.snapshots.forEach(snapshot => parseTreasurySnapshot(snapshot, envelope));
  } else if (stableHash(book.context) !== stableHash(derive(book, envelope))) throw new Error("复盘宏观数据派生值被修改");
  if (envelope.market === "CN") validateRecapChinaPmiData(book.chinaPmi, envelope);
  else if (book.chinaPmi != null) throw new Error("美国市场不能套用中国 PMI 输入");
  return book;
}

export async function collectRecapMacroData(envelope, { reader = readExternalSource, now = () => new Date(), signal } = {}) {
  const book = { market: envelope.market, marketAsOf: envelope.marketAsOf, snapshots: [], context: null, gaps: [] };
  const year = Number(envelope.marketAsOf.slice(0, 4));
  const years = [year];
  if (envelope.marketAsOf.slice(5, 7) === "01") years.unshift(year - 1);
  try {
    for (const year of years) {
      const url = treasuryDataUrl(year);
      const response = await reader(url, { structured: true, signal: signal ?? AbortSignal.timeout(45_000) });
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(response.rawBody);
      book.snapshots.push({ url, finalUrl: response.finalUrl, xml, payloadHash: stableHash(xml), fetchedAt: now().toISOString() });
      parseTreasurySnapshot(book.snapshots.at(-1), envelope);
    }
    book.context = derive(book, envelope);
  } catch (error) {
    // Invalid fetched data must not masquerade as verified partial snapshots.
    book.snapshots = book.snapshots.filter(snapshot => { try { parseTreasurySnapshot(snapshot, envelope); return true; } catch { return false; } });
    book.gaps.push({ series: SERIES, reason: String(error.message).slice(0, 300) });
  }
  if (envelope.market === "CN") book.chinaPmi = await collectRecapChinaPmiData(envelope, { reader, now, signal: signal ?? AbortSignal.timeout(90_000) });
  return validateRecapMacroData(book, envelope);
}
