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
export function companyExposureExcerpts(text) {
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
