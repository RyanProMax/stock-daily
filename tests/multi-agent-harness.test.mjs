import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  AGENT_FILESYSTEM_ISOLATION,
  WORKFLOW_VERSION,
  advancedMarkets,
  auditWorkflowManifest,
  bodySupportsDeterministicTarget,
  assertMaterialEarningsContext,
  eligibleCrossMarketLeads,
  hasCausalPassage,
  marketEnvelope,
  marketInputHash,
  marketEvidence,
  mergeMarketReport,
  parseAgentEvents,
  publicComparison,
  requiresFinancialComparisons,
  researchMarketEnvelope,
  stableHash,
  validateAdjudication,
  validatePlan,
  validateResearchOutput,
  validateReview,
  validateTranslation,
  validateWriterDraft,
  verifyResearchSources,
} from "../scripts/daily-workflow-core.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";
import { validateReport } from "../scripts/daily-publish.mjs";
import {
  MarketWorkflow,
  agentStageFingerprint,
  readerClaimCards,
  agentIsolationProfile,
  assertResearchBatchBudget,
  assertFreshRepairQueries,
  budgetedReviewerResearchFailures,
  filterHandledMarkets,
  normalizeEmptyDraftViews,
  prepareIsolatedCodexHome,
  preservePassedAdjudication,
  rejectAdjudicationClaims,
  researchRepairFitsBudget,
  restorePassedDraftItems,
  scopedRepairContext,
  selectResearchRepair,
  selectWorkflowMarkets,
  settleAgentResults,
  shouldAttemptResearchRepair,
  workflowBatchStatus,
  supplementResearchOutputs,
  unavailableResearchSourceUrls,
  researchSourceAvailability,
} from "../scripts/daily-workflow.mjs";
import { publishableExternalSourceDomains, verifiedExternalSourceLabel } from "../scripts/source-registry.mjs";
import {
  evaluateReplayAcceptance,
  publishedCardSummary,
  selectLatestReplayRuns,
  summarizeReplayAcceptance,
} from "../scripts/daily-workflow-acceptance.mjs";

const execFileAsync = promisify(execFile);

test("adjudication alternatives cannot become approved reader or reviewer facts", async () => {
  const cards = [{ id: "oil-rebound", causalStatement: "Lower oil supported stocks", evidenceIds: ["oil-facts", "oil-cause"], comparisons: [], alternativeAssessment: "Bargain hunting might amplify the rebound but is not in the attached evidence" }];
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US" });
  workflow.readerEvidence = () => [];
  workflow.readerNumberGrounding = () => ({});
  workflow.runValidatedAgentStage = async ({ payload }) => payload;
  const payload = await workflow.reviewDraft(cards, {}, {}, 1);
  assert.doesNotMatch(JSON.stringify(payload.claimCards), /bargain hunting|alternativeAssessment/iu);
  assert.equal(payload.claimCards[0].causalStatement, cards[0].causalStatement);
  const writerCards = readerClaimCards(cards);
  writerCards[0].evidenceIds.push("new");
  assert.deepEqual(cards[0].evidenceIds, ["oil-facts", "oil-cause"]);
  assert.match(cards[0].alternativeAssessment, /Bargain hunting/u);
});

test("broad-market planning permits publisher-neutral completed-session discovery", () => {
  const plan = planFixture();
  plan.anomalies[1].factQueries = ["US 2026-08-21 10-year Treasury yield market close"];
  plan.anomalies[1].causalQueries = ["US 2026-08-21 10-year Treasury yield stock market today"];
  assert.doesNotThrow(() => validatePlan(plan, marketEnvelope(fixtureInput(), "US")));
});

test("targeted research supplements verified passages while discarding old rejected candidates", () => {
  const oldFact = { originalUrl: "https://publisher.example/oil", facts: "Verified oil price decline", role: "facts", anomalyId: "market" };
  const rejectedFact = { ...oldFact, originalUrl: "https://blocked.example/event" };
  const oldCause = { ...oldFact, role: "causal", facts: "Oil decline supported stocks" };
  const unchanged = { anomalyId: "other", role: "facts", sources: [{ facts: "Other anomaly" }] };
  const old = [{ anomalyId: "market", role: "facts", sources: [oldFact, rejectedFact], rejectedSources: [{ reason: "HTTP 403" }] }, { anomalyId: "market", role: "causal", sources: [oldCause] }, unchanged];
  const ledger = { sources: [oldFact, oldCause].map(source => ({ candidateHash: stableHash(source) })) };
  const repair = [{ anomalyId: "market", role: "facts", sources: [] }];
  const combined = supplementResearchOutputs(old, repair, ledger);
  assert.deepEqual(combined[0].sources, [oldFact]);
  assert.deepEqual(combined[0].rejectedSources, []);
  assert.equal(combined[1], old[1]);
  assert.equal(combined[2], unchanged);
  assert.equal(combined[3], repair[0]);
  old[0].sources[0] = { ...oldFact, facts: "Changed unverified fact" };
  assert.equal(supplementResearchOutputs(old, repair, ledger).length, 3);
});

test("same-session retries learn inaccessible URLs only from intact verified ledgers", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-access-hints-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = { market: "US", marketAsOf: "2026-09-11", inputHash: "frozen-input" };
  const ledger = { rejected: [
    { url: "https://apnews.com/article/blocked", reason: "HTTP 403" },
    { url: "https://apnews.com/article/another", reason: "HTTP 403" },
    { url: "https://kiplinger.com/article/fixable", reason: "支持段落无法在来源正文中定位" },
    { url: "https://m.21jingji.com/article/metadata", reason: "未找到文章级发布时间" },
  ] };
  for (const name of ["valid", "changed-market", "tampered"]) {
    const dir = resolve(root, name);
    await mkdir(resolve(dir, "artifacts"), { recursive: true });
    await writeFile(resolve(dir, "manifest.json"), JSON.stringify({ ...expected, market: name === "changed-market" ? "CN" : "US", stages: { "evidence-verification-test": { status: "completed", outputHash: stableHash(ledger) } } }));
    await writeFile(resolve(dir, "artifacts/evidence-ledger.json"), JSON.stringify(name === "tampered" ? { rejected: [{ url: "https://reuters.com/article/changed", reason: "HTTP 403" }] } : ledger));
  }
  assert.deepEqual(await unavailableResearchSourceUrls(root, expected), ["https://apnews.com/article/another", "https://apnews.com/article/blocked"]);
  assert.deepEqual((await researchSourceAvailability(root, expected)).unavailableDomains, ["apnews.com"]);
  assert.deepEqual(await unavailableResearchSourceUrls(root, { ...expected, inputHash: "new-input" }), []);
});

test("a resumed run freezes source access hints so its own failures do not change completed research inputs", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-frozen-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { input: fixtureInput(), market: "US", previousReport: null, codexBin: "/unused/codex", workRoot: root };
  const first = new MarketWorkflow(options);
  await first.initialize();
  const ledger = { rejected: [{ url: "https://apnews.com/article/newly-blocked", reason: "HTTP 403" }] };
  first.manifest.stages["evidence-verification-test"] = { status: "completed", outputHash: stableHash(ledger) };
  await writeFile(resolve(first.runDir, "artifacts/evidence-ledger.json"), JSON.stringify(ledger));
  await first.saveManifest();
  const resumed = new MarketWorkflow(options);
  await resumed.initialize();
  assert.deepEqual(resumed.excludedSources, []);
  assert.deepEqual(resumed.manifest.sourceAccess, first.manifest.sourceAccess);
});

function planFixture() {
  return {
    contractVersion: "stock-daily-market-plan-v1",
    market: "US",
    marketAsOf: "2026-08-21",
    anomalies: [
      {
        id: "US-EARNINGS",
        kind: "company",
        target: "US-XLB-0",
        title: "代表公司财报后上涨",
        direction: "positive",
        observedMove: "代表公司收盘上涨 +1.00%",
        researchQuestion: "财报中的哪些可核实数据推动该公司上涨？",
        hypotheses: [
          { id: "H-EARNINGS", claim: "财报超出市场预期", category: "company_event" },
          { id: "H-SECTOR", claim: "行业整体共振带动", category: "industry_supply_demand" },
          { id: "H-POSITION", claim: "空头回补或仓位调整", category: "positioning" },
        ],
        factQueries: ["US 2026-08-21 US-XLB-0 Representative 1 earnings actual consensus"],
        causalQueries: ["US 2026-08-21 US-XLB-0 Representative 1 shares rose after earnings"],
      },
      {
        id: "US-BROAD",
        kind: "market",
        target: "DGS10",
        title: "美国十年期国债收益率上涨",
        direction: "positive",
        observedMove: "美国十年期国债收益率上涨 +5 bp",
        researchQuestion: "哪些可核实因素直接推动美国十年期国债收益率上涨？",
        hypotheses: [
          { id: "H-MACRO", claim: "宏观数据推动利率重新定价", category: "macro_policy" },
          { id: "H-SUPPLY", claim: "债券供给变化推高期限溢价", category: "industry_supply_demand" },
          { id: "H-ALT", claim: "仓位调整放大收益率变动", category: "alternative" },
        ],
        factQueries: ["US 2026-08-21 DGS10 10-year Treasury yield policy data AP Reuters Yahoo Finance"],
        causalQueries: ["US 2026-08-21 DGS10 10-year Treasury yield market wrap AP Reuters Yahoo Finance"],
      },
      {
        id: "US-FALLBACK",
        kind: "sector",
        target: "XLC",
        title: "通信服务板块上涨",
        direction: "positive",
        observedMove: "通信服务板块收盘上涨 +2.20%",
        researchQuestion: "哪些可验证事件直接推动通信服务板块上涨？",
        hypotheses: [
          { id: "H-COMPANY", claim: "权重公司事件带动板块", category: "company_event" },
          { id: "H-DEMAND", claim: "广告或通信需求改善", category: "industry_supply_demand" },
          { id: "H-ROTATION", claim: "资金轮动形成相对收益", category: "positioning" },
        ],
        factQueries: ["US 2026-08-21 XLC Communication Services company event"],
        causalQueries: ["US 2026-08-21 XLC Communication Services market wrap cause"],
      },
    ],
  };
}

function researchFixture(role, anomaly, envelope) {
  const factsUrl = "https://www.reuters.com/markets/company-results";
  const causalUrl = "https://www.kiplinger.com/investing/market-recap";
  const sourceUrl = role === "facts" ? factsUrl : causalUrl;
  return {
    contractVersion: "stock-daily-evidence-worker-v1",
    role,
    market: "US",
    anomalyId: anomaly.id,
    outcome: "found",
    queries: [
      role === "facts" ? anomaly.factQueries[0] : anomaly.causalQueries[0],
      role === "facts"
        ? "US 2026-08-21 US-XLB-0 Representative 1 revenue EPS consensus filing"
        : "US 2026-08-21 US-XLB-0 Representative 1 earnings reaction market close",
    ],
    sources: [
      {
        url: sourceUrl,
        sourceLabel: role === "facts" ? "Reuters" : "Kiplinger",
        title: role === "facts" ? "Company reports results" : "Stocks close higher",
        publishedAt:
          role === "facts"
            ? "2026-08-21T12:00:00.000Z"
            : "2026-08-21T20:30:00.000Z",
        kind: role === "facts" ? "event" : "market_wrap",
        supportingExcerpt:
          role === "facts"
            ? "Revenue was $68.1B versus a consensus estimate of $66.2B, while adjusted EPS was $1.05 versus $1.01 expected."
            : "Representative 1 shares rose after the company reported revenue and adjusted earnings above Wall Street expectations, prompting buying into the close.",
        facts:
          role === "facts"
            ? "公司披露收入与调整后每股收益均高于市场一致预期。"
            : "收盘报道明确把公司股价上涨与高于预期的收入和盈利联系起来。",
        scope: "company",
        targets: ["US-XLB-0"],
        hypothesisIds: ["H-EARNINGS"],
        causalConnection: role === "causal",
        comparisons:
          role === "facts"
            ? [
                {
                  label: "季度收入",
                  actualValue: 68.1,
                  actualDisplay: "$68.1B",
                  baselineLabel: "市场预期",
                  baselineValue: 66.2,
                  baselineDisplay: "$66.2B",
                  unit: "billion_usd",
                  higherIsPositive: true,
                  note: "",
                  sourceUrl,
                },
                {
                  label: "调整后每股收益",
                  actualValue: 1.05,
                  actualDisplay: "$1.05",
                  baselineLabel: "市场预期",
                  baselineValue: 1.01,
                  baselineDisplay: "$1.01",
                  unit: "usd",
                  higherIsPositive: true,
                  note: "",
                  sourceUrl,
                },
              ]
            : [],
      },
    ],
    alternatives: [
      {
        claim: "板块共振也可能贡献部分涨幅",
        status: "unresolved",
        sourceUrls: [],
      },
    ],
  };
}

async function verifiedFixture() {
  const input = fixtureInput();
  const envelope = marketEnvelope(input, "US");
  const fullPlan = planFixture();
  const plan = { ...fullPlan, anomalies: fullPlan.anomalies.slice(0, 2) };
  const anomaly = plan.anomalies[0];
  const facts = validateResearchOutput(
    researchFixture("facts", anomaly, envelope),
    "facts",
    anomaly,
    envelope,
  );
  const causal = validateResearchOutput(
    researchFixture("causal", anomaly, envelope),
    "causal",
    anomaly,
    envelope,
  );
  const pages = new Map([
    [facts.sources[0].originalUrl, facts.sources[0]],
    [causal.sources[0].originalUrl, causal.sources[0]],
  ]);
  const ledger = await verifyResearchSources([facts, causal], envelope, {
    reader: async (url) => {
      const source = pages.get(url);
      return {
        finalUrl: url,
        status: 200,
        contentType: "text/html",
        text: `Article heading for Representative 1. ${source.supportingExcerpt} Additional verified article body for deterministic validation.`,
        publishedAtCandidates: [source.publishedAt],
      };
    },
  });
  return { input, envelope, plan, ledger };
}

function acceptedAdjudicationFixture(plan, ledger) {
  const fact = ledger.sources.find((item) => item.role === "facts");
  const causal = ledger.sources.find((item) => item.role === "causal");
  return {
    contractVersion: "stock-daily-adjudication-v1",
    market: "US",
    decisions: [
      {
        anomalyId: "US-EARNINGS",
        verdict: "accepted",
        publishedAs: "market_driver",
        reason: "事实和收盘因果报道相互独立且目标一致。",
      },
      {
        anomalyId: "US-BROAD",
        verdict: "unresolved",
        publishedAs: "none",
        reason: "没有足够证据建立大盘层面的直接归因。",
      },
    ],
    claimCards: [
      {
        anomalyId: "US-EARNINGS",
        publishedAs: "market_driver",
        basis: "event",
        direction: "positive",
        scope: "company",
        targets: ["US-XLB-0"],
        sectorSymbols: ["XLB"],
        layer: "",
        title: "收入与盈利双双超预期推动公司上涨",
        factSummary: "公司季度财报披露的收入和调整后每股收益均超过市场一致预期。",
        causalStatement: "独立收盘报道明确指出，投资者在收入和调整后盈利高于华尔街预期后买入该公司股票，直接推动其当日上涨。",
        evidenceIds: [fact.id, causal.id],
        comparisonIds: fact.comparisons.map((item) => item.id),
        alternativeAssessment: "行业共振仍可能贡献部分涨幅，但现有直接报道指向公司财报。",
      },
    ],
  };
}

test("evidence workers are isolated and source facts are deterministically verified", async () => {
  const { ledger } = await verifiedFixture();
  assert.equal(ledger.sources.length, 2);
  assert.deepEqual(new Set(ledger.sources.map((item) => item.role)), new Set(["facts", "causal"]));
  assert.equal(ledger.sources.flatMap((item) => item.comparisons).length, 2);
  assert.equal(ledger.rejected.length, 0);
  assert.equal(ledger.alternatives[0].status, "unresolved");
});

test("causal research cannot skip competing-explanation checks", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("causal", anomaly, envelope);
  raw.alternatives = [];
  assert.throws(
    () => validateResearchOutput(raw, "causal", anomaly, envelope),
    /竞争解释/u,
  );
});

