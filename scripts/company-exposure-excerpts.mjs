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
export function companyExposureExcerpts(text, { language = "en", issuerName } = {}) {
  if (language === "zh") return chineseCompanyExposureExcerpts(text, issuerName);
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

function chineseCompanyExposureExcerpts(text, issuerName) {
  const original = text.replace(/\s+/gu, " ").trim();
  const sentences = [...new Intl.Segmenter("zh", { granularity: "sentence" }).segment(original)].map(item => ({ quote: item.segment.trim(), position: item.index }));
  const factor = /需求|供给|供应|成本|利率|融资|监管|风险/u;
  const qualification = /^(?:但|然而|不过|尽管|虽然|同时|相反|此外|其中|因此|上述|该风险|(?:本公司|公司)[^。]{0,70}(?:不|尚未|可能|对冲|固定利率))/u;
  const boilerplate = /董事会[^。]{0,80}(?:保证|承担)|不存在虚假记载|公司负责人[^。]{0,80}保证|会计政策变更|公允价值计量|会计估计|会计准则|财务报表附注/u;
  const own = quote => /本公司|我们|我司/u.test(quote) || (typeof issuerName === "string" && issuerName.length >= 2 && quote.includes(issuerName));
  const candidates = [];
  for (let index = 0; index < sentences.length; index += 1) {
    if (!factor.test(sentences[index].quote) || boilerplate.test(sentences[index].quote)) continue;
    let { quote, position } = sentences[index];
    const previous = sentences[index - 1];
    if (previous && !boilerplate.test(previous.quote) && previous.quote.length + quote.length + 1 <= 700) {
      quote = `${previous.quote} ${quote}`; position = previous.position;
    }
    let clipped = false;
    for (let next = index + 1; next < sentences.length && qualification.test(sentences[next].quote); next += 1) {
      if (quote.length + sentences[next].quote.length + 1 > 700) { clipped = true; break; }
      quote += ` ${sentences[next].quote}`;
    }
    // A heading, a table row, general risk boilerplate or a competitor mention
    // supplies no issuer-owned transmission. Keep whole original sentences and
    // every adjacent explicit qualification, including denials of sensitivity.
    if (clipped || quote.length < 60 || quote.length > 700 || !/[。！？]$/u.test(quote) || !own(quote) || boilerplate.test(quote)) continue;
    const priority = /利率|融资/u.test(quote) ? 3 : /风险|可能|不确定|下降|上涨/u.test(quote) ? 2 : 1;
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
