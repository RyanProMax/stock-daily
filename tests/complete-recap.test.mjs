import { workflowImplementationSnapshot } from "../scripts/workflow-implementation.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fixtureInput } from "./daily-v10-fixture.mjs";
import { assertFactsNumbersInExcerpt, marketEnvelope, publicComparison, stableHash, validateResearchOutput } from "../scripts/daily-workflow-core.mjs";
import { MarketWorkflow, assertResearchBatchBudget, compatibleFeatureArgs, recapResearchSourceAccess } from "../scripts/daily-workflow.mjs";
import { RECAP_VERSION, assessRecapEvidenceCoverage, compactRecapCoverage, completeRecapPlan, recapTargets, recapObservations, validateCompleteRecap, validateRecapReview, verifySocialLeads } from "../scripts/complete-recap.mjs";
import { workflowMarketContentHash, preserveInactiveStoredSlice, auditWorkflowCausalEvidence } from "../scripts/daily-workflow-publish.mjs";
import { verifiedExternalSourceType } from "../scripts/source-registry.mjs";

import { recapFixture } from "./complete-recap-fixture.mjs";

test("coverage includes every industry and AI basket even if the observed move is flat", () => {
  for (const market of ["CN", "US"]) {
    const fixture = recapFixture(market);
    const targets = recapTargets(fixture.envelope);
    assert.equal(targets.length, 20);
    assert.equal(targets.filter((item) => item.kind === "sector").length, 11);
    assert.equal(targets.filter((item) => item.kind === "ai_layer").length, 8);
    fixture.envelope.sectorPerformance[0].change = "0.00%";
    fixture.envelope.sectorPerformance[0].direction = "flat";
    assert.equal(completeRecapPlan(fixture.envelope).anomalies.find((item) => item.target === fixture.envelope.sectorPerformance[0].symbol).direction, "mixed");
    assert.equal(validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social, { requireComplete: true }).status, "complete");
  }
});

test("missing, duplicated and invented target coverage cannot pass", () => {
  for (const mutate of [raw => raw.entries.pop(), raw => raw.entries[1].target = raw.entries[0].target, raw => raw.entries[0].target = "invented"]) {
    const fixture = recapFixture(); mutate(fixture.raw);
    assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social), /目标|遗漏|重复/);
  }
});

test("observations reconstruct equal-weight offsets without inventing sector weights or volatility", () => {
  const f = recapFixture();
  const basket = f.envelope.aiChainPerformance[0];
  basket.constituents.forEach((item, index) => item.change = ["+4.00%", "-3.00%", "+1.00%", "-2.00%"][index]);
  basket.change = "0.00%";
  const observations = recapObservations(f.envelope);
  const ai = observations.find(item => item.target === basket.symbol);
  assert.equal(ai.equalWeight.positiveContribution, "1.25 个百分点 (1.25 percentage points)");
  assert.equal(ai.equalWeight.negativeContribution, "-1.25 个百分点 (-1.25 percentage points)");
  assert.equal(ai.equalWeight.reconstructedReturn, "0.00%");
  assert.equal(ai.risingRepresentatives, 2);
  assert.equal(ai.fallingRepresentatives, 2);
  assert.equal(ai.representativeSpread, "7.00 个百分点 (7.00 percentage points)");
  const sector = observations.find(item => item.target === f.envelope.sectorPerformance[0].symbol);
  assert.equal(sector.equalWeight, undefined);
  assert.equal(sector.intradayRange, undefined);
  assert.equal(sector.fundFlow, undefined);
  assert.equal(sector.sectorBreadth, undefined);
  basket.change = "+0.10%";
  assert.throws(() => recapObservations(f.envelope), /成分复核/);
  basket.change = "0.00%";
  basket.constituents[0].asOf = "2026-08-20";
  assert.throws(() => recapObservations(f.envelope), /交易日/);
});

test("evidence coverage is measured before a writer can pad missing causes", () => {
  const f = recapFixture();
  assert.equal(assessRecapEvidenceCoverage(f.envelope, f.ledger).eligibleCount, 20);
  f.ledger.sources = f.ledger.sources.filter(source => source.id !== "0-causal");
  const coverage = assessRecapEvidenceCoverage(f.envelope, f.ledger);
  assert.equal(coverage.eligibleCount, 19);
  assert.ok(coverage.entries[0].gaps.includes("target_causality"));
  assert.ok(coverage.entries[0].gaps.includes("magnitude"));
});

