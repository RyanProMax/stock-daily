import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const quoteCache = new Map();

const layerDefinitions = [
  { layer: "chips", name: "芯片与设备", nameEn: "Chips & equipment" },
  { layer: "memory", name: "存储", nameEn: "Memory" },
  {
    layer: "servers",
    name: "服务器与算力设备",
    nameEn: "Servers & compute systems",
  },
  {
    layer: "interconnect",
    name: "CPO / 光互连",
    nameEn: "CPO / optical interconnects",
  },
  {
    layer: "data_center",
    name: "数据中心电力与液冷",
    nameEn: "Data-center power & cooling",
  },
  {
    layer: "cloud",
    name: "云计算 / NeoCloud",
    nameEn: "Cloud / NeoCloud",
  },
  {
    layer: "applications",
    name: "AI 软件与应用",
    nameEn: "AI software & applications",
  },
  { layer: "robotics", name: "机器人", nameEn: "Robotics" },
];

const constituentsByMarket = {
  CN: {
    chips: [
      ["688981.SS", "中芯国际", "SMIC"],
      ["002371.SZ", "北方华创", "NAURA Technology"],
      ["688041.SS", "海光信息", "Hygon Information"],
      ["688256.SS", "寒武纪", "Cambricon"],
    ],
    memory: [
      ["603986.SS", "兆易创新", "GigaDevice"],
      ["301308.SZ", "江波龙", "Longsys"],
      ["300223.SZ", "北京君正", "Ingenic Semiconductor"],
      ["688110.SS", "东芯股份", "Dosilicon"],
    ],
    servers: [
      ["000977.SZ", "浪潮信息", "Inspur Electronic Information"],
      ["603019.SS", "中科曙光", "Sugon"],
      ["601138.SS", "工业富联", "FII"],
      ["000938.SZ", "紫光股份", "Unisplendour"],
    ],
    interconnect: [
      ["300308.SZ", "中际旭创", "InnoLight"],
      ["300502.SZ", "新易盛", "Eoptolink"],
      ["300394.SZ", "天孚通信", "TFC Optical Communication"],
      ["002281.SZ", "光迅科技", "Accelink"],
    ],
    data_center: [
      ["002335.SZ", "科华数据", "Kehua Data"],
      ["300442.SZ", "润泽科技", "Range Technology"],
      ["002837.SZ", "英维克", "Envicool"],
      ["300738.SZ", "奥飞数据", "Aofei Data"],
    ],
    cloud: [
      ["300846.SZ", "首都在线", "Capitalonline Data Service"],
      ["688158.SS", "优刻得", "UCloud"],
      ["600602.SS", "云赛智联", "INESA Intelligent Tech"],
      ["002929.SZ", "润建股份", "Runjian"],
    ],
    applications: [
      ["002230.SZ", "科大讯飞", "iFlytek"],
      ["688111.SS", "金山办公", "Kingsoft Office"],
      ["600588.SS", "用友网络", "Yonyou"],
      ["601360.SS", "三六零", "360 Security Technology"],
    ],
    robotics: [
      ["300124.SZ", "汇川技术", "Inovance"],
      ["688017.SS", "绿的谐波", "Leader Harmonious Drive"],
      ["002747.SZ", "埃斯顿", "Estun Automation"],
      ["002472.SZ", "双环传动", "Shuanghuan Driveline"],
    ],
  },
  US: {
    chips: [
      ["NVDA", "英伟达", "NVIDIA"],
      ["AMD", "AMD", "AMD"],
      ["AVGO", "博通", "Broadcom"],
      ["TSM", "台积电 ADR", "TSMC ADR"],
    ],
    memory: [
      ["MU", "美光", "Micron"],
      ["WDC", "西部数据", "Western Digital"],
      ["STX", "希捷", "Seagate"],
      ["SNDK", "闪迪", "Sandisk"],
    ],
    servers: [
      ["SMCI", "超微电脑", "Super Micro Computer"],
      ["DELL", "戴尔科技", "Dell Technologies"],
      ["HPE", "慧与", "Hewlett Packard Enterprise"],
      ["VRT", "维谛技术", "Vertiv"],
    ],
    interconnect: [
      ["ANET", "Arista Networks", "Arista Networks"],
      ["AVGO", "博通", "Broadcom"],
      ["LITE", "Lumentum", "Lumentum"],
      ["COHR", "Coherent", "Coherent"],
    ],
    data_center: [
      ["VRT", "维谛技术", "Vertiv"],
      ["ETN", "伊顿", "Eaton"],
      ["GEV", "GE Vernova", "GE Vernova"],
      ["PWR", "Quanta Services", "Quanta Services"],
    ],
    cloud: [
      ["CRWV", "CoreWeave", "CoreWeave"],
      ["NBIS", "Nebius", "Nebius"],
      ["IREN", "IREN", "IREN"],
      ["CORZ", "Core Scientific", "Core Scientific"],
    ],
    applications: [
      ["PLTR", "Palantir", "Palantir"],
      ["APP", "AppLovin", "AppLovin"],
      ["SNOW", "Snowflake", "Snowflake"],
      ["CRM", "Salesforce", "Salesforce"],
    ],
    robotics: [
      ["TSLA", "特斯拉", "Tesla"],
      ["ISRG", "直觉外科", "Intuitive Surgical"],
      ["SYM", "Symbotic", "Symbotic"],
      ["TER", "泰瑞达", "Teradyne"],
    ],
  },
};