test(
  "outer Agent sandbox can read only its own stage files",
  { skip: process.platform !== "darwin" },
  async () => {
    const sandboxRoot = resolve(tmpdir(), "stock-daily-agent-sandboxes");
    await mkdir(sandboxRoot, { recursive: true });
    const sandboxDir = await mkdtemp(resolve(sandboxRoot, "isolation-test-"));
    const runDir = await mkdtemp(resolve(tmpdir(), "stock-daily-run-secret-"));
    const homeDir = await mkdtemp(resolve(tmpdir(), "stock-daily-home-secret-"));
    const codexHome = resolve(homeDir, ".codex");
    await mkdir(codexHome, { recursive: true });
    const allowedPath = resolve(sandboxDir, "allowed.txt");
    const credentialPath = resolve(codexHome, "auth.json");
    const unrelatedCodexPath = resolve(codexHome, "history.jsonl");
    const runtimeBin = resolve(homeDir, ".nvm/versions/node/test/bin");
    const codexBin = resolve(runtimeBin, "codex");
    const nodeBin = resolve(runtimeBin, "node");
    const codexPackageBin = resolve(
      homeDir,
      ".nvm/versions/node/test/lib/node_modules/@openai/codex/bin/codex.js",
    );
    const homeSecretPath = resolve(homeDir, "unrelated-user-file.txt");
    const deniedPath = resolve(runDir, "sibling-artifact.json");
    await Promise.all([
      mkdir(dirname(codexBin), { recursive: true }),
      mkdir(dirname(codexPackageBin), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(allowedPath, "allowed", "utf8"),
      writeFile(credentialPath, "runtime", "utf8"),
      writeFile(unrelatedCodexPath, "private history", "utf8"),
      writeFile(
        codexPackageBin,
        "#!/usr/bin/env node\nprocess.stdout.write('codex-ran');\n",
        "utf8",
      ),
      writeFile(homeSecretPath, "private", "utf8"),
      writeFile(deniedPath, "secret", "utf8"),
    ]);
    await Promise.all([
      chmod(codexPackageBin, 0o700),
      symlink(codexPackageBin, codexBin),
      symlink(process.execPath, nodeBin),
    ]);
    const isolatedCodexHome = await prepareIsolatedCodexHome({
      sandboxDir,
      sourceCodexHome: codexHome,
    });
    const isolatedCredentialPath = resolve(isolatedCodexHome, "auth.json");
    const profile = agentIsolationProfile({
      sandboxDir,
      runDir,
      homeDir,
      codexBin,
      pathValue: runtimeBin,
    });
    try {
      const allowed = await execFileAsync("/usr/bin/sandbox-exec", [
        "-p",
        profile,
        "/bin/cat",
        allowedPath,
      ]);
      assert.equal(allowed.stdout, "allowed");
      const credential = await execFileAsync("/usr/bin/sandbox-exec", [
        "-p",
        profile,
        "/bin/cat",
        isolatedCredentialPath,
      ]);
      assert.equal(credential.stdout, "runtime");
      await assert.rejects(
        () =>
          execFileAsync("/usr/bin/sandbox-exec", [
            "-p",
            profile,
            "/bin/cat",
            credentialPath,
          ]),
        /Operation not permitted/u,
      );
      await assert.rejects(
        () =>
          execFileAsync("/usr/bin/sandbox-exec", [
            "-p",
            profile,
            "/bin/cat",
            unrelatedCodexPath,
          ]),
        /Operation not permitted/u,
      );
      const executable = await execFileAsync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, codexBin],
        { cwd: sandboxDir, env: { ...process.env, PATH: runtimeBin } },
      );
      assert.equal(executable.stdout, "codex-ran");
      await assert.rejects(
        () =>
          execFileAsync("/usr/bin/sandbox-exec", [
            "-p",
            profile,
            "/bin/cat",
            homeSecretPath,
          ]),
        /Operation not permitted/u,
      );
      await assert.rejects(
        () =>
          execFileAsync("/usr/bin/sandbox-exec", [
            "-p",
            profile,
            "/bin/cat",
            deniedPath,
          ]),
        /Operation not permitted/u,
      );
      await assert.rejects(
        () =>
          execFileAsync("/usr/bin/sandbox-exec", [
            "-p",
            profile,
            "/bin/cat",
            resolve(process.cwd(), "package.json"),
          ]),
        /Operation not permitted/u,
      );
    } finally {
      await Promise.all([
        rm(sandboxDir, { recursive: true, force: true }),
        rm(runDir, { recursive: true, force: true }),
        rm(homeDir, { recursive: true, force: true }),
      ]);
    }
  },
);

test("one malformed source is rejected without discarding the market run", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].publishedAt = "2026-08-21 12:00";
  const result = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.equal(result.outcome, "limited");
  assert.equal(result.sources.length, 0);
  assert.equal(result.rejectedSources.length, 1);
  assert.match(result.rejectedSources[0].reason, /长度|带时区的时间/);
});

test("verified facts cannot introduce a number absent from the source excerpt", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].facts += " Reported backlog was $999 billion.";
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  const ledger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `Representative 1. ${facts.sources[0].supportingExcerpt}`,
      publishedAtCandidates: [facts.sources[0].publishedAt],
    }),
  });
  assert.equal(ledger.sources.length, 0);
  assert.match(ledger.rejected[0].reason, /999/);
});

test("price-only causal candidates are rejected before adjudication and cannot reuse a cached approval", async () => {
  assert.equal(hasCausalPassage("The moves indicate investors pricing a more credible Fed."), true);
  assert.equal(hasCausalPassage("Yields rose following the policy speech."), true);
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("causal", anomaly, envelope);
  raw.sources[0].supportingExcerpt = "Representative 1 shares rose. Other stocks in the index rose, and the index also closed higher.";
  const output = validateResearchOutput(raw, "causal", anomaly, envelope);
  const candidateHash = stableHash(output.sources[0]);
  const result = await verifyResearchSources([output], envelope, { verifiedCache: new Map([[candidateHash, { ...output.sources[0], candidateHash, comparisonNotesChecked: true }]]), reader: async () => { throw new Error("Must reject before network access"); } });
  assert.equal(result.sources.length, 0);
  assert.match(result.rejected[0].reason, /仅并列行情/u);
});

test("comparison-note numbers are verified, preserved in report evidence and invalidate unchecked caches", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].comparisons[0].note = "同比增长11%。";
  raw.sources[0].supportingExcerpt += " Representative 1 reported revenue growth of 11%.";
  const output = validateResearchOutput(raw, "facts", anomaly, envelope);
  let reads = 0;
  const reader = async (url) => { reads++; return { finalUrl: url, status: 200, contentType: "text/html", text: output.sources[0].supportingExcerpt, publishedAtCandidates: [output.sources[0].publishedAt] }; };
  const verifiedCache = new Map();
  const ledger = await verifyResearchSources([output], envelope, { reader, verifiedCache });
  assert.equal(ledger.sources.length, 1);
  assert.equal(ledger.sources[0].scope, "company");
  assert.equal(ledger.sources[0].earningsContextChecked, true);
  assert.equal(ledger.sources[0].comparisonNotesChecked, true);
  const source = ledger.sources[0];
  const card = { id: "test", targets: ["US-XLB-0"], sectorSymbols: ["XLB"], evidenceIds: [source.id], comparisons: source.comparisons.map(publicComparison) };
  const draft = { overviewHeadline: "公司财报", overviewSummary: "收入改善", marketView: {}, aiChainView: {}, drivers: [{ claimId: card.id, title: "收入改善", metrics: card.comparisons }], aiChainUpdates: [] };
  const translation = { ...draft, marketView: {}, aiChainView: {} };
  const report = mergeMarketReport(fixtureInput(), "US", null, [card], ledger, draft, translation);
  assert.match(report.drivers[0].evidence.find((item) => item.source === source.url).facts, /同比增长11%/u);
  delete verifiedCache.get(source.candidateHash).earningsContextChecked;
  await verifyResearchSources([output], envelope, { reader, verifiedCache });
  assert.equal(reads, 2);
  delete verifiedCache.get(source.candidateHash).comparisonNotesChecked;
  await verifyResearchSources([output], envelope, { reader, verifiedCache });
  assert.equal(reads, 3);
  await verifyResearchSources([output], envelope, { reader, verifiedCache });
  assert.equal(reads, 3);
  raw.sources[0].comparisons[0].note = "同比增长999%。";
  const rejected = await verifyResearchSources([validateResearchOutput(raw, "facts", anomaly, envelope)], envelope, { reader });
  assert.equal(rejected.sources.length, 0);
  assert.match(rejected.rejected[0].reason, /999/);
});

test("verified fact numbers retain the source unit and direction", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  async function rejectedReason(factsText, excerpt) {
    const raw = researchFixture("facts", anomaly, envelope);
    raw.sources[0].comparisons = [];
    raw.sources[0].facts = factsText;
    raw.sources[0].supportingExcerpt = excerpt;
    const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
    const ledger = await verifyResearchSources([facts], envelope, {
      reader: async (url) => ({
        finalUrl: url,
        status: 200,
        contentType: "text/html",
        text: excerpt,
        publishedAtCandidates: [facts.sources[0].publishedAt],
      }),
    });
    assert.equal(ledger.sources.length, 0);
    return ledger.rejected[0].reason;
  }
  assert.match(
    await rejectedReason(
      "Representative 1 reported that quarterly revenue rose by $3 billion.",
      "Representative 1 shares fell 3% during the completed trading session.",
    ),
    /单位和方向/u,
  );
  assert.match(
    await rejectedReason(
      "Representative 1 shares rose 3% during the completed trading session.",
      "Representative 1 shares fell 3% during the completed trading session.",
    ),
    /单位和方向/u,
  );
});

test("plural drop wording preserves a negative percentage direction", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].supportingExcerpt =
    "Drops of 5.8% for Micron Technology helped drag the index lower.";
  raw.sources[0].facts = "Micron Technology dropped 5.8% during the session.";
  raw.sources[0].comparisons = [];
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  const ledger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: facts.sources[0].supportingExcerpt,
      publishedAtCandidates: [facts.sources[0].publishedAt],
    }),
  });
  assert.equal(ledger.sources.length, 1);
});

test("publisher-inserted rights marker does not break an exact excerpt", async () => {
  const { envelope, anomaly } = {
    envelope: marketEnvelope(fixtureInput(), "US"),
    anomaly: planFixture().anomalies[0],
  };
  const facts = validateResearchOutput(
    researchFixture("facts", anomaly, envelope),
    "facts",
    anomaly,
    envelope,
  );
  const source = facts.sources[0];
  const body = source.supportingExcerpt.replace(/\s+/u, "（维权） ");
  const ledger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: body,
      publishedAtCandidates: [source.publishedAt],
    }),
  });
  assert.equal(ledger.sources.length, 1);
});

test("exact excerpts can span article sections but cannot invent a short intervening sentence", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const first = "Oil prices eased as the market recovered.";
  const last = "Representative 1 participated in the wider market rebound.";
  const body = `${first} ${"Other documented article context. ".repeat(100)} ${last}`;
  for (const [excerpt, accepted] of [[`${first}\n${last}`, true], [`${last}\n${first}`, false], [`${first}\nJobs fell.\n${last}`, false]]) {
    const raw = researchFixture("facts", anomaly, envelope);
    raw.sources[0].supportingExcerpt = excerpt;
    raw.sources[0].facts = first;
    raw.sources[0].comparisons = [];
    const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
    const ledger = await verifyResearchSources([facts], envelope, { reader: async url => ({ finalUrl: url, status: 200, text: body, contentType: "text/html", publishedAtCandidates: [raw.sources[0].publishedAt] }) });
    assert.equal(ledger.sources.length, accepted ? 1 : 0, excerpt);
  }
});

test("verified financial comparisons bind values to the declared unit", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].supportingExcerpt =
    "Representative 1 reported a 2.5 basis-point move versus 2.0 basis points expected, while adjusted EPS was $1.05 versus $1.01 expected.";
  raw.sources[0].comparisons[0] = {
    ...raw.sources[0].comparisons[0],
    actualValue: 2.5,
    actualDisplay: "$2.5B",
    baselineValue: 2,
    baselineDisplay: "$2.0B",
  };
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  const ledger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: facts.sources[0].supportingExcerpt,
      publishedAtCandidates: [facts.sources[0].publishedAt],
    }),
  });
  assert.equal(ledger.sources.length, 0);
  assert.match(ledger.rejected[0].reason, /声明单位/u);
});

test("one malformed financial comparison is dropped without discarding valid source facts", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].comparisons[0].actualDisplay = "$68.1M";
  raw.sources[0].comparisons[0].baselineDisplay = "$66.2M";
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.equal(facts.sources.length, 1);
  assert.equal(facts.sources[0].comparisons.length, 1);
  assert.match(facts.rejectedSources[0].reason, /金额后缀/);
});

test("official release comparison displays accept written percent and basis-point units", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  for (const [unit, actualDisplay, baselineDisplay] of [
    ["percent", "0.4 percent", "0.1-percent"],
    ["basis_points", "0.4 basis points", "0.1 basis-point"],
  ]) {
    const raw = researchFixture("facts", anomaly, envelope);
    raw.sources[0].facts = `The reported reading was ${actualDisplay} versus ${baselineDisplay} previously.`;
    raw.sources[0].supportingExcerpt = raw.sources[0].facts;
    raw.sources[0].comparisons = [{ ...raw.sources[0].comparisons[0], label: "Reported reading", actualValue: 0.4, actualDisplay, baselineValue: 0.1, baselineDisplay, unit }];
    const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
    assert.equal(facts.sources[0].comparisons.length, 1);
    const ledger = await verifyResearchSources([facts], envelope, { reader: async url => ({ finalUrl: url, status: 200, text: raw.sources[0].facts, contentType: "text/html", publishedAtCandidates: [raw.sources[0].publishedAt] }) });
    assert.equal(ledger.sources.length, 1, JSON.stringify(ledger.rejected));
    raw.sources[0].comparisons[0].actualDisplay = "0.4 percentage points";
    assert.equal(validateResearchOutput(raw, "facts", anomaly, envelope).sources[0].comparisons.length, 0);
  }
});

test("unscaled USD comparisons reject written billion and million scales", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].comparisons[1] = {
    ...raw.sources[0].comparisons[1],
    actualValue: 3,
    actualDisplay: "$3 billion",
    baselineValue: 2,
    baselineDisplay: "$2 billion",
    unit: "usd",
  };
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.equal(facts.sources[0].comparisons.length, 1);
  assert.match(facts.rejectedSources[0].reason, /金额后缀/u);
});

test("unscaled CNY comparisons reject scaled Renminbi displays", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].comparisons[1] = {
    ...raw.sources[0].comparisons[1],
    actualValue: 113.5,
    actualDisplay: "人民币113.5亿元",
    baselineValue: 113.2,
    baselineDisplay: "人民币113.2亿元",
    unit: "cny",
  };
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.equal(facts.sources[0].comparisons.length, 1);
  assert.match(facts.rejectedSources[0].reason, /金额后缀/u);
});

test("typed financial values bind to the number carrying the declared unit", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].comparisons[0].actualValue = 2;
  raw.sources[0].comparisons[0].actualDisplay = "$10B in Q2";
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.equal(facts.sources[0].comparisons.length, 1);
  assert.match(facts.rejectedSources[0].reason, /显示值与类型化数值不一致/u);
});

test("explicit UTC timestamps are accepted and normalized", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].publishedAt = "2026-08-21 12:00:00 UTC";
  const result = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.equal(result.sources[0].publishedAt, "2026-08-21T12:00:00.000Z");
});

test("hyphenated basis-point prose preserves the same numeric unit as the excerpt", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].scope = "event_only";
  raw.sources[0].comparisons = [];
  raw.sources[0].facts = "Futures traders are pricing in a 25-basis-point rate change next week.";
  raw.sources[0].supportingExcerpt = "Futures traders are pricing in a rate change of 25 basis points next week.";
  const check = async () => {
    const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
    return verifyResearchSources([facts], envelope, { reader: async (url) => ({
      finalUrl: url, text: raw.sources[0].supportingExcerpt, publishedAtCandidates: [raw.sources[0].publishedAt],
    }) });
  };
  assert.equal((await check()).sources.length, 1);
  raw.sources[0].facts = "Futures traders are pricing in a 25% rate change next week.";
  assert.equal((await check()).sources.length, 0);
  raw.sources[0].supportingExcerpt = "Futures traders are pricing in an 86% probability the Fed will hike rates by 25 basis points next week, up from 71% one day ago.";
  raw.sources[0].facts = "The probability of a 25-basis-point Federal Reserve hike rose to 86% from 71% one day earlier.";
  assert.equal((await check()).sources.length, 1);
  raw.sources[0].facts = "The probability of a 25-basis-point Federal Reserve cut fell to 86% from 71% one day earlier.";
  assert.equal((await check()).sources.length, 0);
  raw.sources[0].supportingExcerpt = "超3600只个股下跌。在美国8月CPI公布后，加息概率从70%继续上行至90%。";
  raw.sources[0].facts = "超过3600只个股下跌；美国8月CPI公布后，加息概率由70%升至90%。";
  assert.equal((await check()).sources.length, 1);
  raw.sources[0].facts = "超过3600只个股上涨；美国8月CPI公布后，加息概率由70%降至90%。";
  assert.equal((await check()).sources.length, 0);
});