test("native attribution input shares repeated pairs without losing any target, timing proof or qualification", () => {
  const f = recapFixture(), coverage = assessRecapEvidenceCoverage(f.envelope, f.ledger);
  coverage.entries[0].attributionCandidates.candidatePairs[0].timingEvidenceIds = ["exact-before-close-confirmation"];
  const originalHash = stableHash(coverage), compact = compactRecapCoverage(coverage);
  const { attributionPairs, ...expanded } = structuredClone(compact);
  for (const entry of expanded.entries) {
    const { candidatePairIndexes, ...candidates } = entry.attributionCandidates;
    entry.attributionCandidates = { ...candidates, candidatePairs: candidatePairIndexes.map(index => attributionPairs[index]) };
  }
  assert.deepEqual(expanded, coverage);
  assert.equal(stableHash(coverage), originalHash);
  assert.equal(stableHash(compactRecapCoverage(coverage)), stableHash(compact));
  assert.ok(JSON.stringify(compact).length < JSON.stringify(coverage).length / 3);
  compact.attributionPairs[0].timingEvidenceIds.push("cannot-mutate-original");
  assert.equal(stableHash(coverage), originalHash);
});

test("thin, ungrounded, expert-only and target-mismatched attribution cannot pass", () => {
  for (const mutate of [
    f => f.raw.entries[0].why = "市场上涨。",
    f => f.raw.entries[0].why += "资金流入9999亿美元。",
    f => f.ledger.sources[0].sourceType = "publisher",
    f => f.ledger.sources[1].targets = ["another-sector"],
    f => f.ledger.sources[1].supportingExcerpt = "The index rose and its constituents also rose.",
    f => f.ledger.sources[0].excerptHash = null,
    f => f.ledger.sources[0].url = "https://unknown.example/fake",
    f => f.ledger.sources[0].anomalyId = "other-sector",
    f => f.raw.entries[0].opinions = [{ postId: "invented", evidenceIds: ["0-facts"] }],
  ]) {
    const fixture = recapFixture(); mutate(fixture);
    assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social));
  }
});

test("unit checks do not turn the first letter of Monday into a million-dollar scale", () => {
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "Brent briefly climbed above $100 Monday.", supportingExcerpt: "Brent briefly climbed above $100 on Monday." }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "Brent briefly climbed above $100M.", supportingExcerpt: "Brent briefly climbed above $100 on Monday." }), /单位|数字/);
});

test("decimal points preserve movement context and later rebounds cannot reverse an earlier settlement", () => {
  const excerpt = "Brent fell 1.7% to settle at $96.16 a barrel. It briefly climbed above $100 on Monday.";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "Brent fell 1.7% to settle at $96.16 after briefly climbing above $100 Monday.", supportingExcerpt: excerpt }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "Brent rose 1.7% to settle at $96.16.", supportingExcerpt: excerpt }), /单位和方向/);
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "Brent fell 1.7% to settle at $96.16M.", supportingExcerpt: excerpt }), /单位和方向/);
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "Brent fell 1.7% to $96.16 after briefly exceeding $100 on Monday.", supportingExcerpt: excerpt }));
  const oil = "WTI原油期货下跌3.66美元，收于每桶88.94美元，跌幅为3.95%。";
  assert.doesNotThrow(() => assertFactsNumbersInExcerpt({ facts: "WTI原油期货下跌3.66美元至每桶88.94美元，跌幅为3.95%。", supportingExcerpt: oil }));
  assert.throws(() => assertFactsNumbersInExcerpt({ facts: "WTI原油期货上涨至每桶88.94美元。", supportingExcerpt: oil }), /单位和方向/);
});

