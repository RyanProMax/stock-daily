import assert from "node:assert/strict";
import test from "node:test";
import { backgroundEvidenceInWindow } from "../scripts/evidence-timing.mjs";
import { sourceBodyText, sourcePublishedDateCandidates } from "../scripts/daily-source-audit.mjs";
import { validateResearchOutput, verifyResearchSources } from "../scripts/daily-workflow-core.mjs";
import { assessRecapEvidenceCoverage, validateCompleteRecap } from "../scripts/complete-recap.mjs";
import { recapFixture } from "./complete-recap-fixture.mjs";

const url = "https://www.sec.gov/Archives/edgar/data/1064641/000119312526031732/d96415d497k.htm";
const excerpt = "Utilities Sector Risk: The Fund's assets will be concentrated in the utilities sector, which means the Fund will be more affected by the performance of the utilities sector than a fund that is more diversified. The value of regulated utility equity securities may tend to have an inverse relationship to the movement of interest rates.";

function backgroundFixture() {
  const f = recapFixture(), anomaly = f.plan.anomalies.find(item => item.target === "XLU");
  const output = {
    contractVersion: "stock-daily-evidence-worker-v1", role: "facts", market: "US", anomalyId: anomaly.id, outcome: "found",
    queries: [anomaly.factQueries[0], "2026-08-21 US XLU Utilities State Street prospectus interest rates financing costs"], alternatives: [],
    sources: [{ url, sourceLabel: "SEC", title: "State Street Utilities Select Sector SPDR ETF disclosure", publishedAt: "2026-01-30T20:55:54Z", kind: "background", supportingExcerpt: excerpt, facts: "公用事业基金集中于公用事业行业，受该行业表现影响更大；受监管公用事业股价可能与利率变化呈反向关系。", scope: "sector", targets: ["XLU"], hypothesisIds: [anomaly.hypotheses[1].id], causalConnection: false, comparisons: [] }],
  };
  const reader = async () => ({ finalUrl: url, status: 200, contentType: "text/html", text: "Select Sector SPDR Trust\n" + excerpt, publishedAtCandidates: ["2026-01-30T20:55:54Z"], publishedDateCandidates: [] });
  return { ...f, anomaly, output, reader };
}

test("first-party background preserves structural exposure without counting as a fresh event or causal coverage", async () => {
  const f = backgroundFixture();
  const research = validateResearchOutput(f.output, "facts", f.anomaly, f.envelope);
  assert.equal(research.sources.length, 1);
  const ledger = await verifyResearchSources([research], f.envelope, { reader: f.reader });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.deepEqual(ledger.sources[0].backgroundSubjects, ["XLU"]);
  assert.equal(ledger.sources[0].causalConnection, false);
  assert.ok(ledger.sources[0].useLimitation.includes("not a current-session event"));
  const coverage = assessRecapEvidenceCoverage(f.envelope, ledger);
  assert.equal(coverage.eligibleCount, 0);
  assert.ok(coverage.entries.find(item => item.target === "XLU").gaps.includes("official_facts"));
  const index = f.plan.anomalies.indexOf(f.anomaly);
  f.ledger.sources = f.ledger.sources.filter(item => item.id !== `${index}-facts`);
  f.ledger.sources.push({ ...ledger.sources[0], id: `${index}-facts` });
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /官方事实/);
});

test("background is unavailable to headline research, causal workers, publishers, and fresh financial comparisons", () => {
  for (const change of [
    f => delete f.anomaly.researchPurpose,
    f => f.output.sources[0].url = "https://www.reuters.com/markets/old-risk",
    f => f.output.sources[0].comparisons = [{ label: "Revenue", actualValue: 10, actualDisplay: "$10", baselineValue: 8, baselineDisplay: "$8", baselineLabel: "Prior year", unit: "usd", higherIsPositive: true, note: "Historical reported figures", sourceUrl: url }],
    f => { f.output.role = "causal"; f.output.sources[0].causalConnection = true; f.output.queries[0] = f.anomaly.causalQueries[0]; f.output.alternatives = [{ claim: "Another explanation is unresolved", status: "unresolved", sourceUrls: [] }]; },
  ]) {
    const f = backgroundFixture(); change(f);
    const research = validateResearchOutput(f.output, f.output.role, f.anomaly, f.envelope);
    assert.equal(research.sources.length, 0);
  }
});

test("old background cannot be disguised as a current official event, future context, or unrelated sector risk", async () => {
  for (const change of [
    f => f.output.sources[0].kind = "official",
    f => { f.output.sources[0].publishedAt = "2026-08-21T22:00:00Z"; f.reader = async () => ({ finalUrl: url, text: excerpt, publishedAtCandidates: ["2026-08-21T22:00:00Z"] }); },
    f => { f.output.sources[0].supportingExcerpt = "The technology sector is affected by borrowing costs and demand changes."; f.reader = async () => ({ finalUrl: url, text: f.output.sources[0].supportingExcerpt, publishedAtCandidates: ["2026-01-30T20:55:54Z"] }); },
    f => f.output.sources[0].scope = "event_only",
  ]) {
    const f = backgroundFixture(); change(f);
    const research = validateResearchOutput(f.output, "facts", f.anomaly, f.envelope);
    const ledger = await verifyResearchSources([research], f.envelope, { reader: f.reader });
    assert.equal(ledger.sources.length, 0);
    assert.equal(ledger.rejected.length, 1);
  }
});

