const FACTOR = /\b(?:interest rates?|financing|credit markets?|capital markets?|borrowing|macroeconomic|economic conditions?|customer spending|demand|supply|costs?)\b/iu;
const OWN = /\b(?:we|our|the company)\b/iu;
const QUALIFICATION = /^(?:However|Nevertheless|Nonetheless|Although|While|But|Yet|Despite|In contrast|Conversely|Historical(?:ly)?|There (?:is|can)|(?:We|Our|The company)\b[^.]{0,100}\b(?:hedg\w*|mitigat\w*|fixed[- ]rate|not|no))\b/iu;
const IMPACT = /\b(?:advers\w*|negatively|harm|affect\w*|risk(?![-\s]free\b)|increase\w*[^.]{0,100}\bcosts?|reduc\w*[^.]{0,100}\bdemand)\b/iu;
const ACCOUNTING = /black-scholes|monte carlo|fair value of stock options|valuing (?:stock options|these PSUs)|lease assets represent|commencement date of (?:the )?lease/iu;
const CONTINUATION = /^(?:We (?:are|remain) subject to interest rate risks?|The level of our interest rate risk)\b/iu;
const RATE_QUALIFICATION = /\bno\b[^.]{0,100}\b(?:sensitivity|risk)|\bnot\b[^.]{0,100}\b(?:significant|sensitive)|\bdecreas\w*\b[^.]{0,80}\binterest expense|\bfixed[- ]rate\b/iu;

// Normalize only whitespace; words, numbers and page footers remain original.
// Segment the whole text before selecting quotes so printed line wraps cannot
// create an apparent sentence with its subject or qualifications removed.
export function companyExposureExcerpts(text, { language = "en", issuerName, acceptExcerpt = () => true } = {}) {
  if (language === "zh") return chineseCompanyExposureExcerpts(text, issuerName, acceptExcerpt);
  const original = text.replace(/\s+/gu, " ").trim();
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(original)].map(item => ({ quote: item.segment.trim(), position: item.index }));
  const candidates = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const current = sentences[index];
    if (!FACTOR.test(current.quote)) continue;
    let quote = current.quote, position = current.position;
    // The preceding sentence can identify "these conditions", the business or
    // an issuer-owned channel. Keep it when it fits rather than invent a subject.
    const previous = sentences[index - 1];
    if (previous && quote.length + previous.quote.length + 1 <= 700) {
      quote = `${previous.quote} ${quote}`; position = previous.position;
    }
    let clippedQualification = false;
    for (let next = index + 1; next < sentences.length && (QUALIFICATION.test(sentences[next].quote) || CONTINUATION.test(sentences[next].quote)); next += 1) {
      if (quote.length + sentences[next].quote.length + 1 > 700) { clippedQualification = true; break; }
      quote += ` ${sentences[next].quote}`;
    }
    if (clippedQualification || quote.length < 60 || quote.length > 700 || !/^[\p{Lu}\d“"‘'(•]/u.test(quote) || !/[.!?]$/u.test(quote) || !OWN.test(quote)) continue;
    // An accounting assumption is not a disclosed economic transmission. Keep
    // genuine risk/qualification records, including denials of sensitivity.
    if (ACCOUNTING.test(quote) && !IMPACT.test(quote)) continue;
    const rates = /interest rates?/iu.test(quote), financing = /financing|credit markets?|capital markets?|borrowing/iu.test(quote);
    const priority = rates ? (RATE_QUALIFICATION.test(quote) ? 6 : IMPACT.test(quote) ? 5 : 4) : financing ? (IMPACT.test(quote) ? 4 : 3) : /macroeconomic|economic conditions?/iu.test(quote) ? 2 : 1;
    candidates.push({ quote, priority, position });
  }
  // Overlapping candidates carry the same local disclosure. Select distinct
  // contexts; do not fill all three slots with progressively longer copies.
  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.priority - a.priority || a.position - b.position || b.quote.length - a.quote.length)) {
    if (selected.some(item => item.quote.includes(candidate.quote) || candidate.quote.includes(item.quote) || (candidate.position < item.position + item.quote.length && item.position < candidate.position + candidate.quote.length))) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.sort((a, b) => a.position - b.position).map(item => item.quote);
}