test("magnitude needs target-specific offset, volume, range or breadth evidence", () => {
  const fixture = recapFixture();
  fixture.ledger.sources[1].supportingExcerpt = "The index rose because the official announcement improved earnings expectations.";
  assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social), /分化|相反力量/);
  fixture.raw.entries[0].status = "partial";
  fixture.raw.entries[0].confidence = "medium";
  const partial = validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social);
  assert.equal(partial.status, "partial");
  assert.throws(() => validateCompleteRecap(fixture.raw, fixture.envelope, fixture.ledger, fixture.social, { requireComplete: true }), /覆盖不完整/);
});

test("every target and magnitude score must pass independent review", () => {
  const f = recapFixture();
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social);
  const review = { market: "US", entries: recap.entries.map(entry => ({ target: entry.target, verdict: "pass", scores: { factualAccuracy: 5, causality: 4, magnitude: 4, sourceIndependence: 5, readerUtility: 4 } })) };
  assert.equal(validateRecapReview(review, recap), review);
  review.entries[0].scores.magnitude = 3;
  assert.throws(() => validateRecapReview(review, recap), /审稿未通过/);
  review.entries[0].scores.magnitude = 4;
  review.entries[1].target = review.entries[0].target;
  assert.throws(() => validateRecapReview(review, recap), /目标重复/);
});

test("identical wire passages on different domains cannot produce high confidence", () => {
  const f = recapFixture();
  const copy = { ...f.ledger.sources[1], id: "0-syndicated", url: "https://finance.yahoo.com/news/reprinted-story.html", sourceLabel: "Yahoo Finance" };
  f.ledger.sources.push(copy);
  f.raw.entries[0].evidenceIds.push(copy.id);
  f.raw.entries[0].confidence = "high";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /独立报道交叉佐证/);
  f.raw.entries[0].confidence = "medium";
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social).entries[0].confidence, "medium");
});

test("an original X post and an unrelated official citation cannot validate the post's factual numbers", () => {
  const f = recapFixture();
  f.social.leads = [{ id: "x-test", authorHandle: "Analyst", url: "https://x.com/Analyst/status/123", publishedAt: "2026-08-21T18:00:00Z", textComplete: true, text: "The share of consumers expecting higher interest rates rose to 68.4%, which may affect risk appetite." }];
  f.raw.entries[0].opinions = [{ postId: "x-test", evidenceIds: ["0-facts", "0-causal"], text: "该评论者指出，预期利率上涨的消费者比例达到68.4%，并认为这一预期可能影响风险偏好。", textEn: "The commentator notes that the share expecting higher interest rates reached 68.4% and considers this a possible influence on risk appetite." }];
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /KOL 事实数字的官方佐证/);
  // A publisher or the post itself is still insufficient for primary facts.
  f.ledger.sources[1].supportingExcerpt += " Consumers expecting higher interest rates rose to 68.4%.";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /KOL 事实数字的官方佐证/);
  f.ledger.sources[0].supportingExcerpt = "The share of consumers expecting higher interest rates rose to 68.4% in the current survey.";
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social).entries[0].opinions.length, 1);
  delete f.social.leads[0].textComplete;
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /完整原帖/);
  f.social.leads[0].textComplete = true;
  const original = f.social.leads[0].text;
  for (const marker of [" (1/2)", " (1/5)", " 🧵", " This thread continues in the next post."]) {
    f.social.leads[0].text = original + marker;
    assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /串帖/);
  }
  f.social.leads[0].text = original;
  f.raw.entries[0].opinions[0].text = "该评论者指出，预期利率上涨的消费者比例下降至68.4%，并认为这一预期可能影响风险偏好。";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /单位和方向/);
});

test("an officially supported number cannot be falsely attributed to an unrelated complete KOL original", () => {
  const f = recapFixture();
  f.ledger.sources[0].supportingExcerpt += " The PCE price index increased 0.3 percent in August.";
  f.social.leads = [{ id: "gdpnow-original", authorHandle: "Analyst", url: "https://x.com/Analyst/status/123", publishedAt: "2026-08-21T18:00:00Z", textComplete: true, text: "The latest real GDP estimate from the GDPNow model fell to +3.7%, down from the prior reading of +5.0%." }];
  f.raw.entries[0].opinions = [{ postId: "gdpnow-original", evidenceIds: ["0-facts"], text: "该评论者指出，八月PCE价格指数上涨0.3%，并讨论这一变化对市场的意义。", textEn: "The commentator said that the PCE price index increased 0.3 percent in August and discussed its relevance for markets." }];
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /KOL 署名内容的原帖数字/);
});