function directionForChange(change) {
  if (Math.abs(change) < 0.005) return "flat";
  return change > 0 ? "up" : "down";
}

async function fetchJson(url) {
  const result = await execFileAsync(
    "curl",
    [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "20",
      "--retry",
      "2",
      "--retry-delay",
      "1",
      "--retry-all-errors",
      "--header",
      "Accept: application/json, text/plain, */*",
      "--header",
      "Referer: https://finance.yahoo.com/",
      "--user-agent",
      "Mozilla/5.0 StockDaily/1.0",
      url.toString(),
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

async function fetchConstituentUncached([symbol, name, nameEn], cutoffTime) {
  let lastError = "request failed";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = new URL(
      `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    url.searchParams.set(
      "period1",
      String(Math.floor((cutoffTime - 14 * 24 * 60 * 60 * 1_000) / 1_000)),
    );
    url.searchParams.set("period2", String(Math.floor(cutoffTime / 1_000)));
    url.searchParams.set("interval", "1d");
    try {
      const payload = await fetchJson(url);
      const result = payload?.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      const points = timestamps
        .map((timestamp, index) => ({
          timestamp: Number(timestamp) * 1_000,
          close: Number(closes[index]),
        }))
        .filter(
          (point) =>
            Number.isFinite(point.timestamp) &&
            Number.isFinite(point.close) &&
            point.close > 0 &&
            point.timestamp <= cutoffTime,
        )
        .sort((left, right) => left.timestamp - right.timestamp);
      if (points.length < 2) throw new Error("fewer than two closes");
      const previous = points.at(-2);
      const latest = points.at(-1);
      const change = ((latest.close - previous.close) / previous.close) * 100;
      return {
        symbol,
        name,
        nameEn,
        value: latest.close.toFixed(2),
        change: `${change > 0 ? "+" : ""}${change.toFixed(2)}%`,
        changeValue: change,
        direction: directionForChange(change),
        asOf: new Date(latest.timestamp).toISOString().slice(0, 10),
        source: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history`,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
  }
  throw new Error(`${symbol}: ${lastError}`);
}

export function fetchEquityConstituent(constituent, cutoffTime) {
  const key = `${constituent[0]}:${cutoffTime}`;
  if (!quoteCache.has(key)) {
    quoteCache.set(
      key,
      fetchConstituentUncached(constituent, cutoffTime).catch((error) => {
        quoteCache.delete(key);
        throw error;
      }),
    );
  }
  return quoteCache.get(key);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function formatMetric(definition, market, constituents) {
  const dates = [...new Set(constituents.map((item) => item.asOf))];
  if (constituents.length !== 4 || dates.length !== 1) {
    throw new Error(
      `${market} ${definition.layer}: 代表篮子必须有 4 个同交易日成分`,
    );
  }
  const change =
    constituents.reduce((sum, item) => sum + item.changeValue, 0) /
    constituents.length;
  return {
    market,
    ...definition,
    benchmark: "4只代表标的等权篮子",
    benchmarkEn: "Equal-weight basket of 4 representative stocks",
    benchmarkKind: "equal_weight_basket",
    symbol: `AI-${market}-${definition.layer}`,
    change: `${change > 0 ? "+" : ""}${change.toFixed(2)}%`,
    direction: directionForChange(change),
    asOf: dates[0],
    source: "https://finance.yahoo.com/markets/stocks/",
    constituents: constituents.map(({ changeValue: _changeValue, ...item }) => item),
  };
}

export async function collectAiChainPerformance(cutoffTime) {
  if (!Number.isFinite(cutoffTime)) {
    throw new Error("cutoffTime must be a finite timestamp");
  }
  const requests = ["CN", "US"].flatMap((market) =>
    layerDefinitions.flatMap((definition) =>
      constituentsByMarket[market][definition.layer].map((constituent) => ({
        market,
        layer: definition.layer,
        constituent,
      })),
    ),
  );
  const quoted = await mapWithConcurrency(requests, 8, async (request) => ({
    ...request,
    quote: await fetchEquityConstituent(request.constituent, cutoffTime),
  }));
  return ["CN", "US"].flatMap((market) =>
    layerDefinitions.map((definition) =>
      formatMetric(
        definition,
        market,
        quoted
          .filter(
            (item) =>
              item.market === market && item.layer === definition.layer,
          )
          .map((item) => item.quote),
      ),
    ),
  );
}

export const AI_CHAIN_LAYERS = layerDefinitions.map(({ layer }) => layer);
export const AI_CHAIN_LAYER_DEFINITIONS = layerDefinitions;
export const AI_CHAIN_CONSTITUENTS = constituentsByMarket;