test("an adaptive Dow Jones query identifies the U.S. market without a redundant US token", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("causal", anomaly, envelope);
  raw.queries[1] = "2026-08-21 Dow Jones oil prices retreat inflation Reuters market close";
  assert.equal(validateResearchOutput(raw, "causal", anomaly, envelope).queries[1], raw.queries[1]);
  raw.queries[1] = "August 21, 2026 Dow Jones inflation market close";
  assert.equal(validateResearchOutput(raw, "causal", anomaly, envelope).queries[1], raw.queries[1]);
  raw.queries[1] = "2026年8月21日 美股 通胀与市场收盘";
  assert.equal(validateResearchOutput(raw, "causal", anomaly, envelope).queries[1], raw.queries[1]);
  raw.queries[1] = "2026-08-21 Representative 1 earnings market reaction";
  assert.equal(validateResearchOutput(raw, "causal", anomaly, envelope).queries[1], raw.queries[1]);
  raw.queries[0] = raw.queries[0].replace("2026-08-21", "2026-08-10");
  assert.throws(() => validateResearchOutput(raw, "causal", anomaly, envelope), /交易日/u);
  raw.queries[0] = raw.queries[0].replace("2026-08-10", "2026-08-21");
  raw.queries[1] = "2026-08-21 oil prices earnings";
  assert.throws(() => validateResearchOutput(raw, "causal", anomaly, envelope), /市场或跨市场标记/u);
});

test("source verification derives publication time from article metadata", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  const facts = validateResearchOutput(raw, "facts", anomaly, envelope);
  const unrelatedTimestamp = new Date(
    Date.parse(facts.sources[0].publishedAt) + 60 * 60 * 1_000,
  ).toISOString();
  const ledger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: facts.sources[0].supportingExcerpt,
      publishedAtCandidates: [unrelatedTimestamp],
    }),
  });
  assert.equal(ledger.sources.length, 1);
  assert.equal(ledger.sources[0].publishedAt, unrelatedTimestamp);
});

test("a repair retains an unchanged verified source when the publisher later has an outage", async () => {
  const envelope=marketEnvelope(fixtureInput(),"US");
  const anomaly=planFixture().anomalies[0];
  const raw=researchFixture("facts",anomaly,envelope);
  const output=validateResearchOutput(raw,"facts",anomaly,envelope);
  const verifiedCache=new Map();let reads=0;
  const reader=async url=>{reads++;if(reads>1)throw new Error("temporary outage");return {finalUrl:url,status:200,text:output.sources[0].supportingExcerpt,publishedAtCandidates:[output.sources[0].publishedAt]};};
  const first=await verifyResearchSources([output],envelope,{reader,verifiedCache});
  assert.equal(first.sources.length,1);
  const repaired=await verifyResearchSources([output],envelope,{reader,verifiedCache});
  assert.deepEqual(repaired.sources,first.sources);
  assert.equal(reads,1);
  raw.sources[0].facts += " 修改后的事实必须重新核验。";
  const changed=await verifyResearchSources([validateResearchOutput(raw,"facts",anomaly,envelope)],envelope,{reader,verifiedCache});
  assert.equal(changed.sources.length,0);
  assert.equal(reads,2);
});

test("source verification rejects article metadata outside the evidence window", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const facts = validateResearchOutput(
    researchFixture("facts", anomaly, envelope),
    "facts",
    anomaly,
    envelope,
  );
  const ledger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: facts.sources[0].supportingExcerpt,
      publishedAtCandidates: ["2026-08-30T12:00:00.000Z"],
    }),
  });
  assert.equal(ledger.sources.length, 0);
  assert.match(ledger.rejected[0].reason, /交易窗口/u);
});

test("Chinese display units are converted before typed comparison validation", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].comparisons[0] = {
    ...raw.sources[0].comparisons[0],
    actualValue: 11.35,
    actualDisplay: "113.5亿美元",
    baselineValue: 11.32,
    baselineDisplay: "113.2亿美元",
  };
  raw.sources[0].comparisons[1] = {
    ...raw.sources[0].comparisons[1],
    actualValue: 1100,
    actualDisplay: "11亿美元",
    baselineValue: 643,
    baselineDisplay: "6.43亿美元",
    unit: "million_usd",
  };
  const result = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.equal(result.sources[0].comparisons[0].actualValue, 11.35);
  assert.equal(result.sources[0].comparisons[1].baselineValue, 643);
});

test("Renminbi comparisons retain a typed financial scale", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.sources[0].supportingExcerpt =
    "营业收入为113.5亿元，市场一致预期为113.2亿元；调整后净利润为1100百万元，市场一致预期为643百万元。";
  raw.sources[0].comparisons = [
    {
      ...raw.sources[0].comparisons[0],
      actualValue: 113.5,
      actualDisplay: "113.5亿元",
      baselineValue: 113.2,
      baselineDisplay: "113.2亿元",
      unit: "hundred_million_cny",
    },
    {
      ...raw.sources[0].comparisons[1],
      actualValue: 1100,
      actualDisplay: "1100百万元",
      baselineValue: 643,
      baselineDisplay: "643百万元",
      unit: "million_cny",
    },
  ];
  const result = validateResearchOutput(raw, "facts", anomaly, envelope);
  assert.deepEqual(
    result.sources[0].comparisons.map((item) => item.unit),
    ["hundred_million_cny", "million_cny"],
  );
});

test("public comparison labels fit the V11 reader contract", () => {
  const result = publicComparison({
    label: "Probability of a Federal Reserve rate hike as soon as next month",
    actualValue: 58,
    actualDisplay: "nearly 58%",
    baselineLabel: "FactSet Wall Street consensus forecast",
    baselineValue: 35,
    baselineDisplay: "35%",
    unit: "percent",
    higherIsPositive: false,
    note: "数值取区间下限；未计算差值。",
  });
  assert.equal(result.label, "Next-month Fed rate-hike probability");
  assert.equal([...result.label].length <= 40, true);
  assert.equal(result.baselineLabel, "FactSet consensus");
  assert.equal([...result.baselineLabel].length <= 24, true);
  assert.equal(result.note, "数值取区间下限");
  const negative = publicComparison({
    label: "季度收入",
    actualValue: 8,
    actualDisplay: "$8B",
    baselineLabel: "市场预期",
    baselineValue: 10,
    baselineDisplay: "$10B",
    unit: "billion_usd",
    higherIsPositive: true,
    note: "",
  });
  assert.equal(negative.delta, "-$2B（-20%）");
  const renminbi = publicComparison({
    label: "营业收入",
    actualValue: 100,
    actualDisplay: "100亿元",
    baselineLabel: "市场预期",
    baselineValue: 90,
    baselineDisplay: "90亿元",
    unit: "hundred_million_cny",
    higherIsPositive: true,
    note: "",
  });
  assert.equal(renminbi.delta, "+10亿元（+11.1%）");
  const preciseEps = publicComparison({
    label: "调整后每股收益",
    actualValue: 0.123,
    actualDisplay: "$0.123",
    baselineLabel: "市场预期",
    baselineValue: 0.121,
    baselineDisplay: "$0.121",
    unit: "usd",
    higherIsPositive: true,
    note: "",
  });
  assert.equal(preciseEps.delta, "+$0.002（+1.7%）");
});

test("research follow-up may pursue an explicit cross-market lead", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("facts", anomaly, envelope);
  raw.queries[1] =
    "CN 2026-08-22 002837 Envicool filing results guidance announcement";
  assert.doesNotThrow(() =>
    validateResearchOutput(raw, "facts", anomaly, envelope),
  );
});

test("AI-layer repair research may narrow to a deterministic constituent", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const layer = envelope.aiChainPerformance.find(
    (item) => item.layer === "applications",
  );
  const anomaly = {
    ...planFixture().anomalies[0],
    id: "US-AI-APPLICATIONS",
    kind: "ai_layer",
    target: layer.symbol,
  };
  const raw = researchFixture("facts", anomaly, envelope);
  raw.queries = [
    `US ${envelope.marketAsOf} ${layer.constituents[0].symbol} ${layer.constituents[0].nameEn} earnings actual consensus`,
    `US ${envelope.marketAsOf} ${layer.symbol} software shares reaction`,
  ];
  assert.doesNotThrow(() =>
    validateResearchOutput(raw, "facts", anomaly, envelope),
  );
});

test("fact events may precede the session while causal reports may not", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const factsRaw = researchFixture("facts", anomaly, envelope);
  factsRaw.sources[0].publishedAt = "2026-08-19T12:00:00.000Z";
  const facts = validateResearchOutput(
    factsRaw,
    "facts",
    anomaly,
    envelope,
  );
  const factsLedger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `Representative 1. ${facts.sources[0].supportingExcerpt}`,
      publishedAtCandidates: [facts.sources[0].publishedAt],
    }),
  });
  assert.equal(factsLedger.sources.length, 1);

  const causalRaw = researchFixture("causal", anomaly, envelope);
  causalRaw.sources[0].publishedAt = "2026-08-19T12:00:00.000Z";
  causalRaw.sources[0].kind = "event";
  const causal = validateResearchOutput(
    causalRaw,
    "causal",
    anomaly,
    envelope,
  );
  const causalLedger = await verifyResearchSources([causal], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `Representative 1. ${causal.sources[0].supportingExcerpt}`,
      publishedAtCandidates: [causal.sources[0].publishedAt],
    }),
  });
  assert.equal(causalLedger.sources.length, 0);
  assert.match(causalLedger.rejected[0].reason, /交易窗口/);

  const lateWrapRaw = researchFixture("causal", anomaly, envelope);
  lateWrapRaw.sources[0].publishedAt = "2026-08-22T02:00:00.000Z";
  const lateWrap = validateResearchOutput(
    lateWrapRaw,
    "causal",
    anomaly,
    envelope,
  );
  const lateWrapLedger = await verifyResearchSources([lateWrap], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `Representative 1. ${lateWrap.sources[0].supportingExcerpt}`,
      publishedAtCandidates: [lateWrap.sources[0].publishedAt],
    }),
  });
  assert.equal(lateWrapLedger.sources.length, 1);

  const liveWrapRaw = researchFixture("causal", anomaly, envelope);
  liveWrapRaw.sources[0].publishedAt = "2026-08-21T18:00:00.000Z";
  const liveWrap = validateResearchOutput(
    liveWrapRaw,
    "causal",
    anomaly,
    envelope,
  );
  const liveWrapLedger = await verifyResearchSources([liveWrap], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `Representative 1. ${liveWrap.sources[0].supportingExcerpt}`,
      publishedAtCandidates: [liveWrap.sources[0].publishedAt],
    }),
  });
  assert.equal(liveWrapLedger.sources.length, 1);
  assert.equal(liveWrapLedger.sources[0].kind, "event");

  const lateFactsRaw = researchFixture("facts", anomaly, envelope);
  lateFactsRaw.sources[0].kind = "market_wrap";
  lateFactsRaw.sources[0].publishedAt = "2026-08-21T20:45:00.000Z";
  const lateFacts = validateResearchOutput(
    lateFactsRaw,
    "facts",
    anomaly,
    envelope,
  );
  const lateFactsLedger = await verifyResearchSources([lateFacts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `Representative 1. ${lateFacts.sources[0].supportingExcerpt}`,
      publishedAtCandidates: [lateFacts.sources[0].publishedAt],
    }),
  });
  assert.equal(lateFactsLedger.sources.length, 1);
  assert.equal(lateFactsLedger.sources[0].kind, "market_wrap");
});

test("V11 publication uses the same pre-session fact and late-wrap windows", () => {
  const input = fixtureInput();
  const report = fixtureReport(input);
  const driver = report.drivers.find((item) => item.market === "US");
  const external = driver.evidence.find((item) => item.kind !== "market_data");
  external.kind = "event";
  external.publishedAt = "2026-08-19T20:30:00.000Z";
  assert.doesNotThrow(() =>
    validateReport(report, input, {
      requireResearchAudit: false,
      activeMarket: "US",
    }),
  );

  external.kind = "market_wrap";
  external.publishedAt = "2026-08-22T02:00:00.000Z";
  assert.doesNotThrow(() =>
    validateReport(report, input, {
      requireResearchAudit: false,
      activeMarket: "US",
    }),
  );
});

test("a sourced OpenAI company headline is not treated as workflow leakage", () => {
  const input = fixtureInput();
  const report = fixtureReport(input);
  const driver = report.drivers.find((item) => item.market === "US");
  const external = driver.evidence.find((item) => item.kind !== "market_data");
  external.title = "OpenAI announces a verified company partnership";
  assert.doesNotThrow(() =>
    validateReport(report, input, {
      requireResearchAudit: false,
      activeMarket: "US",
    }),
  );
});

test("short ticker aliases require token boundaries", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  envelope.sectorPerformance[0].constituents.push({
    symbol: "MU",
    name: "美光科技",
    nameEn: "Micron Technology",
  });
  assert.equal(
    bodySupportsDeterministicTarget(
      "The community discussed memory demand without naming a company.",
      envelope,
      "MU",
    ),
    false,
  );
  assert.equal(
    bodySupportsDeterministicTarget(
      "MU shares rose after the company updated its outlook.",
      envelope,
      "MU",
    ),
    false,
  );
  assert.equal(
    bodySupportsDeterministicTarget(
      "$MU shares rose after the company updated its outlook.",
      envelope,
      "MU",
    ),
    true,
  );
  envelope.sectorPerformance[0].constituents.push({
    symbol: "SO",
    name: "南方电力",
    nameEn: "Southern Company",
  });
  assert.equal(
    bodySupportsDeterministicTarget(
      "Utilities fell as yields rose, so investors favored banks.",
      envelope,
      "SO",
    ),
    false,
  );
  assert.equal(
    bodySupportsDeterministicTarget(
      "Southern Company fell as yields rose.",
      envelope,
      "SO",
    ),
    true,
  );
});

test("AI application aliases bind office and coding coverage", () => {
  const envelope = marketEnvelope(fixtureInput(), "CN");
  assert.equal(
    bodySupportsDeterministicTarget(
      "A股AI办公、操作系统与AI编程概念同步走强。",
      envelope,
      "AI-CN-applications",
    ),
    true,
  );
});

test("DGS10 evidence requires the ten-year Treasury tenor", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  assert.equal(
    bodySupportsDeterministicTarget(
      "The two-year Treasury yield climbed after the auction.",
      envelope,
      "DGS10",
    ),
    false,
  );
  assert.equal(
    bodySupportsDeterministicTarget(
      "The 10-year Treasury yield climbed after the auction.",
      envelope,
      "DGS10",
    ),
    true,
  );
});

test("external fact events may be event-only while causal evidence must name the target", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const facts = validateResearchOutput(
    researchFixture("facts", anomaly, envelope),
    "facts",
    anomaly,
    envelope,
  );
  const ledger = await verifyResearchSources([facts], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `${facts.sources[0].supportingExcerpt} Additional issuer details without the reacting target name.`,
      publishedAtCandidates: [facts.sources[0].publishedAt],
    }),
  });
  assert.equal(ledger.sources.length, 1);
  assert.equal(ledger.sources[0].scope, "event_only");
});

test("causal target must appear in the exact verified excerpt", async () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const raw = researchFixture("causal", anomaly, envelope);
  raw.sources[0].supportingExcerpt =
    "Shares rose after revenue and adjusted earnings exceeded Wall Street expectations, prompting buying into the close.";
  const causal = validateResearchOutput(raw, "causal", anomaly, envelope);
  const ledger = await verifyResearchSources([causal], envelope, {
    reader: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: `Representative 1 appears in an unrelated navigation block. ${causal.sources[0].supportingExcerpt}`,
      publishedAtCandidates: [causal.sources[0].publishedAt],
    }),
  });
  assert.equal(ledger.sources.length, 0);
  assert.match(ledger.rejected[0].reason, /因果支持段落未出现确定性归因目标/);
});