test("each language preserves the author's original values instead of substituting a newer officially supported value", () => {
  for (const language of ["text", "textEn"]) {
    const f = recapFixture();
    f.ledger.sources[0].supportingExcerpt += " The PCE price index increased 0.3 percent in August. A revised estimate says the PCE price index increased 0.4 percent.";
    f.social.leads = [{ id: "pce-original", authorHandle: "Analyst", url: "https://x.com/Analyst/status/123", publishedAt: "2026-08-21T18:00:00Z", textComplete: true, text: "The PCE price index increased 0.3 percent in August; this is an observation, not a claim about what caused today's stocks." }];
    const opinion = { postId: "pce-original", evidenceIds: ["0-facts"], text: "该评论者指出，八月PCE价格指数上涨0.3%，同时保留这只是数据观察的限制。", textEn: "The commentator said that the PCE price index increased 0.3 percent in August and retained its interpretation as a data observation." };
    f.raw.entries[0].opinions = [opinion];
    assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social).entries[0].opinions.length, 1);
    opinion[language] = opinion[language].replace("0.3", "0.4");
    assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /KOL 署名内容的原帖数字/);
  }
});

test("financial attributions show two actual/baseline/code-delta comparisons in both languages", () => {
  const f = recapFixture(), source = f.ledger.sources[0];
  source.comparisons = [
    { label: "EPS", unit: "usd", actualValue: 1.2, actualDisplay: "$1.20", baselineValue: 1, baselineDisplay: "$1.00", baselineLabel: "Consensus", higherIsPositive: true, note: "No non-recurring gain is included." },
    { label: "Revenue", unit: "billion_usd", actualValue: 12, actualDisplay: "$12B", baselineValue: 10, baselineDisplay: "$10B", baselineLabel: "Consensus", higherIsPositive: true, note: "Revenue as reported." },
  ];
  source.earningsContextChecked = true;
  source.supportingExcerpt = "Reported EPS was $1.20 against $1.00 consensus; revenue was $12B against $10B. No non-recurring gain is included.";
  f.raw.entries[0].why += "公司财报好于预期。";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /未展示财报/);
  const metrics = source.comparisons.map(publicComparison);
  const copy = metrics.map(item => `${item.label}: ${item.actual}, ${item.baselineLabel}: ${item.baseline}, ${item.delta}.`).join(" ");
  f.raw.entries[0].why += copy;
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /英文财报归因/);
  f.raw.entries[0].whyEn += copy;
  assert.equal(validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social).entries[0].status, "explained");
  source.comparisons[1].label = "Brent oil price";
  assert.throws(() => validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social), /财报归因缺少/);
});

test("X originals bind allowlisted authors and snowflake times; future posts and mirrors are rejected", () => {
  const f = recapFixture();
  const publishedAt = "2026-08-21T19:00:00Z";
  const id = ((BigInt(Date.parse(publishedAt)) - 1288834974657n) << 22n).toString();
  const registry = [{ handle: "Analyst", label: "Analyst", authority: "expert", markets: ["US"], layers: ["chips"], identityEvidence: "https://x.com/Analyst" }];
  const post = { url: `https://x.com/Analyst/status/${id}`, authorHandle: "Analyst", publishedAt, platform: "x", facts: "Demand and financing changes could affect earnings expectations through documented orders and borrowing costs." };
  const verify = candidates => verifySocialLeads({ candidates, diagnostics: { status: "ok" } }, registry, f.envelope);
  assert.equal(verify([post]).leads.length, 1);
  assert.equal(verify([post]).leads[0].factualAuthority, false);
  assert.equal(verify([post]).leads[0].textComplete, false);
  const complete = { ...post, textComplete: true, originalTextLength: [...post.facts].length };
  assert.equal(verify([complete]).leads[0].textComplete, true);
  assert.equal(verify([complete]).leads[0].threadContextMissing, false);
  const thread = { ...complete, facts: complete.facts + " (1/2)" };
  thread.originalTextLength = [...thread.facts].length;
  assert.equal(verify([thread]).leads[0].threadContextMissing, true);
  for (const change of [{ textComplete: false }, { originalTextLength: 900 }, { facts: post.facts + " qualifier removed" }]) assert.equal(verify([{ ...complete, ...change }]).leads.length, 0);
  const closingTime = "2026-08-21T21:00:00Z";
  const closingId = ((BigInt(Date.parse(closingTime)) - 1288834974657n) << 22n).toString();
  assert.equal(verify([{ ...post, publishedAt: closingTime, url: `https://x.com/Analyst/status/${closingId}` }]).leads.length, 1);
  for (const change of [{ publishedAt: "2026-08-22T19:00:00Z" }, { authorHandle: "Impersonator" }, { url: `https://mirror.example/Analyst/status/${id}` }, { url: `https://x.com/Analyst/status/${BigInt(id) + (86400000n << 22n)}` }]) assert.equal(verify([{ ...post, ...change }]).leads.length, 0);
});