test("background date precision does not invent a clock time or cross the session start", () => {
  const { envelope } = backgroundFixture();
  assert.ok(backgroundEvidenceInWindow("2026-01-30", envelope));
  for (const date of ["2026-08-20", "2026-08-21", "2025-01-01", "2026-02-30", "2026-02-30T20:55:54Z", "2026-01-30T20:55:54"]) assert.equal(backgroundEvidenceInWindow(date, envelope), false);
});

test("a constituent disclosure records only that constituent, without broadening to the AI basket", async () => {
  const f = backgroundFixture();
  f.anomaly = f.plan.anomalies.find(item => item.kind === "ai_layer");
  const constituent = f.anomaly.observation.constituents[0];
  constituent.symbol = "NVDA"; constituent.nameEn = "NVIDIA";
  const text = `${constituent.nameEn}: Demand changes and financing costs can affect this company's business and financial performance.`;
  const companyUrl = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm";
  const rawBody = Buffer.from(`<ix:nonNumeric name="dei:EntityCentralIndexKey">0001045810</ix:nonNumeric><ix:nonNumeric name="dei:DocumentType">10-K</ix:nonNumeric><ix:nonNumeric name="dei:EntityRegistrantName">NVIDIA CORP</ix:nonNumeric><ix:nonNumeric name="dei:TradingSymbol">${constituent.symbol}</ix:nonNumeric><p>${text}</p>`);
  f.output.anomalyId = f.anomaly.id;
  f.output.queries = [f.anomaly.factQueries[0], `2026-08-21 US ${constituent.nameEn} official risk demand financing costs`];
  Object.assign(f.output.sources[0], { url: companyUrl, targets: [f.anomaly.target], hypothesisIds: [f.anomaly.hypotheses[1].id], scope: "company", supportingExcerpt: text, facts: "公司披露需求变化和融资成本可能影响其业务及财务表现。" });
  const research = validateResearchOutput(f.output, "facts", f.anomaly, f.envelope);
  const ledger = await verifyResearchSources([research], f.envelope, { reader: async () => ({ finalUrl: companyUrl, rawBody, text, publishedAtCandidates: ["2026-01-30T20:55:54Z"] }) });
  assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
  assert.deepEqual(ledger.sources[0].backgroundSubjects, [constituent.symbol]);
  assert.equal(ledger.sources[0].scope, "company");
  assert.equal(assessRecapEvidenceCoverage(f.envelope, ledger).eligibleCount, 0);
  f.output.sources[0].scope = "ai_layer";
  f.output.sources[0].supportingExcerpt += " The chips business is sensitive to demand and financing costs.";
  const broadened = validateResearchOutput(f.output, "facts", f.anomaly, f.envelope);
  const rejected = await verifyResearchSources([broadened], f.envelope, { reader: async () => ({ finalUrl: companyUrl, rawBody, text: f.output.sources[0].supportingExcerpt, publishedAtCandidates: ["2026-01-30T20:55:54Z"] }) });
  assert.equal(rejected.sources.length, 0);
  assert.match(rejected.rejected[0].reason, /不能自动扩大/);
});

test("only a first-party SEC archival opening filing header establishes its explicit date", () => {
  const filing = "<h1>As filed with the U.S. Securities and Exchange Commission on January 28, 2026</h1><p>Registration Statement</p>";
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(filing), "text/html", url), ["2026-01-28"]);
  const inlineHeader = "<ix:header><ix:hidden>" + "888888 hidden machine values ".repeat(300) + "</ix:hidden></ix:header>";
  assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(inlineHeader + filing), "text/html", url), ["2026-01-28"]);
  assert.ok(!sourceBodyText(Buffer.from(inlineHeader + filing), "text/html").includes("888888"));
  for (const [body, source] of [
    [filing, "https://mirror.example/Archives/edgar/data/1064641/000119312526031732/doc.htm"],
    [filing, "https://www.sec.gov/newsroom/press-releases/example"],
    ["<p>Updated January 28, 2026</p>", url],
    ["<p>Summary Prospectus-January 31, 2026</p>", url],
    ["<p>For comparison: As filed with the U.S. Securities and Exchange Commission on January 28, 2026</p>", url],
    ["<p>" + "x".repeat(4100) + "</p>" + filing, url],
  ]) assert.deepEqual(sourcePublishedDateCandidates(Buffer.from(body), "text/html", source), []);
});