test("planner output binds exact deterministic targets, moves and scoped queries", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const cnEnvelope = marketEnvelope(fixtureInput(), "CN");
  assert.equal(cnEnvelope.crossMarketLeads.market, "US");
  assert.equal(cnEnvelope.crossMarketLeads.aiLayers.length, 3);
  assert.equal(
    cnEnvelope.crossMarketLeads.aiLayers.every(
      (item) => item.representativeMoves.length <= 2,
    ),
    true,
  );
  const plan = validatePlan(planFixture(), envelope);
  assert.equal(plan.anomalies[0].target, "US-XLB-0");
  const aliased = planFixture();
  aliased.anomalies[0].target = "Representative 1";
  assert.throws(
    () => validatePlan(aliased, envelope),
    /target 不在确定性市场输入中/,
  );
  const invalid = planFixture();
  invalid.anomalies[0].observedMove = "代表公司上涨 9.99%";
  assert.throws(() => validatePlan(invalid, envelope), /准确复制确定性涨跌幅/);

  const duplicateTarget = planFixture();
  duplicateTarget.anomalies[2] = {
    ...structuredClone(duplicateTarget.anomalies[0]),
    id: "US-DUPLICATE",
  };
  assert.throws(
    () => validatePlan(duplicateTarget, envelope),
    /不得重复选择同一异动目标 US-XLB-0/,
  );

  const missingBroad = planFixture();
  missingBroad.anomalies[1] = {
    ...missingBroad.anomalies[1],
    kind: "sector",
    target: "XLB",
    observedMove: "原材料板块收盘上涨 +1.30%",
    factQueries: ["US 2026-08-21 XLB materials sector facts"],
    causalQueries: ["US 2026-08-21 XLB materials sector market wrap"],
  };
  assert.throws(() => validatePlan(missingBroad, envelope), /DGS10 \+5 bp/);

  const materialCrossLead = marketEnvelope(fixtureInput(), "US");
  materialCrossLead.crossMarketLeads.aiLayers[0] = {
    ...materialCrossLead.crossMarketLeads.aiLayers[0],
    change: "+6.00%",
  };
  assert.throws(
    () => validatePlan(planFixture(), materialCrossLead),
    /重大跨市场映射 AI-US-chips/,
  );
});

test("research excludes cross-market sessions that closed after the active session", () => {
  const input = fixtureInput();
  const originalHash = marketInputHash(input, "CN");
  const cn = researchMarketEnvelope(input, "CN");
  assert.equal(cn.crossMarketLeads.aiLayers.length, 0);
  assert.equal(marketInputHash(input, "CN"), originalHash);
  assert.equal(marketEnvelope(input, "CN").crossMarketLeads.aiLayers.length, 3);
  const us = researchMarketEnvelope(input, "US");
  assert.equal(us.crossMarketLeads.aiLayers.length, 3);
  us.crossMarketLeads.marketAsOf = "2026-08-22";
  us.crossMarketLeads.aiLayers[0].change = "+20%";
  assert.equal(eligibleCrossMarketLeads(us).length, 0);
  assert.doesNotThrow(() => validatePlan(planFixture(), us));
  const earlier = marketEnvelope(input, "CN");
  earlier.crossMarketLeads.marketAsOf = "2026-08-20";
  assert.equal(eligibleCrossMarketLeads(earlier).length, 3);
  earlier.crossMarketLeads.marketAsOf = null;
  assert.equal(eligibleCrossMarketLeads(earlier).length, 0);
  const workflow = new MarketWorkflow({ input, market: "CN", deliveryMode: "shadow" });
  assert.equal(workflow.envelope.crossMarketLeads.aiLayers.length, 0);
  assert.equal(workflow.inputHash, originalHash);
});

test("AI software is a deterministic applications query alias", () => {
  const input = fixtureInput();
  const envelope = marketEnvelope(input, "CN");
  const metric = envelope.aiChainPerformance.find((item) => item.layer === "applications");
  const anomaly = { ...planFixture().anomalies[0], kind: "ai_layer", target: metric.symbol };
  const output = researchFixture("facts", anomaly, envelope);
  output.market = "CN";
  output.queries = ["2026-08-21 A股 AI软件 赛富时 业绩", "2026-08-21 A股 赛富时 营收 分析师预期"];
  assert.doesNotThrow(() => validateResearchOutput(output, "facts", anomaly, envelope));
});

test("research queries may identify the market through a full deterministic constituent name", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[0];
  const output = researchFixture("causal", anomaly, envelope);
  output.queries = ["August 21 2026 Representative 1 earnings market reaction", "August 21 2026 US Representative 1 revenue consensus"];
  assert.doesNotThrow(() => validateResearchOutput(output, "causal", anomaly, envelope));
  output.queries[0] = "August 21 2026 unrelated company earnings market reaction";
  assert.throws(() => validateResearchOutput(output, "causal", anomaly, envelope), /市场标记及异动目标/);
  output.queries[0] = "August 22 2026 Representative 1 earnings market reaction";
  assert.throws(() => validateResearchOutput(output, "causal", anomaly, envelope), /交易日/);
});

test("directed facts repair can investigate the named event rather than repeat the index query", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const anomaly = planFixture().anomalies[1];
  const output = researchFixture("facts", anomaly, envelope);
  output.queries = ["August 21 2026 US Nvidia revenue EPS analyst consensus", "August 21 2026 US Nvidia earnings release guidance"];
  assert.throws(() => validateResearchOutput(output, "facts", anomaly, envelope), /异动目标/);
  assert.doesNotThrow(() => validateResearchOutput(output, "facts", anomaly, envelope, { targetedRepair: true }));
  output.queries[0] = "Nvidia earnings";
  assert.throws(() => validateResearchOutput(output, "facts", anomaly, envelope, { targetedRepair: true }), /交易日/);
});

test("EPS evidence cannot omit disclosed investment gains from the supporting passage", () => {
  const source = { comparisons: [{ label: "非GAAP每股收益" }], supportingExcerpt: "非GAAP每股收益5.90美元，对照预期3.27美元。" };
  const body = `${source.supportingExcerpt}公司确认战略投资净收益26.13亿美元。该收益对非GAAP每股收益贡献2.53美元。`;
  assert.throws(() => assertMaterialEarningsContext(source, body), /遗漏该口径/);
  assert.doesNotThrow(() => assertMaterialEarningsContext({ ...source, supportingExcerpt: body }, body));
  assert.doesNotThrow(() => assertMaterialEarningsContext({ ...source, comparisons: [{ label: "营业收入" }] }, body));
  assert.doesNotThrow(() => assertMaterialEarningsContext(source, source.supportingExcerpt));
  assert.throws(() => assertMaterialEarningsContext({ comparisons: [{ label: "Adjusted EPS" }], supportingExcerpt: "Adjusted EPS was $5.90 versus $3.27 expected." }, "Adjusted EPS was $5.90. Gains on strategic investments contributed $2.53 to EPS."), /遗漏该口径/);
});

test("cross-market earnings follow-up recognizes an eligible same-layer issuer name", () => {
  const envelope = marketEnvelope(fixtureInput(), "CN");
  const metric = envelope.aiChainPerformance.find((item) => item.layer === "applications");
  const anomaly = { ...planFixture().anomalies[0], kind: "ai_layer", target: metric.symbol };
  envelope.crossMarketLeads.marketAsOf = "2026-08-20";
  envelope.crossMarketLeads.aiLayers = [{ layer: "applications", representativeMoves: [{ name: "赛富时", nameEn: "Salesforce" }] }];
  const output = researchFixture("facts", anomaly, envelope);
  output.market = "CN";
  output.queries = ["2026-08-21 A股 AI软件 业绩", "CRM Salesforce 2026-08-20 财报 营收 EPS 分析师预期"];
  assert.doesNotThrow(() => validateResearchOutput(output, "facts", anomaly, envelope));
  envelope.crossMarketLeads.marketAsOf = "2026-08-22";
  assert.throws(() => validateResearchOutput(output, "facts", anomaly, envelope), /跨市场标记/);
});

test("planner anomaly ids cannot escape the run artifact directory", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const unsafe = planFixture();
  unsafe.anomalies[0].id = "../../outside";
  assert.throws(
    () => validatePlan(unsafe, envelope),
    /只能包含字母、数字、下划线和连字符/u,
  );
});

test("planner rejects AI-only companies that the V11 company card cannot bind", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const sectorSymbols = new Set(
    envelope.sectorPerformance.flatMap((row) =>
      (row.constituents ?? []).map((company) => company.symbol),
    ),
  );
  const aiOnly = envelope.aiChainPerformance
    .flatMap((row) => row.constituents ?? [])
    .find((company) => !sectorSymbols.has(company.symbol));
  assert.ok(aiOnly);
  const unsupported = planFixture();
  unsupported.anomalies[0] = {
    ...unsupported.anomalies[0],
    target: aiOnly.symbol,
    observedMove: `${aiOnly.name} 收盘变动 ${aiOnly.change}`,
    direction:
      aiOnly.direction === "up"
        ? "positive"
        : aiOnly.direction === "down"
          ? "negative"
          : "mixed",
    factQueries: [
      `US 2026-08-21 ${aiOnly.symbol} ${aiOnly.nameEn} earnings actual consensus`,
    ],
    causalQueries: [
      `US 2026-08-21 ${aiOnly.symbol} ${aiOnly.nameEn} shares market reaction`,
    ],
  };
  assert.throws(
    () => validatePlan(unsupported, envelope),
    /target 不在确定性市场输入中/u,
  );
});

test("no-claim publication stays pending and cannot complete a scheduled event", () => {
  assert.equal(
    workflowBatchStatus({
      results: [{ status: "no_claims", market: "CN" }],
      recoveries: [],
      publish: true,
      shadow: false,
    }),
    "pending_no_claims",
  );
  assert.equal(
    workflowBatchStatus({
      results: [
        {
          status: "ready",
          market: "US",
          publication: { status: "published" },
        },
      ],
      recoveries: [],
      publish: true,
      shadow: false,
    }),
    "complete",
  );
  assert.equal(
    workflowBatchStatus({
      results: [],
      recoveries: [{
        status: "published",
        market: "US",
        ingestionFinalization: {
          status: "failed",
          error: "temporary D1 finalization failure",
        },
      }],
      publish: true,
      shadow: false,
    }),
    "partial_failure",
  );
});

test("every review repair round routes research defects back through research and adjudication", async () => {
  const { input, plan, ledger, envelope } = await verifiedFixture();
  const adjudication = validateAdjudication(
    acceptedAdjudicationFixture(plan, ledger),
    plan,
    ledger,
    envelope,
  );
  const cards = adjudication.claimCards;
  const review = {
    verdict: "revise",
    claimReviews: [
      {
        claimId: cards[0].id,
        verdict: "revise",
        defectCodes: ["missing_direct_evidence"],
        repairStage: "research",
        summary: "需要补充直接说明价格反应的独立证据。",
      },
    ],
  };
  const workflow = new MarketWorkflow({
    input,
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
  });
  workflow.manifest = { evidence: {} };
  let researchCalls = 0;
  let researchSuffix = "";
  let adjudicationCalls = 0;
  let writerCalls = 0;
  workflow.researchAnomaly = async (_anomaly, suffix) => {
    researchCalls += 1;
    researchSuffix = suffix;
    return [];
  };
  workflow.verifyEvidence = async () => ledger;
  workflow.adjudicate = async () => {
    adjudicationCalls += 1;
    return adjudication;
  };
  workflow.writeDraft = async () => {
    writerCalls += 1;
    return { repaired: true };
  };
  const repaired = await workflow.repairReviewedDraft({
    adjudication,
    review,
    researchedPlan: plan,
    ledger,
    researchOutputs: [],
    cards,
    draft: { original: true },
    repairRound: 2,
  });
  assert.equal(researchCalls, 1);
  assert.match(researchSuffix, /repair round 2/u);
  assert.equal(adjudicationCalls, 1);
  assert.equal(writerCalls, 1);
  assert.equal(repaired.cards.length, 1);

  workflow.searchQueryCount = 12;
  const reorderedRaw = acceptedAdjudicationFixture(plan, ledger);
  reorderedRaw.claimCards[0].evidenceIds.reverse();
  const readjudicated = validateAdjudication(
    reorderedRaw,
    plan,
    ledger,
    envelope,
  );
  assert.notEqual(readjudicated.claimCards[0].id, cards[0].id);
  workflow.adjudicate = async () => {
    adjudicationCalls += 1;
    return readjudicated;
  };
  writerCalls = 0;
  const rejected = await workflow.repairReviewedDraft({
    adjudication,
    review,
    researchedPlan: plan,
    ledger,
    researchOutputs: [],
    cards,
    draft: { original: true },
  });
  assert.equal(rejected.cards.length, 0);
  assert.equal(writerCalls, 0);
  assert.equal(
    rejectAdjudicationClaims(
      adjudication,
      [cards[0].id],
      plan,
      ledger,
      envelope,
    ).claimCards.length,
    0,
  );
});

test("financial-result wording always requires typed comparisons", () => {
  for (const copy of [
    "季度结果显示收入和利润超预期",
    "Quarterly results, profit and sales beat expectations",
    "Revenue and net income exceeded consensus",
    "Revenue beat consensus, while investors looked ahead of next earnings",
    "公司营收高于预期，但投资者同时关注下一次财报发布前的仓位",
    "Company reported quarterly revenue and shares rose ahead of next earnings",
    "公司公布季度营收，股价上涨；同时市场在下一次财报公布前调整仓位",
  ]) {
    assert.equal(requiresFinancialComparisons(copy), true, copy);
  }
  assert.equal(
    requiresFinancialComparisons("Shares rose ahead of quarterly results"),
    false,
  );
  assert.equal(
    requiresFinancialComparisons("Fixed income selling pushed yields higher"),
    false,
  );
});

test("a causal worker cannot turn parallel price quotes into a causal passage", async () => {
  const { envelope, plan, ledger } = await verifiedFixture();
  const priceOnly = "今日，科创50指数收涨1.71%，报1632.02点。盘面上，半导体板块多数上涨，芯原股份涨超9%，华虹宏力涨超7%。创新药板块走强，康希诺涨停。";
  assert.equal(hasCausalPassage(priceOnly), false);
  assert.equal(hasCausalPassage("Oil prices fell, helping calm inflation worries and support stocks."), true);
  const changed = structuredClone(ledger);
  const causal = changed.sources.find((source) => source.role === "causal");
  causal.supportingExcerpt = priceOnly;
  causal.excerptHash = stableHash(priceOnly);
  causal.facts = "半导体上涨推动指数上涨，这是重要直接原因。";
  assert.throws(() => validateAdjudication(acceptedAdjudicationFixture(plan, changed), plan, changed, envelope), /因果原文仅并列行情/u);
});

