const FIRST_PARTY_HOSTS = new Set([
  "bea.gov",
  "bls.gov",
  "commerce.gov",
  "eia.gov",
  "federalreserve.gov",
  "gov.cn",
  "pbc.gov.cn",
  "sec.gov",
  "sse.com.cn",
  "stats.gov.cn",
  "szse.cn",
]);

const FIRST_PARTY_LABELS =
  /国家统计局|中国人民银行|国务院|商务部|财政部|国家发展改革委|Federal Reserve|Bureau of (?:Economic Analysis|Labor Statistics)|Securities and Exchange Commission|Energy Information Administration|Department of Commerce/i;

const WIRE_LABELS =
  /Reuters|Associated Press|\bAP\b|Bloomberg|新华社|中新社/i;

const LISTED_ENTITY_ALIASES = Object.freeze([
  {
    name: "海亮股份",
    nameEn: "Zhejiang Hailiang",
    ticker: "002203",
    exchange: "SZSE",
    pattern: /海亮股份|Zhejiang Hailiang/i,
  },
  {
    name: "永鼎股份",
    nameEn: "Jiangsu Etern",
    ticker: "600105",
    exchange: "SSE",
    pattern: /永鼎股份|Jiangsu Etern/i,
  },
  {
    name: "宝洁",
    nameEn: "Procter & Gamble",
    ticker: "PG",
    exchange: "NYSE",
    pattern: /宝洁|Procter\s*&\s*Gamble|\bP&G\b/i,
  },
  {
    name: "格罗方德",
    nameEn: "GlobalFoundries",
    ticker: "GFS",
    exchange: "NASDAQ",
    pattern: /格罗方德|\bGlobalFoundries\b/i,
  },
  {
    name: "新东方",
    nameEn: "New Oriental Education",
    ticker: "EDU",
    exchange: "NYSE",
    pattern: /新东方|\bNew Oriental(?: Education)?\b/i,
  },
  {
    name: "苹果",
    nameEn: "Apple",
    ticker: "AAPL",
    exchange: "NASDAQ",
    pattern: /\bApple\b|苹果公司/i,
  },
  {
    name: "亚马逊",
    nameEn: "Amazon",
    ticker: "AMZN",
    exchange: "NASDAQ",
    pattern: /\bAmazon\b|亚马逊/i,
  },
  {
    name: "阿里巴巴",
    nameEn: "Alibaba",
    ticker: "BABA",
    exchange: "NYSE",
    pattern: /\bAlibaba\b|\bAliExpress\b|阿里巴巴|全球速卖通/i,
  },
  {
    name: "谷歌",
    nameEn: "Alphabet",
    ticker: "GOOGL",
    exchange: "NASDAQ",
    pattern: /\bGoogle\b|\bAlphabet\b|谷歌/i,
  },
  {
    name: "Meta",
    nameEn: "Meta",
    ticker: "META",
    exchange: "NASDAQ",
    pattern: /\bMeta\b|\bFacebook\b|脸书/i,
  },
  {
    name: "微软",
    nameEn: "Microsoft",
    ticker: "MSFT",
    exchange: "NASDAQ",
    pattern: /\bMicrosoft\b|微软/i,
  },
  {
    name: "英伟达",
    nameEn: "Nvidia",
    ticker: "NVDA",
    exchange: "NASDAQ",
    pattern: /\bNvidia\b|英伟达/i,
  },
  {
    name: "特斯拉",
    nameEn: "Tesla",
    ticker: "TSLA",
    exchange: "NASDAQ",
    pattern: /\bTesla\b|特斯拉/i,
  },
]);