test("comprehensive research has a deterministic query budget and frozen plan", () => {
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true });
  assert.equal(workflow.searchQueryLimit, 108);
  assert.equal(assertResearchBatchBudget(12, completeRecapPlan(workflow.envelope).anomalies, {}, "", workflow.searchQueryLimit), 80);
  assert.throws(() => assertResearchBatchBudget(29, completeRecapPlan(workflow.envelope).anomalies, {}, "", workflow.searchQueryLimit), /预算不足/);
  assert.deepEqual(completeRecapPlan(workflow.envelope), completeRecapPlan(workflow.envelope));
});

test("recap searches name the largest observed representatives in deterministic order", () => {
  const f = recapFixture();
  const sector = f.envelope.sectorPerformance[0];
  sector.constituents.forEach((item, i) => item.change = ["+1.00%", "-4.00%", "+3.00%", "-2.00%"][i]);
  const plan = completeRecapPlan(f.envelope);
  const anomaly = plan.anomalies.find(item => item.target === sector.symbol);
  for (const query of [...anomaly.factQueries, ...anomaly.causalQueries]) {
    assert.ok(query.includes(sector.constituents[1].nameEn));
    assert.ok(query.includes(sector.constituents[2].nameEn));
    assert.ok(!query.includes("official earnings policy industry"));
  }
});

test("later research batches avoid repeated access refusals without excluding an entire publisher after one denial", () => {
  const initial = { urls: ["https://apnews.com/article/previous"], unavailableDomains: [] };
  const ledger = { rejected: [
    { url: "https://apnews.com/article/one", reason: "HTTP 403" },
    { url: "https://apnews.com/article/one", reason: "HTTP 403" },
    { url: "https://www.reuters.com/article/dated", reason: "未找到文章级发布时间" },
  ] };
  const one = recapResearchSourceAccess(initial, ledger);
  assert.equal(one.unavailableDomains.length, 0);
  assert.ok(one.urls.includes("https://apnews.com/article/one"));
  assert.ok(!one.urls.includes("https://www.reuters.com/article/dated"));
  ledger.rejected.push({ url: "https://apnews.com/article/two", reason: "HTTP 403" });
  const two = recapResearchSourceAccess(initial, ledger);
  assert.ok(two.unavailableDomains.includes("apnews.com"));
  assert.deepEqual(initial, { urls: ["https://apnews.com/article/previous"], unavailableDomains: [] });
});