test("adjudication requires isolated fact and causal evidence passages and typed financial comparisons", async () => {
  const { envelope, plan, ledger } = await verifiedFixture();
  const raw = acceptedAdjudicationFixture(plan, ledger);
  const fact = ledger.sources.find((item) => item.role === "facts");
  const causal = ledger.sources.find((item) => item.role === "causal");
  const result = validateAdjudication(raw, plan, ledger, envelope);
  assert.equal(result.claimCards.length, 1);
  assert.equal(result.claimCards[0].hypothesisId, "H-EARNINGS");
  assert.match(result.claimCards[0].comparisons[0].delta, /\+\$1\.9B/);

  const duplicatedComparisonLedger = structuredClone(ledger);
  const duplicatedComparisonFact = duplicatedComparisonLedger.sources.find(
    (item) => item.role === "facts",
  );
  duplicatedComparisonFact.comparisons[1] = {
    ...duplicatedComparisonFact.comparisons[0],
    id: `${duplicatedComparisonFact.comparisons[0].id}-duplicate`,
  };
  const duplicatedComparisonClaim = structuredClone(raw);
  duplicatedComparisonClaim.claimCards[0].comparisonIds =
    duplicatedComparisonFact.comparisons.map((item) => item.id);
  assert.throws(
    () =>
      validateAdjudication(
        duplicatedComparisonClaim,
        plan,
        duplicatedComparisonLedger,
        envelope,
      ),
    /缺少至少两项实际值与预期值对比/u,
  );

  const equalValueLedger = structuredClone(ledger);
  const equalValueFact = equalValueLedger.sources.find(
    (item) => item.role === "facts",
  );
  equalValueFact.comparisons[1] = {
    ...equalValueFact.comparisons[0],
    id: equalValueFact.comparisons[1].id,
    label: "调整后营业利润率",
  };
  const equalValueClaim = structuredClone(raw);
  equalValueClaim.claimCards[0].comparisonIds =
    equalValueFact.comparisons.map((item) => item.id);
  assert.equal(
    validateAdjudication(
      equalValueClaim,
      plan,
      equalValueLedger,
      envelope,
    ).claimCards[0].comparisons.length,
    2,
  );

  const baseAnomaly = plan.anomalies[0];
  const threePlan = {
    ...plan,
    anomalies: ["US-DRIVER-A", "US-DRIVER-B", "US-DRIVER-C"].map(
      (id) => ({ ...structuredClone(baseAnomaly), id }),
    ),
  };
  const threeLedger = {
    ...structuredClone(ledger),
    sources: [],
    alternatives: [],
  };
  const threeClaims = [];
  for (const anomaly of threePlan.anomalies) {
    const sources = ledger.sources.map((source, sourceIndex) => {
      const id = `${source.id}-${anomaly.id}-${sourceIndex}`;
      return {
        ...structuredClone(source),
        id,
        anomalyId: anomaly.id,
        comparisons: source.comparisons.map((comparison, comparisonIndex) => ({
          ...comparison,
          id: `${id}:${comparisonIndex}`,
        })),
      };
    });
    threeLedger.sources.push(...sources);
    threeLedger.alternatives.push({
      anomalyId: anomaly.id,
      role: "causal",
      claim: "板块共振可能形成竞争解释",
      status: "unresolved",
      evidenceIds: [],
    });
    const claim = structuredClone(raw.claimCards[0]);
    claim.anomalyId = anomaly.id;
    claim.evidenceIds = sources.map((source) => source.id);
    claim.comparisonIds = sources
      .filter((source) => source.role === "facts")
      .flatMap((source) => source.comparisons.map((comparison) => comparison.id));
    threeClaims.push(claim);
  }
  assert.throws(
    () =>
      validateAdjudication(
        {
          ...structuredClone(raw),
          decisions: threePlan.anomalies.map((anomaly) => ({
            anomalyId: anomaly.id,
            verdict: "accepted",
            publishedAs: "market_driver",
            reason: "事实与因果证据均直接支持该条市场驱动。",
          })),
          claimCards: threeClaims,
        },
        threePlan,
        threeLedger,
        envelope,
      ),
    /最多接受两条市场驱动/u,
  );

  const fakeSector = structuredClone(raw);
  fakeSector.claimCards[0].sectorSymbols = ["FAKE"];
  assert.throws(
    () => validateAdjudication(fakeSector, plan, ledger, envelope),
    /板块绑定不在确定性市场输入中/,
  );

  const duplicateAccepted = structuredClone(raw);
  duplicateAccepted.decisions[1] = {
    anomalyId: "US-BROAD",
    verdict: "accepted",
    publishedAs: "market_driver",
    reason: "测试第二项接受裁决必须有其自身且唯一的归因卡片。",
  };
  duplicateAccepted.claimCards.push(structuredClone(raw.claimCards[0]));
  assert.throws(
    () => validateAdjudication(duplicateAccepted, plan, ledger, envelope),
    /已接受裁决与归因卡片数量不一致/,
  );

  const splitHypotheses = structuredClone(ledger);
  splitHypotheses.sources.find((item) => item.role === "causal").hypothesisIds = [
    "H-SECTOR",
  ];
  assert.throws(
    () => validateAdjudication(raw, plan, splitHypotheses, envelope),
    /未共同支持同一候选原因/,
  );

  const reorderedRaw = structuredClone(raw);
  reorderedRaw.claimCards[0].evidenceIds.reverse();
  const reordered = validateAdjudication(reorderedRaw, plan, ledger, envelope);
  assert.notEqual(reordered.claimCards[0].id, result.claimCards[0].id);
  const preserved = preservePassedAdjudication(
    reordered,
    result,
    {
      claimReviews: [{ claimId: result.claimCards[0].id, verdict: "pass" }],
    },
    plan,
    ledger,
    envelope,
  );
  assert.deepEqual(preserved.claimCards[0], result.claimCards[0]);

  const tooManySources = structuredClone(raw);
  tooManySources.claimCards[0].evidenceIds.push(
    "additional-source-one",
    "additional-source-two",
  );
  assert.throws(
    () => validateAdjudication(tooManySources, plan, ledger, envelope),
    /数量必须为 2–3/u,
  );

  const preEvent = structuredClone(raw);
  preEvent.claimCards[0] = {
    ...preEvent.claimCards[0],
    title: "财报发布前降低风险仓位压低股价",
    factSummary: "芯片股票在关键公司财报发布前遭遇集中减仓，市场表现出现明显分化。",
    causalStatement: "独立收盘报道明确将当日卖盘归因于投资者在关键公司财报发布前降低风险仓位，因此解释的是事件前的仓位调整，而不是尚未公布的业绩结果。",
    comparisonIds: [],
  };
  assert.doesNotThrow(() =>
    validateAdjudication(preEvent, plan, ledger, envelope),
  );

  const samePage = structuredClone(ledger);
  samePage.sources.find((item) => item.role === "causal").url = fact.url;
  assert.equal(
    validateAdjudication(raw, plan, samePage, envelope).claimCards.length,
    1,
  );

  const duplicatedPassage = structuredClone(samePage);
  duplicatedPassage.sources.find((item) => item.role === "causal").excerptHash =
    fact.excerptHash;
  assert.throws(
    () => validateAdjudication(raw, plan, duplicatedPassage, envelope),
    /不得复用同一段正文/,
  );

  const widened = structuredClone(raw);
  widened.claimCards[0].targets.push("US-XLB-1");
  assert.throws(
    () => validateAdjudication(widened, plan, ledger, envelope),
    /必须精确等于计划中的确定性异动目标/,
  );

  const inventedFact = structuredClone(raw);
  inventedFact.claimCards[0].factSummary += " 未经来源事实字段记录的增幅为99%。";
  assert.throws(
    () => validateAdjudication(inventedFact, plan, ledger, envelope),
    /数字 99/,
  );

  const foreignLedger = structuredClone(ledger);
  const foreign = structuredClone(fact);
  foreign.id = "foreign-source-id";
  foreign.anomalyId = "US-BROAD";
  foreign.comparisons[0].id = "foreign-comparison-id";
  foreignLedger.sources.push(foreign);
  const crossClaim = structuredClone(raw);
  crossClaim.claimCards[0].comparisonIds = [
    fact.comparisons[0].id,
    foreign.comparisons[0].id,
  ];
  assert.throws(
    () => validateAdjudication(crossClaim, plan, foreignLedger, envelope),
    /未知对比数据/,
  );

  const aiPlan = structuredClone(plan);
  aiPlan.anomalies[0] = {
    ...aiPlan.anomalies[0],
    kind: "ai_layer",
    target: "AI-US-chips",
  };
  const aiLedger = structuredClone(ledger);
  for (const source of aiLedger.sources) {
    if (source.anomalyId !== "US-EARNINGS") continue;
    source.targets = ["AI-US-chips"];
    source.scope = "ai_layer";
  }
  const misclassifiedAi = structuredClone(raw);
  misclassifiedAi.claimCards[0].scope = "ai_layer";
  misclassifiedAi.claimCards[0].targets = ["AI-US-chips"];
  assert.throws(
    () => validateAdjudication(misclassifiedAi, aiPlan, aiLedger, envelope),
    /AI 分层异动必须发布为 AI 产业链归因/,
  );
  const validAi = structuredClone(misclassifiedAi);
  validAi.decisions[0].publishedAs = "ai_update";
  validAi.claimCards[0].publishedAs = "ai_update";
  assert.equal(
    validateAdjudication(validAi, aiPlan, aiLedger, envelope).claimCards[0]
      .layer,
    "chips",
  );
});

test("writer and reviewer gates reject thin copy and internal audit caveats", async () => {
  const { input, envelope, plan, ledger } = await verifiedFixture();
  const fact = ledger.sources.find((item) => item.role === "facts");
  const causal = ledger.sources.find((item) => item.role === "causal");
  const cards = validateAdjudication(
    {
      contractVersion: "stock-daily-adjudication-v1",
      market: "US",
      decisions: [
        { anomalyId: "US-EARNINGS", verdict: "accepted", publishedAs: "market_driver", reason: "两类证据独立且直接支持公司层面的归因。" },
        { anomalyId: "US-BROAD", verdict: "rejected", publishedAs: "none", reason: "大盘解释没有直接的收盘因果证据支持。" },
      ],
      claimCards: [
        {
          anomalyId: "US-EARNINGS", publishedAs: "market_driver", basis: "event", direction: "positive", scope: "company",
          targets: ["US-XLB-0"], sectorSymbols: ["XLB"], layer: "", title: "收入与盈利双超预期推动上涨",
          factSummary: "公司季度财报的收入与调整后每股收益均高于市场一致预期。",
          causalStatement: "收盘报道明确将买盘与高于华尔街预期的收入和盈利联系起来，因此支持公司股价当日上涨的直接归因。",
          evidenceIds: [fact.id, causal.id], comparisonIds: fact.comparisons.map((item) => item.id),
          alternativeAssessment: "行业共振可能有次要影响，但直接报道聚焦公司财报。",
        },
      ],
    },
    plan,
    ledger,
    envelope,
  ).claimCards;
  const metricCopy = cards[0].comparisons
    .map((item) => `${item.label}实际${item.actual}、${item.baselineLabel}${item.baseline}、差额${item.delta}`)
    .join("；");
  const detail = `公司公布季度业绩后，${metricCopy}。两项核心指标同时高于一致预期，改善了投资者对增长兑现能力的判断；收盘报道又明确记录财报后的买盘，因此这条信息能够解释公司股票当日上涨，而不是简单重复价格变化。`;
  const draft = {
    contractVersion: "stock-daily-market-draft-v1",
    market: "US",
    overviewHeadline: "公司财报数据改善推动个股走强",
    overviewSummary: detail,
    marketView: { headline: "财报数据触发公司买盘", summary: detail, driverStatus: "explained" },
    aiChainView: { headline: "本期暂无可核实的 AI 产业链归因", summary: "本期暂无可核实的 AI 产业链归因，相关主要涨跌原因仍待核实。", mechanism: null, driverStatus: "insufficient" },
    drivers: [{ claimId: cards[0].id, title: "收入与盈利双超预期推动上涨", summary: detail, mechanism: detail, metrics: cards[0].comparisons.map((item, index) => ({ label: index === 0 ? "季度收入" : "调整后每股收益", baselineLabel: "市场一致预期", note: "" })) }],
    aiChainUpdates: [],
  };
  const accepted = validateWriterDraft(draft, cards, "US");
  assert.equal(accepted.drivers[0].summary.length >= 100, true);
  assert.equal(accepted.drivers[0].metrics[0].label, "季度收入");
  assert.equal(accepted.drivers[0].metrics[0].actual, cards[0].comparisons[0].actual);
  const missingLabels = structuredClone(draft);
  delete missingLabels.drivers[0].metrics;
  assert.throws(() => validateWriterDraft(missingLabels, cards, "US"), /中文指标标签与比较项数量/u);
  const englishLabel = structuredClone(draft);
  englishLabel.drivers[0].metrics[0].label = "Quarterly revenue";
  assert.throws(() => validateWriterDraft(englishLabel, cards, "US"), /必须使用中文指标标签/u);
  const corruptedLabel = structuredClone(draft);
  corruptedLabel.drivers[0].metrics[0].label = "季度收入�";
  assert.throws(() => validateWriterDraft(corruptedLabel, cards, "US"), /乱码替代字符/u);
  const perShareCards = structuredClone(cards);
  perShareCards[0].comparisons[1].actual = "$1.05 per share";
  perShareCards[0].comparisons[1].baseline = "$1.01 per share";
  assert.doesNotThrow(() => validateWriterDraft(draft, perShareCards, "US"));
  const thin = structuredClone(draft);
  thin.drivers[0].summary = "财报超预期推动上涨。";
  assert.throws(() => validateWriterDraft(thin, cards, "US"), /长度/);
  const leaked = structuredClone(draft);
  leaked.drivers[0].mechanism = `${detail} 不能据此声称整个指数都受到推动。`;
  assert.throws(() => validateWriterDraft(leaked, cards, "US"), /审核措辞/);
  const editorialMeta = structuredClone(draft);
  editorialMeta.drivers[0].mechanism = `${detail} 执业判断以当前证据为基础。`;
  assert.throws(
    () => validateWriterDraft(editorialMeta, cards, "US"),
    /内部流程或审核措辞/,
  );
  const placeholder = structuredClone(draft);
  placeholder.drivers[0].mechanism =
    `${detail} _EXTENDED_CHAR_PADDING_PLACEHOLDER_REMOVE_`;
  assert.throws(
    () => validateWriterDraft(placeholder, cards, "US"),
    /内部流程或审核措辞/,
  );
  const inventedDelta = structuredClone(draft);
  inventedDelta.drivers[0].title = "收入与盈利双超预期推动上涨999%";
  assert.throws(
    () => validateWriterDraft(inventedDelta, cards, "US"),
    /未进入类型化事实字段的数字 999/,
  );
  const longDriverTitle = structuredClone(draft);
  longDriverTitle.drivers[0].title = "财".repeat(81);
  assert.throws(
    () => validateWriterDraft(longDriverTitle, cards, "US"),
    /长度必须为 5–80/u,
  );
  const nonFinancialCards = structuredClone(cards);
  nonFinancialCards[0].title = "获利了结拖累指数";
  nonFinancialCards[0].factSummary = "前期上涨积累的获利盘在收盘前集中兑现。";
  nonFinancialCards[0].comparisons = [];
  const injectedEarnings = structuredClone(draft);
  injectedEarnings.drivers[0].title = "获利了结拖累指数";
  injectedEarnings.drivers[0].summary =
    "前期上涨积累的获利盘在收盘前集中兑现，科技板块的同步回调将卖盘传导到主要指数。英伟达财报带来的提振只维持一个交易日，风险敞口收缩进一步放大跌势，令指数由盘中上涨转为明显收跌。多个高贝塔方向同时承压，使局部卖盘扩散成更广泛的成长风格回撤。";
  assert.throws(
    () => validateWriterDraft(injectedEarnings, nonFinancialCards, "US"),
    /财报或业绩表述缺少至少两项实际值与基准对比/,
  );

  const preEventCards = structuredClone(cards);
  preEventCards[0].title = "财报前降低风险仓位压低股价";
  preEventCards[0].factSummary =
    "芯片股票在关键公司财报发布前遭遇集中减仓，市场表现出现明显分化。";
  preEventCards[0].causalStatement =
    "独立收盘报道明确将当日卖盘归因于投资者在关键公司财报发布前降低风险仓位，因此解释的是事件前的仓位调整，而不是尚未公布的业绩结果。";
  preEventCards[0].comparisons = [];
  const preEventDetail =
    "关键公司公布业绩前，投资者主动降低芯片股风险敞口，相关卖盘率先压低高估值公司，并通过板块联动传导到科技方向。收盘报道把这轮回落明确归因于财报前的仓位调整，因此有效信息是资金在不确定性落地前先行避险，而不是尚未发布的业绩数字。盘中分化也说明压力集中在事件敏感度较高的标的，并非所有股票受到相同原因推动。";
  const preEventDraft = {
    contractVersion: "stock-daily-market-draft-v1",
    market: "US",
    overviewHeadline: "财报前的风险收缩压低芯片股",
    overviewSummary: preEventDetail,
    marketView: {
      headline: "资金在业绩发布前主动减仓",
      summary: preEventDetail,
      driverStatus: "explained",
    },
    aiChainView: {
      headline: "本期暂无可核实的 AI 产业链归因",
      summary: "本期暂无可核实的 AI 产业链归因，相关主要涨跌原因仍待核实。",
      mechanism: null,
      driverStatus: "insufficient",
    },
    drivers: [
      {
        claimId: preEventCards[0].id,
        title: "财报前降低风险仓位压低股价",
        summary: preEventDetail,
        mechanism: preEventDetail,
      },
    ],
    aiChainUpdates: [],
  };
  assert.doesNotThrow(() =>
    validateWriterDraft(preEventDraft, preEventCards, "US"),
  );

  const namedIndex = structuredClone(preEventDraft);
  namedIndex.drivers[0].mechanism = `${preEventDetail} 这一传导也拖累标普500。`;
  assert.doesNotThrow(() =>
    validateWriterDraft(namedIndex, preEventCards, "US"),
  );
  const inventedIndex = structuredClone(preEventDraft);
  inventedIndex.drivers[0].mechanism = `${preEventDetail} 这一传导也拖累标普501。`;
  assert.throws(
    () => validateWriterDraft(inventedIndex, preEventCards, "US"),
    /未进入类型化事实字段的数字 501/,
  );

  const review = validateReview(
    {
      contractVersion: "stock-daily-market-review-v1",
      market: "US",
      verdict: "pass",
      summary: "事实、因果范围、关键数字和读者信息增量均达到发布要求。",
      claimReviews: [{
        claimId: cards[0].id, verdict: "pass", defectCodes: [], repairStage: "none",
        summary: "实际值、预期值、差额和公司层面的买盘传导均得到直接证据支持。",
        scores: { factualAccuracy: 5, causalLogic: 4, evidenceDirectness: 5, readerUtility: 4 },
      }],
    },
    cards,
    "US",
  );
  assert.equal(review.verdict, "pass");

  const inconsistentReview = structuredClone(review);
  inconsistentReview.verdict = "revise";
  inconsistentReview.claimReviews[0].verdict = "revise";
  inconsistentReview.claimReviews[0].scores.readerUtility = 3;
  assert.throws(
    () => validateReview(inconsistentReview, cards, "US"),
    /逐条判定、缺陷与返工阶段不一致/,
  );

  const translatedMetrics = cards[0].comparisons
    .map(
      (item) =>
        `reported ${item.actual} versus consensus ${item.baseline}, a difference of ${item.delta}`,
    )
    .join("; ");
  const translatedDetail = `The company ${translatedMetrics}. The company reported both revenue and adjusted earnings above consensus, and the closing report directly linked the post-results buying to the stock advance. The figures therefore explain the company-level move through a verified earnings-surprise transmission path.`;
  const translation = {
    contractVersion: "stock-daily-market-translation-v1",
    market: "US",
    overviewHeadline: "Earnings data supported the company-level advance",
    overviewSummary: translatedDetail,
    marketView: {
      headline: "Earnings data triggered company buying",
      summary: translatedDetail,
    },
    aiChainView: {
      headline: "No verified AI-chain attribution this edition",
      summary: "The main cause of the AI-chain move remains unverified this edition.",
      mechanism: null,
    },
    drivers: [{
      claimId: cards[0].id,
      title: "Revenue and earnings beats supported the advance",
      summary: translatedDetail,
      mechanism: translatedDetail,
      metrics: cards[0].comparisons.map((item, index) => ({
        label: index === 0 ? "Quarterly revenue" : "Adjusted earnings per share",
        baselineLabel: "Wall Street consensus",
        note: item.note ? "Source-defined comparison" : "",
      })),
    }],
    aiChainUpdates: [],
  };
  const acceptedTranslation = validateTranslation(
    translation,
    accepted,
    cards,
    "US",
  );
  assert.equal(acceptedTranslation.drivers.length, 1);
  const namedCompany = structuredClone(translation);
  namedCompany.drivers[0].title = "360 Security Technology rises after results";
  assert.doesNotThrow(() => validateTranslation(namedCompany, accepted, cards, "US"));
  namedCompany.drivers[0].title = "360 Security rises after results";
  assert.doesNotThrow(() => validateTranslation(namedCompany, accepted, cards, "US"));
  namedCompany.drivers[0].summary += " Revenue rose 360%.";
  assert.throws(() => validateTranslation(namedCompany, accepted, cards, "US"), /数字 360/);
  const corruptedTranslation = structuredClone(translation);
  corruptedTranslation.drivers[0].metrics[0].label = "Quarterly revenu�";
  assert.throws(() => validateTranslation(corruptedTranslation, accepted, cards, "US"), /乱码替代字符/u);
  const longBaseline = structuredClone(translation);
  longBaseline.drivers[0].metrics[0].baselineLabel = "Analysts' prior quarter consensus";
  assert.throws(
    () => validateTranslation(longBaseline, accepted, cards, "US"),
    /baselineLabel.*2–24/u,
  );
  assert.equal(
    acceptedTranslation.drivers[0].metrics[0].label,
    "Quarterly revenue",
  );
  assert.equal(
    acceptedTranslation.drivers[0].metrics[0].actual,
    cards[0].comparisons[0].actual,
  );
  const groupedDraft = structuredClone(accepted);
  groupedDraft.overviewSummary += " The verified comparison base was 4300.";
  const groupedTranslation = structuredClone(translation);
  groupedTranslation.overviewSummary += " The verified comparison base was 4,300.";
  assert.doesNotThrow(() =>
    validateTranslation(groupedTranslation, groupedDraft, cards, "US"),
  );
  const untranslatedUnit = structuredClone(translation);
  untranslatedUnit.drivers[0].summary += " Turnover was 1018亿元.";
  assert.throws(
    () => validateTranslation(untranslatedUnit, accepted, cards, "US"),
    /不得残留中文/,
  );
  const untranslatedMetric = structuredClone(translation);
  untranslatedMetric.drivers[0].metrics[0].label = "季度收入";
  assert.throws(
    () => validateTranslation(untranslatedMetric, accepted, cards, "US"),
    /不得残留中文/,
  );
  const firstMarketReport = mergeMarketReport(
    input,
    "US",
    null,
    cards,
    ledger,
    accepted,
    acceptedTranslation,
  );
  assert.equal(firstMarketReport.workflowOverview.market, "US");
  assert.equal(firstMarketReport.drivers[0].metrics[0].label, "季度收入");
  assert.equal(firstMarketReport.drivers[0].metrics[0].delta, cards[0].comparisons[0].delta);
  assert.equal(
    firstMarketReport.workflowOverview.headline,
    accepted.overviewHeadline,
  );
  assert.equal(
    firstMarketReport.workflowOverview.headlineEn,
    acceptedTranslation.overviewHeadline,
  );
  assert.equal([...firstMarketReport.marketViews.CN.summary].length >= 20, true);
  assert.equal([...firstMarketReport.aiChainViews.CN.summary].length >= 20, true);
  const auditFactsLedger = structuredClone(ledger);
  auditFactsLedger.sources.find((item) => item.role === "facts").facts =
    "现有证据尚不足以支持更广泛的市场归因，这只是内部审核边界说明。";
  assert.throws(
    () =>
      mergeMarketReport(
        input,
        "US",
        null,
        cards,
        auditFactsLedger,
        accepted,
        acceptedTranslation,
      ),
    /审核措辞/u,
  );
  const auditTitleLedger = structuredClone(ledger);
  auditTitleLedger.sources.find((item) => item.role === "facts").title =
    "该证据只验证公司自身事件，不能据此扩大范围";
  assert.throws(
    () =>
      mergeMarketReport(
        input,
        "US",
        null,
        cards,
        auditTitleLedger,
        accepted,
        acceptedTranslation,
      ),
    /审核措辞/u,
  );
  translation.overviewSummary += " An unsupported 999% figure.";
  assert.throws(
    () => validateTranslation(translation, accepted, cards, "US"),
    /999/,
  );
});

