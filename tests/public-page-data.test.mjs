import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  buildReportContent,
  validateInput,
  validateReport,
} from "../scripts/daily-publish.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 24683 } },
  });
});

after(async () => {
  await vite?.close();
});

test("daily HTML and hydration data exclude internal attribution fields", async () => {
  const { default: Document, publicPageData } = await vite.ssrLoadModule(
    "/src/App.tsx",
  );
  const input = validateInput(fixtureInput());
  const validatedReport = validateReport(fixtureReport(input), input);
  const report = {
    ...JSON.parse(buildReportContent(input, validatedReport)),
    reportDate: input.reportDate,
    edition: 1,
    generatedAt: input.collectedAt,
    dataCut: "CN 2026-08-21 · US 2026-08-21",
  };
  const internalCopy =
    "该来源只覆盖公司自身，不能据此声称全部成分受到同一原因推动。";

  report.agentModel = "openai/codex-scheduled";
  report.drivers[0].mechanism = internalCopy;
  report.aiChainUpdates[0].implication = internalCopy;
  report.aiChainViews.CN.mechanism = internalCopy;
  report.translations.en.drivers[0].mechanism = "INTERNAL DRIVER COPY";
  report.translations.en.aiChainUpdates[0].implication = "INTERNAL AI COPY";
  report.translations.en.aiChainViews.CN.mechanism = "INTERNAL VIEW COPY";
  report.researchAudit = { internalCopy };

  const data = {
    kind: "daily",
    language: "zh",
    market: "US",
    requestUrl: "https://stock-daily-8k4.pages.dev/?market=us&lang=zh",
    report,
    archive: [],
    sectorHeat: { current: [], streaks: [], threshold: 1.5 },
    weekEvents: null,
    thesisLedger: [],
    thesisHistory: [],
  };
  const readerData = publicPageData(data);

  assert.equal(Object.hasOwn(readerData.report, "agentModel"), false);
  assert.equal(Object.hasOwn(readerData.report, "contractVersion"), false);
  assert.equal(Object.hasOwn(readerData.report, "researchAudit"), false);
  assert.equal(Object.hasOwn(readerData.report.drivers[0], "mechanism"), false);
  assert.equal(
    Object.hasOwn(readerData.report.aiChainUpdates[0], "implication"),
    false,
  );
  assert.equal(
    Object.hasOwn(readerData.report.aiChainViews.CN, "mechanism"),
    false,
  );
  assert.equal(
    Object.hasOwn(readerData.report.translations.en.drivers[0], "mechanism"),
    false,
  );

  const html = renderToStaticMarkup(React.createElement(Document, { data }));
  assert.doesNotMatch(
    html,
    /该来源|不能据此|INTERNAL (?:DRIVER|AI|VIEW) COPY|openai\/codex-scheduled|researchAudit|contractVersion/,
  );
  assert.match(html, /snapshot-causal-summary/);
  assert.match(html, /stock-daily-data/);
});