test("comprehensive research freezes batch access hints and reproduces them on resume", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-recap-batches-"));
  try {
    const f = recapFixture();
    const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", completeRecap: true, workRoot: root,
      transmissionCollector: async () => f.transmissionData,
      companyBackgroundCollector: async () => f.companyBackgroundData,
      sourceVerifier: async outputs => ({ sources: [f.ledger.sources[0]], rejected: outputs.slice(0, 2).map((output, i) => ({ anomalyId: output.anomalyId, url: `https://apnews.com/article/refused-${i}`, reason: "HTTP 403" })) }),
    });
    await workflow.initialize();
    workflow.manifest.socialHash = stableHash(f.social);
    workflow.manifest.tradingHash = stableHash(f.tradingData);
    workflow.manifest.macroHash = stableHash(f.macroData);
    await writeFile(resolve(workflow.runDir, "artifacts/social-ledger.json"), JSON.stringify(f.social));
    await writeFile(resolve(workflow.runDir, "artifacts/recap-trading-data.json"), JSON.stringify(f.tradingData));
    await writeFile(resolve(workflow.runDir, "artifacts/recap-macro-data.json"), JSON.stringify(f.macroData));
    workflow.assertResearchCapacity = async () => {};
    // This fixture exercises batch isolation, not native URL discovery.
    workflow.runValidatedAgentStage = async ({ role }) => {
      assert.equal(role, "recap_discovery");
      return { output: [], key: "controlled-empty-discovery" };
    };
    const contexts = [];
    workflow.researchPrimaryRole = async (anomaly, role) => {
      contexts.push({ target: anomaly.target, urls: [...workflow.excludedSources], domains: [...workflow.researchSourceDomains], macroData: structuredClone(workflow.macroData), sharedEvidence: structuredClone(workflow.recapResearchEvidence), payload: workflow.researchPayload(anomaly) });
      return { anomalyId: anomaly.id, role, sources: [] };
    };
    await assert.rejects(() => workflow.runCompleteRecap(), /0\/20/);
    assert.ok(contexts[0].domains.includes("apnews.com"));
    assert.ok(!contexts[4].domains.includes("apnews.com"));
    assert.equal(contexts[4].urls.length, 2);
    assert.deepEqual(contexts[0].sharedEvidence, []);
    assert.deepEqual(contexts[4].sharedEvidence, [f.ledger.sources[0]]);
    assert.deepEqual(contexts[4].payload.sharedEvidence, contexts[4].sharedEvidence);
    const first = structuredClone(contexts);
    contexts.length = 0;
    await assert.rejects(() => workflow.runCompleteRecap(), /0\/20/);
    assert.deepEqual(contexts, first);
    // A controlled native failure must not prevent later targets being
    // researched, or enter attribution/writing even with sufficient sources.
    const roleCalls = [], failedKey = `${completeRecapPlan(workflow.envelope).anomalies[0].id}-facts`;
    f.ledger.sources[2].facts = "受控测试中已经核实的其他目标订单信息。";
    f.ledger.sources[2].scope = "sector";
    f.ledger.rejected = [{ facts: "REJECTED_FAKE_NEWS_MUST_NOT_ENTER_PRIVATE_COPY" }];
    await writeFile(resolve(workflow.runDir, "artifacts", `${failedKey}.json`), JSON.stringify({ sources: [{ facts: "INVALID_ROLE_FAKE_NEWS_MUST_NOT_ENTER_PRIVATE_COPY" }] }));
    workflow.verifyEvidence = async () => f.ledger;
    workflow.researchPrimaryRole = async (anomaly, role) => {
      const key = `${anomaly.id}-${role}`; roleCalls.push({ key, payload: workflow.researchPayload(anomaly) });
      if (key === failedKey) {
        workflow.manifest.failedAgentRuns ??= [];
        workflow.manifest.failedAgentRuns.push({ key, agentRunId: `controlled-${roleCalls.length}`, queries: [] });
        workflow.manifest.stages[key] = { status: "failed" };
        throw new Error("Controlled test failure; no real research was invoked");
      }
      return { anomalyId: anomaly.id, role, sources: [] };
    };
    workflow.runValidatedAgentStage = async () => { throw new Error("Failed primary research must not enter attribution or writing"); };
    await assert.rejects(workflow.runCompleteRecap(), /1 个独立角色/);
    assert.equal(roleCalls.length, 41); assert.equal(new Set(roleCalls.map(call => call.payload.anomaly.target)).size, 20);
    assert.deepEqual(roleCalls[0].payload, roleCalls.at(-1).payload);
    assert.equal(Object.values(workflow.manifest.recapResearchRoles).filter(role => role.status === "completed").length, 39);
    assert.equal(workflow.manifest.recapResearchRoles[failedKey].nativeAttemptCount, 2);
    assert.match(workflow.manifest.recapResearchRoles[failedKey].error, /Controlled test failure/);
    const privateDraft = workflow.manifest.privateRecapDraft;
    const saved = JSON.parse(await readFile(resolve(workflow.runDir, privateDraft.artifact), "utf8"));
    const readable = await readFile(resolve(workflow.runDir, privateDraft.markdownArtifact), "utf8");
    assert.equal(saved.entries.length, 20);
    assert.equal(saved.approved, false);
    assert.match(readable, /受控测试中已经核实的其他目标订单信息/);
    assert.doesNotMatch(readable, /(?:INVALID_ROLE|REJECTED)_FAKE_NEWS/);
    assert.equal(workflow.manifest.recapApproval, undefined);
    assert.equal(workflow.manifest.reportPath, undefined);
    roleCalls.length = 0;
    await assert.rejects(workflow.runCompleteRecap(), /1 个独立角色/);
    assert.equal(roleCalls.length, 39, "exhausted failures cannot receive a third native attempt on resume");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recap content participates in readback hashes", () => {
  const f = recapFixture();
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social);
  const report = { recaps: { US: recap } };
  const hash = workflowMarketContentHash(report, "US");
  report.recaps.US.entries[0].why += " altered";
  assert.notEqual(workflowMarketContentHash(report, "US"), hash);
});