test("empty market copy satisfies the downstream V11 reader contract", () => {
  const normalized = normalizeEmptyDraftViews(
    {
      marketView: {},
      aiChainView: {},
    },
    [{ publishedAs: "ai_update" }],
  );
  assert.ok([...normalized.marketView.summary].length >= 20);
});

test("deterministic market sources use reader-facing names", () => {
  assert.equal(
    verifiedExternalSourceLabel(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX",
    ),
    "Yahoo Finance",
  );
  assert.equal(
    verifiedExternalSourceLabel(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
    ),
    "腾讯证券行情",
  );
  assert.equal(
    verifiedExternalSourceLabel("https://fred.stlouisfed.org/series/SP500"),
    "Federal Reserve Economic Data",
  );
});

test("AI attribution uses the deterministic layer move, not its first constituent", () => {
  const input = fixtureInput();
  const envelope = marketEnvelope(input, "US");
  const layer = envelope.aiChainPerformance.find(
    (item) =>
      item.constituents?.[0] && item.constituents[0].direction !== item.direction,
  );
  assert.ok(layer, "fixture must contain a layer whose first stock moves oppositely");
  const evidence = marketEvidence(envelope, {
    id: "ai-layer-claim",
    publishedAs: "ai_update",
    layer: layer.layer,
    targets: [layer.symbol],
    sectorSymbols: [],
  });
  assert.equal(evidence.source, layer.source);
  assert.match(evidence.title, new RegExp(layer.name, "u"));
  assert.match(evidence.facts, new RegExp(layer.change.replace("+", "\\+"), "u"));
  assert.doesNotMatch(evidence.facts, new RegExp(layer.constituents[0].symbol, "u"));
});

test("short market names still produce complete publishable price evidence", () => {
  const envelope = marketEnvelope(fixtureInput(), "US");
  const metric = envelope.markets.find((item) => item.symbol === "SPX");
  metric.name = "标普500";
  metric.change = "+1%";
  const evidence = marketEvidence(envelope, {
    id: "short-name-claim", publishedAs: "market_driver", targets: [metric.symbol], sectorSymbols: [],
  });
  assert.ok([...evidence.facts].length >= 20);
  assert.match(evidence.facts, /上一交易日上涨\+1%/u);
  assert.equal(evidence.source, metric.source);
  assert.equal(evidence.publishedAt, envelope.session.windowEnd);
});

test("workflow manifest proves fresh process isolation and reviewer context separation", () => {
  const reportText = "{\"ok\":true}\n";
  const roles = ["planner", "facts", "causal", "adjudicator", "writer", "reviewer", "translator"];
  const manifest = {
    workflowVersion: WORKFLOW_VERSION,
    status: "ready",
    market: "US",
    claimCount: 1,
    reportHash: stableHash(reportText),
    evidence: { verifiedSourceCount: 2, rejectedSourceCount: 0 },
    approval: {
      verdict: "pass",
      reviewArtifact: "artifacts/review-final.json",
      reviewHash: "a".repeat(64),
      claimIds: ["claim-1"],
      scores: [{
        claimId: "claim-1",
        factualAccuracy: 5,
        causalLogic: 4,
        evidenceDirectness: 5,
        readerUtility: 4,
      }],
    },
    agentRuns: roles.map((role, index) => ({
      agentRunId: `run-${index}`,
      role,
      ephemeral: true,
      filesystemIsolation: AGENT_FILESYSTEM_ISOLATION,
      status: "completed",
      promptHash: `prompt-${index}`,
      outputHash: `output-${index}`,
      inputArtifacts: role === "reviewer" ? ["draft.json", "claim-cards.json"] : [],
    })),
  };
  assert.equal(auditWorkflowManifest(manifest, reportText).status, "audited");
  manifest.agentRuns[6].agentRunId = manifest.agentRuns[5].agentRunId;
  assert.throws(() => auditWorkflowManifest(manifest, reportText), /独立进程/);
});

test("targeted repair deterministically restores every passed card", () => {
  const previous = {
    drivers: [
      { claimId: "passed", summary: "approved market copy" },
      { claimId: "failed", summary: "weak market copy" },
    ],
    aiChainUpdates: [],
  };
  const candidate = {
    drivers: [
      { claimId: "passed", summary: "silently rewritten copy" },
      { claimId: "failed", summary: "repaired market copy" },
    ],
    aiChainUpdates: [],
  };
  const result = restorePassedDraftItems(candidate, previous, {
    claimReviews: [
      { claimId: "passed", verdict: "pass" },
      { claimId: "failed", verdict: "revise" },
    ],
  });
  assert.equal(result.drivers[0].summary, "approved market copy");
  assert.equal(result.drivers[1].summary, "repaired market copy");
});

test("targeted repair context excludes claim cards removed by review", () => {
  const result = scopedRepairContext(
    [{ id: "survivor" }],
    {
      draft: {
        drivers: [
          { claimId: "survivor", summary: "keep" },
          { claimId: "removed", summary: "drop" },
        ],
        aiChainUpdates: [{ claimId: "removed-ai", summary: "drop" }],
      },
      review: {
        claimReviews: [
          { claimId: "survivor", verdict: "revise" },
          { claimId: "removed", verdict: "revise" },
          { claimId: "removed-ai", verdict: "pass" },
        ],
      },
    },
  );
  assert.deepEqual(result.draft.drivers.map((item) => item.claimId), ["survivor"]);
  assert.deepEqual(result.draft.aiChainUpdates, []);
  assert.deepEqual(result.review.claimReviews.map((item) => item.claimId), [
    "survivor",
  ]);
  assert.doesNotMatch(JSON.stringify(result.draft), /removed|drop/u);
  assert.equal(result.draft.overviewHeadline, "");
  assert.equal(result.draft.overviewSummary, "keep");
  assert.equal(result.review.summary, "");
});

test("final deterministic gate invalidates only reader-output stages", async () => {
  const workflow = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
  });
  workflow.manifest = {
    stages: {
      planner: { role: "planner", status: "completed" },
      writer: { role: "writer", status: "completed" },
      reviewer: { role: "reviewer", status: "completed" },
      translator: { role: "translator", status: "completed" },
    },
    approval: { verdict: "pass" },
  };
  workflow.saveManifest = async () => {};
  await workflow.invalidateFinalGateStages(new Error("deterministic gate failed"));
  assert.equal(workflow.manifest.stages.planner.status, "completed");
  assert.equal(workflow.manifest.stages.writer.status, "invalid");
  assert.equal(workflow.manifest.stages.reviewer.status, "invalid");
  assert.equal(workflow.manifest.stages.translator.status, "invalid");
  assert.match(
    workflow.manifest.stages.writer.validationError,
    /deterministic gate failed/u,
  );
  assert.equal(workflow.manifest.approval, undefined);
});

test("report construction failures invalidate resumable reader stages", async () => {
  const workflow = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
  });
  workflow.manifest = {
    stages: {
      writer: { role: "writer", status: "completed" },
      reviewer: { role: "reviewer", status: "completed" },
      translator: { role: "translator", status: "completed" },
    },
    approval: { verdict: "pass" },
  };
  workflow.saveManifest = async () => {};
  await assert.rejects(
    () => workflow.buildValidatedFinalReport([], {}, {}, {}),
    /map|undefined|iterable/u,
  );
  assert.equal(workflow.manifest.stages.writer.status, "invalid");
  assert.equal(workflow.manifest.stages.reviewer.status, "invalid");
  assert.equal(workflow.manifest.stages.translator.status, "invalid");
  assert.equal(workflow.manifest.approval, undefined);
});

test("reviewer research repair is capped before starting an over-budget pair", () => {
  const failures = [{ claimId: "first" }, { claimId: "second" }];
  assert.deepEqual(
    budgetedReviewerResearchFailures(failures, 8),
    [{ claimId: "first" }],
  );
  assert.deepEqual(budgetedReviewerResearchFailures(failures, 12), []);
  assert.deepEqual(budgetedReviewerResearchFailures(failures, 4), failures);
});

test("research budget accounts for two-role repairs and concurrent resumes", () => {
  assert.equal(researchRepairFitsBudget("both", 8), true);
  assert.equal(researchRepairFitsBudget("both", 9), false);
  assert.equal(researchRepairFitsBudget("facts", 10), true);

  const anomalies = planFixture().anomalies.slice(0, 2);
  const stages = {
    [`${anomalies[0].id}-facts`]: { status: "completed" },
  };
  assert.equal(assertResearchBatchBudget(6, anomalies, stages), 6);
  assert.throws(
    () => assertResearchBatchBudget(7, anomalies, stages),
    /并行研究/u,
  );
});

test("reviewer-directed research requires fresh queries", () => {
  assert.doesNotThrow(() =>
    assertFreshRepairQueries(
      ["planned seed", "previous adaptive query"],
      ["fresh focused query one", "fresh focused query two"],
      "repair",
    ),
  );
  assert.throws(
    () =>
      assertFreshRepairQueries(
        ["planned seed", "previous adaptive query"],
        ["previous adaptive query", "fresh focused query"],
        "repair",
      ),
    /重复了已消费的计划查询/,
  );
});

test("research repair follows planner priority and repairs the actually missing role", () => {
  const selected = planFixture().anomalies.slice(0, 2);
  const adjudication = {
    claimCards: [],
    decisions: [
      {
        anomalyId: selected[0].id,
        reason: "Both facts and causal evidence are missing.",
      },
      {
        anomalyId: selected[1].id,
        reason: "Facts include typed comparisons, but causal evidence is missing.",
      },
    ],
  };
  const first = selectResearchRepair(selected, adjudication, {
    sources: [{ anomalyId: selected[1].id, role: "facts" }],
  });
  assert.equal(first.anomaly.id, selected[1].id);
  assert.equal(first.repairRole, "causal");
  assert.equal(
    shouldAttemptResearchRepair(adjudication, false, first),
    true,
  );

  adjudication.claimCards = [{ anomalyId: selected[0].id }];
  const second = selectResearchRepair(selected, adjudication, {
    sources: [{ anomalyId: selected[1].id, role: "facts" }],
  });
  assert.equal(second.anomaly.id, selected[1].id);
  assert.equal(second.repairRole, "causal");

  const crossMarketFirst = selectResearchRepair(
    [selected[1], selected[0]],
    { ...adjudication, claimCards: [] },
    { sources: [{ anomalyId: selected[1].id, role: "facts" }] },
  );
  assert.equal(crossMarketFirst.anomaly.id, selected[1].id);
  assert.equal(crossMarketFirst.repairRole, "causal");
  assert.equal(
    shouldAttemptResearchRepair(
      { ...adjudication, claimCards: [] },
      false,
      { anomaly: selected[0], repairRole: "both" },
    ),
    false,
  );
});

test("semantic validation failure invalidates a completed checkpoint", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-workflow-"));
  const workflow = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
  });
  await workflow.initialize();
  workflow.manifest.stages.writer = {
    status: "completed",
    role: "writer",
  };
  await assert.rejects(
    () =>
      workflow.validateAgentStage("writer", () => {
        throw new Error("draft failed semantic validation");
      }),
    /semantic validation/,
  );
  assert.equal(workflow.manifest.stages.writer.status, "invalid");
});

