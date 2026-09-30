import type { Language, MarketRegion, RecapEntry } from "../types";

export default function RecapDetails({ entry, language, market }: { entry?: RecapEntry; language: Language; market: MarketRegion }) {
  const en = language === "en";
  const time = (value: string) => new Intl.DateTimeFormat(en ? "en-US" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: market === "CN" ? "Asia/Shanghai" : "America/New_York" }).format(new Date(value));
  if (!entry) return <p className="recap-pending">{en ? "Attribution pending verification" : "本期归因待核实"}</p>;
  const status = entry.status === "explained" ? (en ? "Evidence and interpretation" : "证据与归因") : (en ? "Evidence incomplete" : "归因证据仍不完整");
  const confidence = entry.confidence === "high" ? (en ? "High confidence" : "把握较高") : entry.confidence === "medium" ? (en ? "Moderate confidence" : "中等把握") : (en ? "Low confidence" : "把握较低");
  return (
    <details className="recap-details" data-recap-target={entry.target}>
      <summary>{status} · {confidence}</summary>
      <div className="recap-content">
        <p>{en ? entry.whyEn : entry.why}</p>
        <strong>{en ? "What limited or amplified the move" : "涨跌幅为何受限或放大"}</strong>
        <p>{en ? entry.magnitudeEn : entry.magnitude}</p>
        {entry.alternatives.map((alternative, i) => <p className="recap-alternative" key={i}>
          <b>{en ? "Competing explanation" : "竞争解释"} · {alternative.status === "unresolved" ? (en ? "Unconfirmed" : "尚未确认") : alternative.status === "contradicted" ? (en ? "Contradicted" : "证据不支持") : (en ? "Supported" : "有证据支持")}</b>
          {en ? alternative.textEn : alternative.text}
          {alternative.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}
        </p>)}
        {entry.opinions.map((opinion) => <div className="recap-opinion" key={opinion.url}>
          <a href={opinion.url} target="_blank" rel="noreferrer">X · @{opinion.authorHandle} · {time(opinion.publishedAt)}</a>
          <p>{en ? "Author's perspective: " : "作者观点："}{en ? opinion.textEn : opinion.text}</p>
        </div>)}
        <p><b>{en ? "What would change this interpretation" : "哪些变化会改变判断"}</b>{en ? entry.invalidateIfEn : entry.invalidateIf}</p>
        <ul className="recap-sources">
          {entry.sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a><time dateTime={source.publishedAt}>{time(source.publishedAt)}</time></li>)}
        </ul>
      </div>
    </details>
  );
}