// 金融资产 contains the adjacent characters 融资, and 毛利率 contains 利率;
// neither alone states financing conditions or market interest-rate exposure.
const CN_FACTOR = /需求|供给|供应|成本|(?<!毛)利率|(?<!金)融资|监管|汇率|宏观|竞争/u;
const CN_IMPACT = /影响|波动|风险|压力|敏感|增长|增加|降低|下降|上升|承受|面临|依赖|导致|对冲/u;
const CN_OUTCOME = /订单|交付|营业|业绩|盈利|收入|毛利|净利润|资金|借款|债务|利息|财务|采购|支出|投入|产能|生产|产品|客户|货款|存货|经营|研发|损失|对冲/u;
const CN_BOILERPLATE = /董事会[^。]{0,80}(?:保证|承担)|不存在虚假记载|公司负责人[^。]{0,80}保证|会计政策|公允价值计量|会计估计|会计准则|会计处理|财务报表附注|摊余成本|初始确认|终止确认|融资租赁|重大融资成分|实际利率法|实际利率乘|计算确定利息收入|预期信用损失|估值技术|输入值|坏账准备|减值准备|计量方法|可收回金额|税前折现率|会计科目|单位[:：]|期初余额|期末余额|本期发生额|(?:金融资产|金融负债|金融工具)[^。]{0,180}(?:确认|分类|计量|转移|控制|合同现金流量)|前瞻性陈述|不构成[^。]{0,50}承诺|本人承诺|本人将|公司承诺|承诺事项|承诺书|未履行承诺|履约担保|填补[^。]{0,30}回报|市值管理/u;

function chineseExposureText(text, issuerName) {
  let compact = String(text).replace(/\s+/gu, "");
  if (typeof issuerName === "string" && issuerName.length >= 2) {
    const name = issuerName.replace(/\s+/gu, "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    compact = compact.replace(new RegExp(`${name}20\\d{2}年(?:半年度|年度|第?一季度|第?三季度)报告(?:全文)?\\d+(?:/\\d+)?`, "gu"), "");
  }
  return compact;
}

const chineseOwn = text => /本公司|我们|我司|(?<!其他|客户|对方|子|母|目标|关联|投资|控股|该|上述|某|相关|竞争对手)公司(?:在|的|将|面临|承受|主要|业务|产品|受|目前|不断|依赖|采用|利用|持续|已|可以|可能|所|通过|没有|不|对|为|以|及)/u.test(text);

// Require ownership, an economic factor and its effect in the same original
// sentence. A legal name in a running footer, a preceding unrelated sentence,
// an accounting rule or a general disclaimer cannot supply that connection.
export function hasChineseCompanyEconomicExposure(excerpt, { issuerName } = {}) {
  const text = chineseExposureText(excerpt, issuerName);
  if (/按照(?:组合)?计提存货跌价准备|可变现净值|权益法|成本法|评估信用风险是否|损失准备的量化数据|参见附注/u.test(text)) return false;
  return text.split(/(?<=[。！？])/u).some(original => {
    const sentence = original.replace(/^.*?风险(?:√适用□不适用)?(?=(?:本公司|公司))/u, "");
    return chineseOwn(sentence) && CN_FACTOR.test(sentence) && CN_IMPACT.test(sentence) && CN_OUTCOME.test(sentence) && !CN_BOILERPLATE.test(original);
  });
}

function chineseCompanyExposureExcerpts(text, issuerName, acceptExcerpt) {
  const original = text.replace(/\s+/gu, " ").trim();
  const sentences = [...new Intl.Segmenter("zh", { granularity: "sentence" }).segment(original)].map(item => ({ quote: item.segment.trim(), position: item.index }));
  const qualification = /^(?:但|然而|不过|尽管|虽然|同时|相反|此外|其中|因此|上述|该风险|在此情况下|为控制|为应对|为降低|(?:本公司|公司)[^。]{0,70}(?:不|尚未|可能|采取|降低|规避|控制|应对|保持|采用|对冲|固定利率))/u;
  const candidates = [];
  for (let index = 0; index < sentences.length; index += 1) {
    if (!hasChineseCompanyEconomicExposure(sentences[index].quote, { issuerName })) continue;
    let { quote, position } = sentences[index];
    const previous = sentences[index - 1];
    if (previous && hasChineseCompanyEconomicExposure(previous.quote, { issuerName }) && previous.quote.length + quote.length + 1 <= 700) {
      quote = `${previous.quote} ${quote}`; position = previous.position;
    }
    let clipped = false;
    for (let next = index + 1; next < sentences.length && qualification.test(chineseExposureText(sentences[next].quote, issuerName)); next += 1) {
      if (quote.length + sentences[next].quote.length + 1 > 700) { clipped = true; break; }
      quote += ` ${sentences[next].quote}`;
    }
    // A heading, a table row, general risk boilerplate or a competitor mention
    // supplies no issuer-owned transmission. Keep whole original sentences and
    // every adjacent explicit qualification, including denials of sensitivity.
    if (clipped || quote.length < 60 || quote.length > 700 || !/[。！？]$/u.test(quote) || CN_BOILERPLATE.test(chineseExposureText(quote, issuerName)) || !acceptExcerpt(quote)) continue;
    const priority = /(?<!毛)利率|(?<!金)融资/u.test(chineseExposureText(quote, issuerName)) ? 3 : /风险|可能|不确定|下降|上涨/u.test(quote) ? 2 : 1;
    candidates.push({ quote, position, priority });
  }
  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.priority - a.priority || a.position - b.position)) {
    if (selected.some(item => candidate.position < item.position + item.quote.length && item.position < candidate.position + candidate.quote.length)) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.sort((a, b) => a.position - b.position).map(item => item.quote);
}
