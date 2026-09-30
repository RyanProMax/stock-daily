import { fixtureInput } from "./daily-v10-fixture.mjs";
import { marketEnvelope } from "../scripts/daily-workflow-core.mjs";
import { RECAP_VERSION, completeRecapPlan } from "../scripts/complete-recap.mjs";
import { tradingRequests } from "../scripts/recap-market-data.mjs";

export function recapFixture(market = "US") {
  const envelope = marketEnvelope(fixtureInput(), market);
  const plan = completeRecapPlan(envelope);
  const ledger = { sources: plan.anomalies.flatMap((anomaly, index) => [
    { id: `${index}-facts`, anomalyId: anomaly.id, role: "facts", targets: [anomaly.target], sourceType: "first_party", url: `https://www.sec.gov/Archives/example-${index}`, sourceLabel: "SEC", supportingExcerpt: "The issuer confirmed a change in demand and borrowing costs in its official disclosure.", excerptHash: "facts-hash", verifiedAt: "2026-08-21T21:00:00Z", publishedAt: "2026-08-21T19:00:00Z" },
    { id: `${index}-causal`, anomalyId: anomaly.id, role: "causal", targets: [anomaly.target], sourceType: "publisher", url: `https://www.reuters.com/markets/example-${index}`, sourceLabel: "Reuters", supportingExcerpt: `${anomaly.target} rose because improved demand supported earnings expectations, while offsetting borrowing costs and lower volume limited the advance.`, causalConnection: true, excerptHash: "causal-hash", verifiedAt: "2026-08-21T21:00:00Z", publishedAt: "2026-08-21T20:30:00Z" },
  ]) };
  const social = { status: "ok", attempted: true, leads: [] };
  const raw = { contractVersion: RECAP_VERSION, market, marketAsOf: envelope.marketAsOf, entries: plan.anomalies.map((anomaly, index) => ({
    target: anomaly.target, status: "explained", confidence: "medium",
    why: `${anomaly.observation.name}：公司公告确认了需求和融资条件的变化，收盘报道将这项变化与对应板块的价格反应联系起来。需求改善支持盈利预期，融资成本则形成相反力量。这是基于已公布信息的因果解释，后续需要观察订单兑现情况以及融资条件能否维持，不能仅用价格变动本身证明原因。`,
    whyEn: `${anomaly.observation.nameEn ?? anomaly.title}: the issuer confirmed changes in demand and financing conditions. The closing report connects those changes to this target: improved demand supports earnings expectations while borrowing costs work in the opposite direction. This remains an interpretation of the documented reaction.`,
    magnitude: "需求改善和融资成本形成相反力量，较低的成交量限制了上涨延续；这里解释的是收盘涨跌幅，不把它当作盘中振幅。",
    magnitudeEn: "Offsetting borrowing costs and lower volume limited the advance. The close-to-close return and intraday trading range measure different features of the session.",
    evidenceIds: [`${index}-facts`, `${index}-causal`], magnitudeEvidenceIds: [`${index}-causal`], magnitudeObservationIds: [],
    alternatives: [{ text: "融资成本上升可能限制需求改善所带来的盈利预期提升。", textEn: "Higher borrowing costs may offset improved earnings expectations.", status: "supported", evidenceIds: [`${index}-causal`] }], opinions: [],
    invalidateIf: "若后续订单披露显示需求没有改善，应重新评估这项判断。", invalidateIfEn: "Reassess if subsequent orders do not confirm the improvement in demand.",
  })) };
  const tradingData = { market, marketAsOf: envelope.marketAsOf, snapshots: [], entries: [], gaps: tradingRequests(envelope).map(item => ({ symbol: item.symbol, reason: "Test fixture has no trading history; never infer volume or range from it." })) };
  const macroData = { market, marketAsOf: envelope.marketAsOf, snapshots: [], context: null, gaps: [{ series: "daily_treasury_yield_curve", reason: "Test fixture has no official yield observations." }] };
  return { envelope, plan, ledger, social, raw, tradingData, macroData };
}