test("private drafts survive a resumed smaller ledger without reopening research or granting approval", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-private-resume-"));
  try {
    const allTargets = [];
    for (const market of ["US", "CN"]) {
      const options = { input: fixtureInput(), market, completeRecap: true, workRoot: root };
      const workflow = new MarketWorkflow(options), f = recapFixture(market);
      workflow.manifest = { stages: {}, searchQueryCount: 32, workflowBudgetMs: 3_300_000, researchBudgetMs: 2_100_000, recapResearchRoles: {} };
      const target = f.envelope.sectorPerformance[0].symbol;
      const verified = { sources: [{ id: "saved-fact", scope: "sector", targets: [target], url: "https://www.sec.gov/saved-test-original", kind: "official", role: "facts", sourceLabel: "SEC", publishedAt: `${f.envelope.marketAsOf}T19:00:00Z`, facts: "上一批已核实并保存的订单事实。" }] };
      await workflow.savePrivateRecapDraft({ verifiedLedger: verified, validatedRecap: validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social) });
      const previous = structuredClone(workflow.manifest.privateRecapDraft);
      const resumed = new MarketWorkflow(options);
      resumed.manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8"));
      resumed.runAgent = async () => { throw new Error("Private resume must never invoke an agent"); };
      await resumed.savePrivateRecapDraft();
      assert.deepEqual(resumed.manifest.privateRecapDraft, previous);
      await resumed.savePrivateRecapDraft({ verifiedLedger: { sources: [] } });
      const current = resumed.manifest.privateRecapDraft;
      const draft = JSON.parse(await readFile(resolve(resumed.runDir, current.artifact), "utf8"));
      const text = await readFile(resolve(resumed.runDir, current.markdownArtifact), "utf8");
      assert.match(text, /上一批已核实并保存的订单事实/);
      assert.match(text, /本次尚待重新核准/);
      assert.equal(draft.entries.find(entry => entry.target === target).why, f.raw.entries.find(entry => entry.target === target).why);
      assert.equal(resumed.manifest.searchQueryCount, 32);
      assert.equal(resumed.manifest.workflowBudgetMs, 3_300_000);
      assert.equal(resumed.manifest.researchBudgetMs, 2_100_000);
      assert.equal(resumed.manifest.recapApproval, undefined);
      assert.equal(resumed.manifest.reportPath, undefined);
      assert.deepEqual(resumed.manifest.recapResearchRoles, {});
      assert.equal(await readFile(resolve(resumed.runDir, previous.markdownArtifact), "utf8"), JSON.parse(await readFile(resolve(resumed.runDir, previous.artifact), "utf8")).markdown);
      allTargets.push(...draft.entries.map(entry => `${market}:${entry.target}`));
      await writeFile(resolve(resumed.runDir, current.markdownArtifact), `${text}\nTAMPERED_PRIVATE_COPY`);
      const damagedResume = new MarketWorkflow(options);
      damagedResume.manifest = JSON.parse(await readFile(resumed.manifestPath, "utf8"));
      await assert.rejects(damagedResume.savePrivateRecapDraft(), /内容或交易日发生变化/);
      damagedResume.manifest.implementation = { hash: "historical-source-pin" };
      await assert.rejects(damagedResume.savePrivateRecapDraft(), /另一源码版本/);
    }
    assert.equal(new Set(allTargets).size, 40);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("single-market updates preserve the approved inactive recap exactly", () => {
  const f = recapFixture("CN");
  const recap = validateCompleteRecap(f.raw, f.envelope, f.ledger, f.social);
  const empty = { marketAsOf: { CN: f.envelope.marketAsOf, US: f.envelope.marketAsOf }, marketViews: {}, aiChainViews: {}, markets: [], marketSessions: [], sectorPerformance: [], aiChainPerformance: [], sectorHeat: [], drivers: [], aiChainUpdates: [], translations: { en: { marketViews: {}, aiChainViews: {}, drivers: [], aiChainUpdates: [] } } };
  const merged = preserveInactiveStoredSlice(empty, { ...empty, recaps: { CN: recap } }, "US");
  assert.deepEqual(merged.recaps.CN, recap);
});

test("known sector ETF queries retain market context; abstract baskets do not", () => {
  const f = recapFixture();
  const anomaly = f.plan.anomalies.find(item => item.kind === "sector");
  const output = { contractVersion: "stock-daily-evidence-worker-v1", role: "causal", market: "US", anomalyId: anomaly.id, outcome: "none", queries: [...anomaly.causalQueries, `${anomaly.target} August 21 2026 market close demand`], sources: [], alternatives: [{ claim: "Demand changes may affect this sector.", status: "unresolved", sourceUrls: [] }] };
  assert.doesNotThrow(() => validateResearchOutput(output, "causal", anomaly, f.envelope));
  output.queries[1] = "August 21 2026 mystery market demand";
  assert.throws(() => validateResearchOutput(output, "causal", anomaly, f.envelope), /市场或跨市场标记/);
  const layer = f.plan.anomalies.find(item => item.kind === "ai_layer");
  f.envelope.aiChainPerformance.find(item => item.symbol === layer.target).constituents[0].symbol = "LITE";
  const layerOutput = { ...output, anomalyId: layer.id, queries: [...layer.causalQueries, "LITE August 21 2026 earnings price reaction"] };
  assert.doesNotThrow(() => validateResearchOutput(layerOutput, "causal", layer, f.envelope));
  layerOutput.queries[1] = "UNKNOWN August 21 2026 earnings price reaction";
  assert.throws(() => validateResearchOutput(layerOutput, "causal", layer, f.envelope), /市场或跨市场标记/);
});

test("CLI compatibility passes only feature switches present in the installed binary", () => {
  assert.deepEqual(compatibleFeatureArgs("plugins stable true\napps stable true\ntui_app_server removed true\n"), ["--disable", "plugins", "--disable", "apps", "--disable", "tui_app_server"]);
  assert.ok(!compatibleFeatureArgs("plugins stable true\n").includes("recommended_plugins"));
});

test("publication cannot bypass comprehensive artifact verification", async () => {
  const implementation = await workflowImplementationSnapshot();
  const f = recapFixture();
  await assert.rejects(auditWorkflowCausalEvidence({ manifest: { coverageRequired: true, implementation }, report: {}, manifestPath: "/tmp/missing-recap/manifest.json", input: fixtureInput() }), /ENOENT/);
  await assert.rejects(auditWorkflowCausalEvidence({ manifest: { coverageRequired: true, implementation }, report: {}, manifestPath: "/tmp/missing-recap/manifest.json" }), /行情输入/);
});

test("an exchange-hosted article cannot masquerade as an official issuer disclosure", () => {
  assert.equal(verifiedExternalSourceType("https://www.nasdaq.com/articles/company-earnings-commentary"), "publisher");
  assert.equal(verifiedExternalSourceType("https://www.nasdaq.com/market-activity/etf/xlk/historical"), "first_party");
});