const SOURCE_POINTS = {
  first_party: 16,
  wire: 10,
  secondary: 4,
};

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function registrableHost(url) {
  const host = hostname(url);
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

function normalizeInternalTier(tier) {
  if (tier === "official") return "first_party";
  if (tier === "wire") return "wire";
  if (tier === "publisher") return "secondary";
  return undefined;
}

export function classifySourceTier(item) {
  const normalized = normalizeInternalTier(item.sourceTier ?? item._tier);
  if (normalized) return normalized;
  const host = registrableHost(item.canonicalSource ?? item.url);
  if (
    [...FIRST_PARTY_HOSTS].some(
      (candidate) => host === candidate || host.endsWith(`.${candidate}`),
    ) ||
    FIRST_PARTY_LABELS.test(String(item.source ?? ""))
  ) {
    return "first_party";
  }
  if (WIRE_LABELS.test(String(item.source ?? ""))) return "wire";
  return "secondary";
}

export function evidenceSourceFor(item) {
  return {
    url: item.canonicalSource ?? item.url,
    label: item.canonicalSourceLabel ?? item.source,
    tier: classifySourceTier(item),
    ...(item.publishedAt ? { observedAt: item.publishedAt } : {}),
  };
}

function exchangeFromSuffix(suffix) {
  return {
    SH: "SSE",
    SZ: "SZSE",
    BJ: "BSE",
  }[suffix];
}

export function resolveListedEntities(value) {
  const text = String(value ?? "");
  const entities = new Map();
  for (const alias of LISTED_ENTITY_ALIASES) {
    if (alias.pattern.test(text)) {
      entities.set(`${alias.exchange}:${alias.ticker}`, {
        name: alias.name,
        nameEn: alias.nameEn,
        ticker: alias.ticker,
        exchange: alias.exchange,
      });
    }
  }

  const chineseTickerPattern =
    /([\p{Script=Han}A-Za-z&·]{2,24})[\s（(]+(\d{6})\.(SH|SZ|BJ)[）)]/gu;
  for (const match of text.matchAll(chineseTickerPattern)) {
    const [, rawName, ticker, suffix] = match;
    const exchange = exchangeFromSuffix(suffix);
    const name = rawName
      .replace(/(?:公告称|表示|称|公司)$/u, "")
      .replace(/^.*[，。；:：]/u, "")
      .trim()
      .slice(-12);
    entities.set(`${exchange}:${ticker}`, {
      name: name || ticker,
      ticker,
      exchange,
    });
  }

  const qualifiedTickerPattern =
    /\b(NYSE|NASDAQ|AMEX|SSE|SZSE|BSE)[:：]\s*([A-Z0-9.-]{1,8})\b/gu;
  for (const match of text.matchAll(qualifiedTickerPattern)) {
    const [, exchange, ticker] = match;
    entities.set(`${exchange}:${ticker}`, {
      name: ticker,
      ticker,
      exchange,
    });
  }
  return [...entities.values()];
}

function finiteNumber(value) {
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : undefined;
}

function rounded(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function metric({
  id,
  label,
  labelEn,
  actual,
  expected,
  prior,
  unit,
  source,
}) {
  const result = {
    id,
    label,
    labelEn,
    actual,
    expected,
    prior,
    unit,
    source,
  };
  if (Number.isFinite(actual) && Number.isFinite(expected)) {
    result.surprise = rounded(actual - expected);
    result.surpriseUnit = unit === "%" ? "pp" : unit;
  }
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  );
}

export function extractSignalMetrics(item) {
  const text = `${item.title ?? ""} ${item.facts ?? ""}`;
  const source = evidenceSourceFor(item);
  const metrics = [];
  const seen = new Set();
  const add = (entry) => {
    if (!seen.has(entry.id)) {
      metrics.push(entry);
      seen.add(entry.id);
    }
  };

  const revenue = text.match(
    /销售净额\s*([\d,.]+)\s*亿美元[，,]\s*预估\s*([\d,.]+)\s*亿美元/u,
  );
  if (revenue) {
    add(
      metric({
        id: "revenue",
        label: "销售净额",
        labelEn: "Net sales",
        actual: finiteNumber(revenue[1]),
        expected: finiteNumber(revenue[2]),
        unit: "亿美元",
        source,
      }),
    );
  }

  const organicGrowth = text.match(
    /内生性收入增长\s*([+-]?[\d,.]+)\s*[％%][，,]\s*预估增长\s*([+-]?[\d,.]+)\s*[％%]/u,
  );
  if (organicGrowth) {
    add(
      metric({
        id: "organic-growth",
        label: "内生性收入增长",
        labelEn: "Organic sales growth",
        actual: finiteNumber(organicGrowth[1]),
        expected: finiteNumber(organicGrowth[2]),
        unit: "%",
        source,
      }),
    );
  }

  const eps = text.match(
    /核心每股收益\s*([\d,.]+)\s*美元[，,]\s*预估\s*([\d,.]+)\s*美元/u,
  );
  if (eps) {
    add(
      metric({
        id: "core-eps",
        label: "核心每股收益",
        labelEn: "Core EPS",
        actual: finiteNumber(eps[1]),
        expected: finiteNumber(eps[2]),
        unit: "美元",
        source,
      }),
    );
  }

  const organicGuidance = text.match(
    /预计\s*(\d{4})年内生性收入增长\s*([\d,.]+)\s*[％%]\s*至\s*([\d,.]+)\s*[％%][，,]\s*预估增长\s*([\d,.]+)\s*[％%]/u,
  );
  if (organicGuidance) {
    const low = finiteNumber(organicGuidance[2]);
    const high = finiteNumber(organicGuidance[3]);
    add(
      metric({
        id: `${organicGuidance[1]}-organic-guidance`,
        label: `${organicGuidance[1]}年内生性收入指引中点`,
        labelEn: `${organicGuidance[1]} organic sales guidance midpoint`,
        actual:
          Number.isFinite(low) && Number.isFinite(high)
            ? rounded((low + high) / 2)
            : undefined,
        expected: finiteNumber(organicGuidance[4]),
        unit: "%",
        source,
      }),
    );
  }

  const epsGuidance = text.match(
    /预计\s*(\d{4})年核心每股收益\s*([\d,.]+)\s*美元\s*至\s*([\d,.]+)\s*美元[，,]\s*市场预估\s*([\d,.]+)\s*美元/u,
  );
  if (epsGuidance) {
    const low = finiteNumber(epsGuidance[2]);
    const high = finiteNumber(epsGuidance[3]);
    add(
      metric({
        id: `${epsGuidance[1]}-eps-guidance`,
        label: `${epsGuidance[1]}年核心每股收益指引中点`,
        labelEn: `${epsGuidance[1]} core EPS guidance midpoint`,
        actual:
          Number.isFinite(low) && Number.isFinite(high)
            ? rounded((low + high) / 2)
            : undefined,
        expected: finiteNumber(epsGuidance[4]),
        unit: "美元",
        source,
      }),
    );
  }

  return metrics;
}

function signedChange(direction, value) {
  const normalized = String(value).replace("％", "%");
  return direction === "跌" || direction === "下降" || direction === "fell"
    ? `-${normalized.replace(/^[+-]/, "")}`
    : `+${normalized.replace(/^[+-]/, "")}`;
}

export function extractMarketReactions(item, entities = resolveListedEntities(
  `${item.title ?? ""} ${item.facts ?? ""}`,
)) {
  const text = `${item.title ?? ""} ${item.facts ?? ""}`;
  const source = evidenceSourceFor(item);
  const asOf = item.publishedAt ?? new Date(0).toISOString();
  const reactions = [];
  const seen = new Set();
  const add = (reaction) => {
    const key = `${reaction.instrument}:${reaction.change}:${reaction.window}`;
    if (!seen.has(key)) {
      reactions.push(reaction);
      seen.add(key);
    }
  };

  const premarket = text.match(/美股盘前(涨|跌)\s*([\d.]+\s*[％%])/u);
  if (premarket && entities[0]) {
    add({
      instrument: entities[0].ticker,
      change: signedChange(premarket[1], premarket[2]),
      window: "盘前",
      windowEn: "premarket",
      asOf,
      source,
    });
  }

  const brent = text.match(
    /布伦特原油期货(?:涨幅扩大至|上涨)\s*([\d.]+\s*[％%])/u,
  );
  if (brent) {
    add({
      instrument: "Brent",
      change: signedChange("涨", brent[1]),
      window: "盘中",
      windowEn: "intraday",
      asOf,
      source,
    });
  }

  const europeanGas = text.match(
    /欧洲天然气价格(?:一度)?(上涨|下降)\s*([\d.]+\s*[％%])/u,
  );
  if (europeanGas) {
    add({
      instrument: "欧洲天然气",
      change: signedChange(
        europeanGas[1] === "下降" ? "跌" : "涨",
        europeanGas[2],
      ),
      window: "盘中",
      windowEn: "intraday",
      asOf,
      source,
    });
  }

  for (const [pattern, instrument] of [
    [/\bS&P 500\b[^.]{0,32}\b(lost|fell|rose)\s*([\d.]+%)/i, "S&P 500"],
    [/\bNasdaq Composite\b[^.]{0,32}\b(dropped|fell|rose)\s*([\d.]+%)/i, "NASDAQ"],
    [/\bDow Jones Industrial Average\b[^.]{0,64}\b(fell|rose)\s*(?:by\s*)?([\d.]+%)/i, "DOW"],
  ]) {
    const match = text.match(pattern);
    if (match) {
      add({
        instrument,
        change: signedChange(
          /lost|fell|dropped/i.test(match[1]) ? "fell" : "rose",
          match[2],
        ),
        window: "盘中",
        windowEn: "intraday",
        asOf,
        source,
      });
    }
  }
  return reactions;
}

export function baselineKindFor(metrics) {
  if (metrics.some((item) => item.id.includes("guidance"))) return "guidance";
  if (metrics.some((item) => Number.isFinite(item.expected))) return "consensus";
  if (metrics.some((item) => Number.isFinite(item.prior))) return "prior";
  return "none";
}

function topicKey(value) {
  const text = String(value ?? "").toLocaleLowerCase();
  if (/利率|收益率|fed|federal reserve|treasury|inflation|通胀/u.test(text)) {
    return "rates";
  }
  if (/油价|原油|天然气|brent|oil|opec/u.test(text)) return "energy";
  if (/财报|业绩|销售|营收|利润|eps|earnings|guidance/u.test(text)) {
    return "earnings";
  }
  if (/关税|贸易|出口|进口|tariff|trade|sanction/u.test(text)) {
    return "trade";
  }
  if (/指数|美股|a股|nasdaq|s&p|dow|stock market/u.test(text)) {
    return "equities";
  }
  if (/政策|通知|监管|sec|regulation/u.test(text)) return "policy";
  return `other:${text.replace(/\W/gu, "").slice(0, 24)}`;
}

export function enrichNewsItem(item) {
  const text = `${item.title ?? ""} ${item.facts ?? ""}`;
  const entities = resolveListedEntities(text);
  const metrics = extractSignalMetrics(item);
  const reactions = extractMarketReactions(item, entities);
  return {
    evidenceSource: evidenceSourceFor(item),
    entities,
    metrics,
    reactions,
    baselineKind: baselineKindFor(metrics),
    topic: topicKey(text),
  };
}

function rawSignalScore(news, story, enrichment) {
  return (
    story.importance * 20 +
    SOURCE_POINTS[enrichment.evidenceSource.tier] +
    (enrichment.metrics.length > 0 ? 10 : 0) +
    (enrichment.reactions.length > 0 ? 8 : 0) +
    (enrichment.entities.length > 0 ? 6 : 0) +
    (news.regions.length > 1 ? 4 : 0)
  );
}

export function assignSignalMetadata(newsItems, stories) {
  if (newsItems.length !== stories.length) {
    throw new Error("信号排序要求新闻与解读逐条对应");
  }
  const metadata = newsItems.map((news, index) => {
    const enrichment = enrichNewsItem(news);
    return {
      enrichment,
      score: rawSignalScore(news, stories[index], enrichment),
      rankByMarket: {},
      roleByMarket: {},
    };
  });

  for (const market of ["CN", "US"]) {
    const marketNewsCount = newsItems.filter((item) =>
      item.regions.includes(market),
    ).length;
    if (marketNewsCount === 0) continue;
    const eligible = metadata
      .map((item, index) => ({
        ...item,
        index,
        topic: item.enrichment.topic,
      }))
      .filter(
        ({ index }) =>
          stories[index].importance >= 3 &&
          newsItems[index].regions.includes(market),
      );
    if (eligible.length < 3) {
      throw new Error(`${market} 重要度不低于 3 的信号不足 3 条`);
    }
    const topicLeader = new Map();
    for (const candidate of eligible) {
      const current = topicLeader.get(candidate.topic);
      if (!current || candidate.score > current.score) {
        topicLeader.set(candidate.topic, candidate);
      }
    }
    eligible
      .map((candidate) => ({
        ...candidate,
        adjustedScore:
          topicLeader.get(candidate.topic)?.index === candidate.index
            ? candidate.score
            : candidate.score - 12,
      }))
      .sort(
        (left, right) =>
          right.adjustedScore - left.adjustedScore ||
          right.score - left.score ||
          left.index - right.index,
      )
      .forEach((candidate, rankIndex) => {
        metadata[candidate.index].score = Math.max(
          metadata[candidate.index].score,
          candidate.adjustedScore,
        );
        metadata[candidate.index].rankByMarket[market] = rankIndex + 1;
        metadata[candidate.index].roleByMarket[market] =
          rankIndex < 3 ? "core" : rankIndex < 5 ? "supporting" : "excluded";
      });
  }

  for (const [index, story] of stories.entries()) {
    if (story.importance >= 3) continue;
    for (const market of newsItems[index].regions) {
      metadata[index].roleByMarket[market] = "excluded";
    }
  }
  return metadata;
}

function addDays(date, days) {
  const result = new Date(`${date}T13:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString();
}

export function checkpointDueAt(reportDate, horizon, dueInDays) {
  const day = Number(dueInDays);
  const ranges = {
    intraday: [0, 0],
    "1-5d": [1, 5],
    "1-4w": [6, 28],
  };
  const range = ranges[horizon];
  if (
    !range ||
    !Number.isInteger(day) ||
    day < range[0] ||
    day > range[1]
  ) {
    throw new Error(`checkpoint.dueInDays 与 ${horizon} 时间范围不一致`);
  }
  return addDays(reportDate, day);
}

export function supportedEntityKeys(entities) {
  return new Set(entities.map((entity) => `${entity.exchange}:${entity.ticker}`));
}