test("research time stops before writing and resumes from its consumed budget", async (t) => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-research-clock-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  let nowMs = Date.now();
  t.mock.method(Date, "now", () => nowMs);
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", workRoot, now: () => new Date(nowMs), researchBudgetMs: 90_000 });
  await workflow.initialize();
  await workflow.startResearchBudget();
  nowMs += 5_000;
  await workflow.finishResearchBudget();
  assert.equal(workflow.manifest.researchElapsedMs, 5_000);
  nowMs += 30_000;
  await workflow.saveManifest();
  assert.equal(workflow.manifest.researchElapsedMs, 5_000);
  assert.equal(workflow.manifest.workflowElapsedMs, 35_000);
  await workflow.startResearchBudget();
  assert.equal(workflow.remainingResearchTime(), 85_000);
  nowMs += 2_000;
  await workflow.finishResearchBudget();
  assert.equal(workflow.manifest.researchElapsedMs, 7_000);
});

test("workflow recovery preserves consumed workflow and research budgets", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-budget-resume-"));
  const options = {
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
    workflowTimeoutMs: 120_000,
    researchBudgetMs: 90_000,
  };
  const first = new MarketWorkflow(options);
  await first.initialize();
  first.workflowSessionIndex = null;
  first.workflowSessionWallStartedAt = null;
  first.manifest.workflowSessions = [{
    startedAt: "2026-08-29T10:00:00.000Z",
    endedAt: "2026-08-29T10:00:40.000Z",
    elapsedMs: 40_000,
    budgetMs: 120_000,
  }];
  first.manifest.workflowElapsedMs = 40_000;
  first.manifest.researchStartedAt = "2026-08-29T10:00:05.000Z";
  first.manifest.researchSessions = [{
    startedAt: "2026-08-29T10:00:05.000Z",
    endedAt: "2026-08-29T10:00:35.000Z",
    elapsedMs: 30_000,
    budgetMs: 90_000,
  }];
  first.manifest.researchElapsedMs = 30_000;
  await writeFile(
    first.manifestPath,
    `${JSON.stringify(first.manifest, null, 2)}\n`,
    "utf8",
  );

  const resumed = new MarketWorkflow(options);
  await resumed.initialize();
  assert.ok(resumed.remainingTime() <= 80_000);
  assert.ok(resumed.remainingTime() > 70_000);
  await resumed.startResearchBudget();
  assert.ok(resumed.remainingResearchTime() <= 60_000);
  assert.ok(resumed.remainingResearchTime() > 50_000);
  assert.equal(resumed.manifest.workflowSessions.length, 2);
  assert.equal(resumed.manifest.researchSessions.length, 2);
});

test("workflow recovery charges an interrupted Agent interval to hard budgets", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-budget-crash-"));
  const startedAtMs = Date.parse("2026-08-29T10:00:00.000Z");
  const first = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
    now: () => new Date(startedAtMs),
    workflowTimeoutMs: 120_000,
    researchBudgetMs: 90_000,
  });
  await first.initialize();
  await first.startResearchBudget();
  const key = "US-EARNINGS-facts";
  first.manifest.workflowSessions[0].elapsedMs = 10_000;
  first.manifest.researchSessions[0].elapsedMs = 10_000;
  first.manifest.stages[key] = {
    status: "running",
    role: "facts",
    agentRunId: "crashed-facts-run",
    promptHash: "crashed-prompt",
    startedAt: new Date(startedAtMs + 10_000).toISOString(),
    timeoutMs: 60_000,
  };
  await writeFile(
    first.manifestPath,
    `${JSON.stringify(first.manifest, null, 2)}\n`,
    "utf8",
  );

  const resumed = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
    now: () => new Date(startedAtMs + 50_000),
    workflowTimeoutMs: 120_000,
    researchBudgetMs: 90_000,
  });
  await resumed.initialize();
  assert.equal(resumed.manifest.workflowSessions[0].elapsedMs, 50_000);
  assert.equal(resumed.manifest.workflowSessions[0].recovered, true);
  assert.ok(resumed.remainingTime() <= 70_000);
  await resumed.startResearchBudget();
  assert.equal(resumed.manifest.researchSessions[0].elapsedMs, 50_000);
  assert.equal(resumed.manifest.researchSessions[0].recovered, true);
  assert.ok(resumed.remainingResearchTime() <= 40_000);
});

test("shadow and publish workflows use immutable separate run identities", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-delivery-mode-"));
  const base = {
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
  };
  const shadow = new MarketWorkflow({ ...base, deliveryMode: "shadow" });
  const publish = new MarketWorkflow({ ...base, deliveryMode: "publish" });
  assert.notEqual(shadow.runDir, publish.runDir);
  await Promise.all([shadow.initialize(), publish.initialize()]);
  assert.equal(shadow.manifest.deliveryMode, "shadow");
  assert.equal(publish.manifest.deliveryMode, "publish");
  assert.match(shadow.runKey, /-shadow$/u);
  assert.match(publish.runKey, /-publish$/u);
});

test("workflow upgrades preserve legacy manifests and snapshot bytes while current-version checkpoints still resume", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-version-resume-"));
  try {
    const options = { input: fixtureInput(), market: "US", deliveryMode: "shadow", completeRecap: true, workRoot };
    const current = new MarketWorkflow(options);
    const common = `US-${current.envelope.marketAsOf}-${current.inputHash.slice(0, 12)}`;
    const priorKeys = [`${common}-shadow-complete`, `${common}-stock-daily-multi-agent-v61-shadow-complete`];
    const priorManifest = JSON.stringify({ workflowVersion: "stock-daily-multi-agent-v61", status: "failed", inputHash: current.inputHash, market: "US", deliveryMode: "shadow", agentRuns: [], lastError: "Unsupported old snapshot date", legacyMarker: "must remain unchanged" });
    const priorSnapshot = "Frozen original bytes and previous parser fields; intentionally not a current snapshot book.\n";
    for (const key of priorKeys) {
      const dir = resolve(workRoot, key);
      await mkdir(resolve(dir, "artifacts"), { recursive: true });
      await writeFile(resolve(dir, "manifest.json"), priorManifest);
      await writeFile(resolve(dir, "artifacts/recap-source-snapshots.json"), priorSnapshot);
    }
    await current.initialize();
    assert.ok(!priorKeys.includes(current.runKey));
    assert.ok(current.runKey.includes(WORKFLOW_VERSION));
    assert.equal(current.manifest.legacyMarker, undefined);
    assert.equal(current.searchQueryCount, 0);
    current.manifest.currentMarker = "resume this current checkpoint";
    await current.saveManifest();
    const resumed = new MarketWorkflow(options);
    await resumed.initialize();
    assert.equal(resumed.runDir, current.runDir);
    assert.equal(resumed.manifest.currentMarker, "resume this current checkpoint");
    for (const key of priorKeys) {
      assert.equal(await readFile(resolve(workRoot, key, "manifest.json"), "utf8"), priorManifest);
      assert.equal(await readFile(resolve(workRoot, key, "artifacts/recap-source-snapshots.json"), "utf8"), priorSnapshot);
    }
  } finally { await rm(workRoot, { recursive: true, force: true }); }
});

test("workflow recovery charges searches persisted before an Agent interruption", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-search-resume-"));
  const options = {
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
  };
  const first = new MarketWorkflow(options);
  await first.initialize();
  const key = "US-EARNINGS-causal";
  first.manifest.stages[key] = {
    status: "running",
    role: "causal",
    agentRunId: "interrupted-causal-run",
    promptHash: "interrupted-prompt",
    startedAt: "2026-08-29T10:00:00.000Z",
  };
  await Promise.all([
    writeFile(
      resolve(first.runDir, "events", `${key}.jsonl`),
      `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "search",
            queries: ["first persisted query", "second persisted query"],
          },
        },
      })}\n`,
      "utf8",
    ),
    writeFile(
      first.manifestPath,
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);

  const resumed = new MarketWorkflow(options);
  await resumed.initialize();
  assert.equal(resumed.searchQueryCount, 2);
  assert.equal(resumed.manifest.searchQueryCount, 2);
  assert.equal(resumed.manifest.stages[key].status, "interrupted");
  assert.equal(
    resumed.manifest.failedAgentRuns.find(
      (run) => run.agentRunId === "interrupted-causal-run",
    )?.searchCount,
    2,
  );
});

test("supplemental research resumes at twelve queries only with matching inputs and immutable outputs", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-supplemental-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", deliveryMode: "shadow", workRoot: root });
  await workflow.initialize();
  const plan = planFixture();
  const anomaly = plan.anomalies[0];
  const key = `${anomaly.id}-facts-directed-test`;
  const payload = { market: "US", marketAsOf: workflow.envelope.marketAsOf, session: workflow.envelope.session, sourceDomains: workflow.researchSourceDomains, anomaly };
  const promptSuffix = workflow.researchPromptSuffix(anomaly, "facts", "Find the missing earnings comparison.");
  const fingerprint = await agentStageFingerprint("facts", payload, promptSuffix);
  const output = researchFixture("facts", anomaly, workflow.envelope);
  const outputText = JSON.stringify(output);
  const events = [...output.queries.map((query) => JSON.stringify({ type: "item.completed", item: { type: "web_search", action: { type: "search", queries: [query] } } })), JSON.stringify({ type: "turn.completed" })].join("\n");
  const original = { status: "completed", role: "facts", researchInput: { payload, promptSuffix }, ...fingerprint, outputHash: stableHash(outputText), eventHash: stableHash(events) };
  workflow.manifest.stages[key] = structuredClone(original);
  workflow.searchQueryCount = 12;
  await writeFile(resolve(workflow.runDir, "artifacts", `${key}.json`), outputText);
  await writeFile(resolve(workflow.runDir, "events", `${key}.jsonl`), events);
  const restored = await workflow.restoreSupplementalResearch(plan, []);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].sources[0].facts, output.sources[0].facts);
  assert.equal(workflow.searchQueryCount, 12);
  workflow.manifest.stages[key].promptHash = "obsolete-prompt";
  assert.deepEqual(await workflow.restoreSupplementalResearch(plan, []), []);
  workflow.manifest.stages[key] = structuredClone(original);
  workflow.manifest.stages[key].researchInput.payload.anomaly.target = "unrelated";
  assert.deepEqual(await workflow.restoreSupplementalResearch(plan, []), []);
  workflow.manifest.stages[key] = structuredClone(original);
  await writeFile(resolve(workflow.runDir, "events", `${key}.jsonl`), "tampered");
  assert.deepEqual(await workflow.restoreSupplementalResearch(plan, []), []);
  assert.equal(workflow.searchQueryCount, 12);
});

test("query checkpoint recovery verifies artifacts and preserves consumed search budget", async (t) => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-query-recheck-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", previousReport: null, codexBin: "/unused/codex", workRoot });
  await workflow.initialize();
  const anomaly = planFixture().anomalies[0];
  const role = "causal";
  const key = `${anomaly.id}-${role}`;
  const output = researchFixture(role, anomaly, workflow.envelope);
  output.queries[1] = "Dow Jones August 21 2026 earnings reaction market close";
  const outputText = JSON.stringify(output);
  const eventsText = [...output.queries.map((query) => JSON.stringify({ type: "item.completed", item: { type: "web_search", action: { type: "search", queries: [query] } } })), JSON.stringify({ type: "turn.completed" })].join("\n");
  const payload = { market: workflow.market, marketAsOf: workflow.envelope.marketAsOf, session: workflow.envelope.session, sourceDomains: publishableExternalSourceDomains(), anomaly };
  const fingerprint = await agentStageFingerprint(role, payload, workflow.researchPromptSuffix(anomaly, role));
  const originalStage = { status: "invalid", role, error: "causal.queries[1] 必须保留明确的交易日和所研究市场或跨市场标记", ...fingerprint, outputHash: stableHash(outputText), eventHash: stableHash(eventsText) };
  workflow.searchQueryCount = 12;
  workflow.manifest.searchQueryCount = 12;
  const outputPath = resolve(workflow.runDir, "artifacts", `${key}.json`);
  const eventsPath = resolve(workflow.runDir, "events", `${key}.jsonl`);
  await Promise.all([writeFile(outputPath, outputText), writeFile(eventsPath, eventsText)]);
  workflow.manifest.stages[key] = { ...originalStage };
  await workflow.revalidateResearchQueryCheckpoints({ anomalies: [anomaly] });
  assert.equal(workflow.manifest.stages[key].status, "completed");
  assert.equal(workflow.manifest.stages[key].previousValidationError, originalStage.error);
  assert.equal(workflow.searchQueryCount, 12);
  assert.equal(workflow.manifest.searchQueryCount, 12);
  const invocation = { key, role, payload, inputArtifacts: ["plan.json"] };
  workflow.manifest.researchSessions = [{ elapsedMs: workflow.researchBudgetMs, endedAt: new Date().toISOString() }];
  assert.equal((await workflow.runAgent(invocation)).resumed, true);
  workflow.manifest.stages[key].promptHash = "obsolete-prompt";
  workflow.searchQueryCount = 11;
  await assert.rejects(workflow.runAgent(invocation), /搜索预算不足/);
  workflow.searchQueryCount = 10;
  workflow.reservedSearchQueryCount = 2;
  await assert.rejects(workflow.runAgent(invocation), /搜索预算不足/);
  assert.equal(workflow.reservedSearchQueryCount, 2);
  workflow.reservedSearchQueryCount = 0;
  workflow.searchQueryCount = 8;
  await assert.rejects(workflow.runAgent(invocation), /二十分钟预算/u);
  assert.equal(workflow.reservedSearchQueryCount, 0);
  workflow.searchQueryCount = 12;
  for (const changed of ["output", "events", "prompt", "seed", "other-error"]) {
    workflow.manifest.stages[key] = { ...originalStage };
    await writeFile(outputPath, changed === "output" ? `${outputText} ` : outputText);
    await writeFile(eventsPath, changed === "events" ? `${eventsText}\n` : eventsText);
    if (changed === "prompt") workflow.manifest.stages[key].promptHash = "different-prompt";
    if (changed === "other-error") workflow.manifest.stages[key].error = "facts contain unsupported numbers";
    const checkAnomaly = changed === "seed" ? { ...anomaly, causalQueries: ["US 2026-08-21 other seed"] } : anomaly;
    await workflow.revalidateResearchQueryCheckpoints({ anomalies: [checkAnomaly] });
    assert.equal(workflow.manifest.stages[key].status, "invalid", changed);
    assert.equal(workflow.searchQueryCount, 12);
  }
});

test("no-claims completion replaces the canonical adjudication artifact", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-no-claims-"));
  const workflow = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
  });
  await workflow.initialize();
  const plan = planFixture();
  const adjudication = {
    contractVersion: "stock-daily-adjudication-v1",
    market: "US",
    decisions: plan.anomalies.map((anomaly) => ({
      anomalyId: anomaly.id,
      verdict: "rejected",
      publishedAs: "none",
      reason: "现有事实与因果证据不足以形成可发布归因。",
    })),
    claimCards: [],
  };
  const canonicalPath = resolve(workflow.runDir, "artifacts/adjudication.json");
  await writeFile(
    canonicalPath,
    `${JSON.stringify({ stale: true, claimCards: [{ id: "stale" }] })}\n`,
    "utf8",
  );
  workflow.manifest.evidence = {
    verifiedSourceCount: 99,
    rejectedSourceCount: 99,
  };
  const result = await workflow.finishNoClaims(
    adjudication,
    plan,
    { sources: [], rejected: [{ reason: "review-directed replacement" }] },
  );
  assert.equal(result.status, "no_claims");
  const saved = JSON.parse(await readFile(canonicalPath, "utf8"));
  assert.equal(saved.claimCards.length, 0);
  assert.deepEqual(
    saved.decisions.map((item) => item.verdict),
    ["rejected", "rejected", "rejected"],
  );
  assert.equal(
    workflow.manifest.stages["deterministic-no-claims-finalization"].outputHash,
    stableHash(saved),
  );
  assert.deepEqual(workflow.manifest.evidence, {
    verifiedSourceCount: 0,
    rejectedSourceCount: 1,
  });
});

test("a terminal no-claim run starts a fresh isolated research attempt", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-no-claim-retry-"));
  const firstInput = fixtureInput();
  const first = new MarketWorkflow({
    input: firstInput,
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    deliveryMode: "publish",
    workRoot,
  });
  await first.initialize();
  first.manifest.status = "no_claims";
  first.manifest.completedAt = "2026-08-29T10:10:00.000Z";
  first.manifest.stages = {
    "old-facts": { status: "completed", role: "facts" },
  };
  first.manifest.agentRuns = [{ agentRunId: "old-facts", role: "facts" }];
  await writeFile(
    first.manifestPath,
    `${JSON.stringify(first.manifest, null, 2)}\n`,
    "utf8",
  );

  const retryInput = { ...fixtureInput(), runId: "fresh-retry-run-id" };
  const retry = new MarketWorkflow({
    input: retryInput,
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    deliveryMode: "publish",
    workRoot,
  });
  await retry.initialize();
  assert.notEqual(retry.runDir, first.runDir);
  assert.match(retry.runKey, /-publish-attempt-/u);
  assert.equal(retry.manifest.status, "running");
  assert.deepEqual(retry.manifest.stages, {});
  assert.deepEqual(retry.manifest.agentRuns, []);
  assert.equal(retry.manifest.batchRunId, retryInput.runId);
  assert.equal(
    JSON.parse(await readFile(retry.manifest.inputPath, "utf8")).runId,
    retryInput.runId,
  );
});

test("an exhausted failed research attempt is retained while the next trigger starts fresh", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-exhausted-retry-"));
  try {
    const options = { input: fixtureInput(), market: "US", deliveryMode: "shadow", workRoot };
    const first = new MarketWorkflow(options);
    await first.initialize();
    first.manifest.status = "failed";
    first.manifest.lastError = "剩余搜索预算不足以恢复全部待完成的并行研究";
    first.manifest.searchQueryCount = 10;
    first.manifest.workflowElapsedMs = 720_000;
    await writeFile(first.manifestPath, JSON.stringify(first.manifest));
    const retry = new MarketWorkflow(options);
    await retry.initialize();
    assert.notEqual(retry.runKey, first.runKey);
    assert.equal(retry.searchQueryCount, 0);
    assert.deepEqual(retry.manifest.stages, {});
    const retained = JSON.parse(await readFile(first.manifestPath));
    assert.equal(retained.status, "failed");
    assert.equal(retained.workflowElapsedMs, 720_000);
    const interruptedRetry = new MarketWorkflow(options);
    await interruptedRetry.initialize();
    assert.equal(interruptedRetry.runKey, retry.runKey);
  } finally { await rm(workRoot, { recursive: true, force: true }); }
});

test("an interrupted workflow adopts the current ingestion batch identity", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-batch-rebind-"));
  const firstInput = fixtureInput();
  const first = new MarketWorkflow({
    input: firstInput,
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    deliveryMode: "publish",
    batchMarkets: ["CN", "US"],
    workRoot,
  });
  await first.initialize();
  const firstInputPath = first.manifest.inputPath;
  first.manifest.status = "failed";
  first.manifest.publication = { status: "failed" };
  first.manifest.ingestionFinalization = { status: "failed" };
  await writeFile(
    first.manifestPath,
    `${JSON.stringify(first.manifest, null, 2)}\n`,
    "utf8",
  );

  const retryInput = { ...fixtureInput(), runId: "current-ingestion-run-id" };
  const retry = new MarketWorkflow({
    input: retryInput,
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    deliveryMode: "publish",
    batchMarkets: ["US"],
    workRoot,
  });
  await retry.initialize();
  assert.equal(retry.runDir, first.runDir);
  assert.equal(retry.manifest.batchRunId, retryInput.runId);
  assert.notEqual(retry.manifest.inputPath, firstInputPath);
  assert.equal(
    JSON.parse(await readFile(retry.manifest.inputPath, "utf8")).runId,
    retryInput.runId,
  );
  assert.equal(
    JSON.parse(await readFile(firstInputPath, "utf8")).runId,
    firstInput.runId,
  );
  assert.deepEqual(retry.manifest.batchMarkets, ["US"]);
  assert.equal(retry.manifest.publication, undefined);
  assert.equal(retry.manifest.ingestionFinalization, undefined);
});

test("source verification is aborted by the workflow hard deadline", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-source-timeout-"));
  let aborted = false;
  const workflow = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
    sourceVerifier: async (_outputs, _envelope, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  await workflow.initialize();
  workflow.deadline = Date.now() + 75;
  const startedAt = Date.now();
  await assert.rejects(
    () => workflow.verifyEvidence([]),
    /四十五分钟硬停止/,
  );
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("failed same-key research queries remain consumed", () => {
  const workflow = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
  });
  workflow.manifest = {
    stages: {
      repair: { status: "invalid", agentRunId: "completed-run" },
    },
    agentRuns: [
      { key: "repair", agentRunId: "completed-run", queries: ["query one"] },
    ],
    failedAgentRuns: [
      { key: "repair", agentRunId: "failed-run", queries: ["query two"] },
    ],
  };
  assert.deepEqual(workflow.consumedQueriesBefore(["repair"]), [
    "query one",
    "query two",
  ]);
  workflow.manifest.stages.repair.status = "completed";
  assert.deepEqual(workflow.consumedQueriesBefore(["repair"]), ["query two"]);
});

test("validated market plan is frozen across workflow recovery", async () => {
  const workRoot = await mkdtemp(resolve(tmpdir(), "stock-daily-plan-checkpoint-"));
  const workflow = new MarketWorkflow({
    input: fixtureInput(),
    market: "US",
    previousReport: null,
    codexBin: "/unused/codex",
    workRoot,
  });
  await workflow.initialize();
  const plan = validatePlan(planFixture(), workflow.envelope);
  const fingerprint = await agentStageFingerprint("planner", workflow.envelope);
  await writeFile(
    resolve(workflow.runDir, "artifacts/plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8",
  );
  workflow.manifest.stages["market-plan"] = {
    role: "deterministic_plan_checkpoint",
    status: "completed",
    inputHash: stableHash({
      workflowVersion: WORKFLOW_VERSION,
      marketInputHash: workflow.inputHash,
    }),
    outputHash: stableHash(plan),
    plannerPromptHash: fingerprint.promptHash,
    plannerSchemaHash: fingerprint.schemaHash,
  };
  const resumed = await workflow.marketPlan();
  assert.deepEqual(resumed, plan);
  assert.equal(workflow.manifest.stages["market-plan"].status, "completed");

  let reranPlanner = false;
  workflow.manifest.stages["market-plan"].plannerPromptHash = "stale-prompt";
  workflow.runValidatedAgentStage = async () => {
    reranPlanner = true;
    return plan;
  };
  await workflow.marketPlan();
  assert.equal(reranPlanner, true);
  assert.equal(
    workflow.manifest.stages["market-plan"].plannerPromptHash,
    fingerprint.promptHash,
  );
});

test("market selection advances independently and forced replay stays scoped", () => {
  const input = fixtureInput();
  const previous = { marketAsOf: { CN: "2026-08-20", US: "2026-08-21" } };
  assert.deepEqual(advancedMarkets(input, previous), ["CN"]);
  assert.deepEqual(advancedMarkets(input, previous, "US"), ["US"]);
  assert.deepEqual(
    filterHandledMarkets(input, ["CN", "US"], {
      CN: "2026-08-21",
      US: "2026-08-20",
    }),
    ["US"],
  );
  assert.deepEqual(
    selectWorkflowMarkets(input, previous, { forceMarkets: true }),
    ["CN", "US"],
  );
  assert.deepEqual(
    selectWorkflowMarkets(input, previous, {
      market: "CN",
      forceMarkets: true,
      handledMarketAsOf: { CN: "2099-01-01" },
    }),
    ["CN"],
  );
});

test("weekly replay acceptance enforces recall, review scores and latency", () => {
  const expectedSessions = Array.from({ length: 10 }, (_value, index) => ({
    market: index < 5 ? "CN" : "US",
    marketAsOf: `2026-08-${String(24 + (index % 5)).padStart(2, "0")}`,
  }));
  const runs = expectedSessions.map((session, index) => ({
    ...session,
    status: "ready",
    deliveryMode: "shadow",
    validationStatus: "valid",
    durationMs: index === 9 ? 40 * 60_000 : 20 * 60_000,
    cards:
      index === 9
        ? [{
            targets: ["DGS10"],
            sources: ["https://apnews.com/article/verified"],
            eventText: "Warsh speech repriced Treasury yields",
          }]
        : [],
    scores: [{
      claimId: `claim-${index}`,
      factualAccuracy: 5,
      causalLogic: 4,
      evidenceDirectness: 5,
      readerUtility: 4,
    }],
  }));
  const labels = {
    contractVersion: "stock-daily-replay-labels-v1",
    labelReview: { status: "human-confirmed", reviewedBy: "test-fixture", reviewedAt: "2026-09-01T12:00:00Z" },
    expectedSessions,
    expectedSignals: [{
      id: "warsh-yield",
      market: "US",
      marketAsOf: "2026-08-28",
      target: "DGS10",
      sourceIncludes: ["https://apnews.com/article/verified"],
      eventIncludes: ["Warsh"],
    }],
  };
  const accepted = summarizeReplayAcceptance(runs, labels);
  assert.equal(accepted.passed, true);
  assert.equal(accepted.quality.recall, 1);
  assert.equal(accepted.latency.withinThirtyRate, 0.9);

  runs[9].cards = [];
  const rejected = summarizeReplayAcceptance(runs, labels);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.quality.recall, 0);
});

test("weekly replay acceptance does not hide a later interrupted attempt", () => {
  const earlier = {
    market: "US",
    marketAsOf: "2026-08-28",
    completedAtMs: 10,
    durationMs: 40,
    status: "failed",
  };
  const later = {
    ...earlier,
    completedAtMs: 20,
    durationMs: 15,
    status: "ready",
  };
  assert.deepEqual(selectLatestReplayRuns([earlier, later]), [later]);

  const interrupted = {
    ...later,
    status: "running",
    validationStatus: "invalid",
    completedAtMs: 30,
  };
  assert.deepEqual(selectLatestReplayRuns([later, interrupted]), [interrupted]);
});

test("weekly replay acceptance reports an unfinished manifest instead of aborting", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-unfinished-run-"));
  const runDir = resolve(root, "run");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    resolve(runDir, "manifest.json"),
    `${JSON.stringify({
      workflowVersion: WORKFLOW_VERSION,
      runKey: "CN-unfinished",
      status: "running",
      deliveryMode: "shadow",
      market: "CN",
      marketAsOf: "2026-08-24",
      startedAt: "2026-08-24T08:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
  const labelsPath = resolve(root, "labels.json");
  await writeFile(
    labelsPath,
    `${JSON.stringify({
      contractVersion: "stock-daily-replay-labels-v1",
      expectedSessions: [{ market: "CN", marketAsOf: "2026-08-24" }],
      expectedSignals: [],
    }, null, 2)}\n`,
    "utf8",
  );
  const result = await evaluateReplayAcceptance({
    runsRoot: root,
    labelsPath,
  });
  assert.equal(result.passed, false);
  assert.equal(result.sessions[0].status, "running");
  assert.equal(result.sessions[0].validationStatus, "invalid");
});

test("weekly replay acceptance rejects an unvalidated no-claim manifest", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stock-daily-no-claim-"));
  const runDir = resolve(root, "run");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    resolve(runDir, "manifest.json"),
    `${JSON.stringify({
      workflowVersion: WORKFLOW_VERSION,
      runKey: "CN-invalid-no-claim",
      status: "no_claims",
      deliveryMode: "shadow",
      market: "CN",
      marketAsOf: "2026-08-24",
      startedAt: "2026-08-24T08:00:00.000Z",
      completedAt: "2026-08-24T08:01:00.000Z",
      inputPath: resolve(runDir, "missing-input.json"),
    }, null, 2)}\n`,
    "utf8",
  );
  const labelsPath = resolve(root, "labels.json");
  await writeFile(
    labelsPath,
    `${JSON.stringify({
      contractVersion: "stock-daily-replay-labels-v1",
      expectedSessions: [{ market: "CN", marketAsOf: "2026-08-24" }],
      expectedSignals: [],
    }, null, 2)}\n`,
    "utf8",
  );
  const result = await evaluateReplayAcceptance({
    runsRoot: root,
    labelsPath,
  });
  assert.equal(result.passed, false);
  assert.equal(result.invalidRuns.length, 1);
  assert.equal(result.invalidRuns[0].validationStatus, "invalid");
});

test("weekly replay acceptance maps AI updates to deterministic layer targets", () => {
  assert.deepEqual(
    publishedCardSummary({
      market: "CN",
      layer: "applications",
      title: "海外软件行情映射提振国内应用层",
      evidence: [{ source: "https://finance.sina.com.cn/example" }],
    }),
    {
      title: "海外软件行情映射提振国内应用层",
      eventText: "海外软件行情映射提振国内应用层",
      targets: ["AI-CN-applications"],
      sources: ["https://finance.sina.com.cn/example"],
    },
  );
});

test("parallel research settles running siblings before reporting failure", async () => {
  let completed = false;
  const sibling = new Promise((resolve) => setTimeout(() => { completed = true; resolve("done"); }, 20));
  await assert.rejects(settleAgentResults([Promise.reject(new Error("research failed")), sibling]), /research failed/);
  assert.equal(completed, true);
});

test("research uses the remaining pair of queries for a different unresolved anomaly without exceeding twelve", async () => {
  for (const consumed of [8, 10]) {
    const root = await mkdtemp(resolve(tmpdir(), "stock-daily-two-repairs-"));
    try {
      const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", deliveryMode: "shadow", workRoot: root });
      const initialize = workflow.initialize.bind(workflow);
      workflow.initialize = async () => { await initialize(); workflow.searchQueryCount = consumed; };
      const plan = planFixture();
      workflow.marketPlan = async () => plan;
      workflow.revalidateResearchQueryCheckpoints = async () => {};
      workflow.assertResearchCapacity = async () => 0;
      workflow.researchAnomaly = async () => [];
      const ledger = { sources: [{ anomalyId: plan.anomalies[0].id, role: "facts" }, { anomalyId: plan.anomalies[1].id, role: "causal" }], rejected: [] };
      workflow.verifyEvidence = async () => ledger;
      workflow.adjudicate = async () => ({ claimCards: [], decisions: plan.anomalies.slice(0, 2).map((a) => ({ anomalyId: a.id, verdict: "unresolved", publishedAs: "none", reason: "Independent support still missing" })) });
      const repairs = [];
      workflow.researchAnomalyRole = async (anomaly, role) => {
        workflow.searchQueryCount += 2;
        repairs.push([anomaly.id, role]);
        return { anomalyId: anomaly.id, role, sources: [] };
      };
      workflow.finishNoClaims = async () => ({ status: "no_claims" });
      assert.equal((await workflow.run()).status, "no_claims");
      assert.equal(workflow.searchQueryCount, 12);
      assert.deepEqual(repairs, [[plan.anomalies[0].id, "causal"], [plan.anomalies[1].id, "facts"]].slice(0, consumed === 8 ? 2 : 1));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("research batch preflight charges stale or tampered completed checkpoints before launching", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "research-capacity-"));
  try {
    const workflow = new MarketWorkflow({ input: fixtureInput(), market: "US", deliveryMode: "shadow", workRoot: root });
    const anomaly = planFixture().anomalies[0];
    workflow.manifest = { stages: {} };
    workflow.searchQueryCount = 10;
    await mkdir(resolve(workflow.runDir, "artifacts"), { recursive: true });
    await mkdir(resolve(workflow.runDir, "events"), { recursive: true });
    const payload = { market: workflow.market, marketAsOf: workflow.envelope.marketAsOf, session: workflow.envelope.session, sourceDomains: workflow.researchSourceDomains, anomaly };
    for (const role of ["facts", "causal"]) {
      const key = `${anomaly.id}-${role}`;
      const fingerprint = await agentStageFingerprint(role, payload, workflow.researchPromptSuffix(anomaly, role));
      const output = '{}', events = '{}\n';
      await writeFile(resolve(workflow.runDir, "artifacts", `${key}.json`), output);
      await writeFile(resolve(workflow.runDir, "events", `${key}.jsonl`), events);
      workflow.manifest.stages[key] = { status: "completed", ...fingerprint, outputHash: stableHash(output), eventHash: stableHash(events) };
    }
    assert.equal(await workflow.assertResearchCapacity([anomaly]), 0);
    workflow.manifest.stages[`${anomaly.id}-facts`].promptHash = "old-prompt";
    assert.equal(await workflow.assertResearchCapacity([anomaly]), 2);
    await writeFile(resolve(workflow.runDir, "events", `${anomaly.id}-causal.jsonl`), "changed");
    await assert.rejects(workflow.assertResearchCapacity([anomaly]), /预算不足以恢复全部/);
    assert.equal(workflow.reservedSearchQueryCount, 0);
    assert.equal(workflow.searchQueryCount, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("search budget counts only actual search actions", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        type: "web_search",
        query: "real query ...",
        action: { type: "search", queries: ["real query"] },
      },
    },
    {
      type: "item.completed",
      item: {
        type: "web_search",
        query: "'Updated'",
        action: { type: "other" },
      },
    },
    { type: "turn.completed" },
  ];
  events.splice(1, 0, {
    type: "item.completed",
    item: {
      type: "web_search",
      action: { type: "search", queries: ["real query"] },
    },
  });
  const parsed = parseAgentEvents(
    events.map((item) => JSON.stringify(item)).join("\n"),
    {
      requireSearch: true,
    },
  );
  assert.deepEqual(parsed.queries, ["real query"]);
  assert.equal(parsed.searchCount, 2);
});
