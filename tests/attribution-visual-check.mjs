import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const baseUrl = (process.env.STOCK_DAILY_URL ?? "http://127.0.0.1:8788").replace(/\/$/u, "");
const runtimeModules = process.env.CODEX_NODE_MODULES;
if (!runtimeModules) {
  throw new Error("CODEX_NODE_MODULES must point to a Node.js package directory containing Playwright");
}
const runtimeRequire = createRequire(resolve(runtimeModules, "runtime-loader.cjs"));
const { chromium } = runtimeRequire("playwright");
const screenshotDir = resolve("artifacts/screenshots");
const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runToken = String(process.hrtime.bigint());
await mkdir(screenshotDir, { recursive: true });

async function inspect(page, market, language, width) {
  const consoleErrors = [];
  const httpErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push({ status: response.status(), url: response.url() });
    }
  });
  await page.goto(
    `${baseUrl}/?market=${market.toLowerCase()}&lang=${language}&visual=${runToken}`,
    { waitUntil: "domcontentloaded", timeout: 60_000 },
  );
  await page.waitForSelector(".market-snapshot", { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content:
      "html{scroll-behavior:auto!important}.masthead{position:static!important}.skip-link{display:none!important}",
  });
  await page.locator("main details").evaluateAll((elements) => {
    elements.forEach((element) => {
      element.open = true;
    });
  });
  await page.waitForTimeout(150);

  const layout = await page.evaluate(() => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const inspected = [
      ...document.querySelectorAll(
        ".market-snapshot, .market-snapshot section, .market-snapshot article, " +
          ".market-snapshot li, .market-snapshot a, .market-snapshot p, " +
          ".market-snapshot strong",
      ),
    ].filter(visible);
    const clipped = inspected
      .filter((element) => {
        const style = getComputedStyle(element);
        const clippedX =
          ["hidden", "clip"].includes(style.overflowX) &&
          element.scrollWidth > element.clientWidth + 1;
        const clippedY =
          ["hidden", "clip"].includes(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1;
        return clippedX || clippedY;
      })
      .map((element) => ({
        className: String(element.className),
        text: element.textContent.trim().slice(0, 80),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
    const offCanvas = inspected
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.left < -1 || box.right > innerWidth + 1;
      })
      .map((element) => ({
        className: String(element.className),
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
      }));
    const causalSummaries = [...document.querySelectorAll(".snapshot-causal-summary")];
    const causalWidthDeltas = causalSummaries.map((summary) => {
      const row = summary.closest(".snapshot-evidence-row");
      return row
        ? Math.round(row.getBoundingClientRect().width - summary.getBoundingClientRect().width)
        : 0;
    });
    const mainText = document.querySelector("main")?.innerText ?? "";
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      fontsLoaded: document.fonts.status,
      contract: document.querySelector(".page-shell")?.dataset.contract,
      activeMarket: document
        .querySelector('.market-switcher a[aria-current="page"]')
        ?.textContent.trim(),
      indexCount: document.querySelectorAll(".snapshot-item-index").length,
      sectorCount: document.querySelectorAll(
        ".snapshot-sector-grid-complete .snapshot-item-sector",
      ).length,
      aiLayerCount: document.querySelectorAll(".snapshot-item-ai").length,
      evidenceRowCount: document.querySelectorAll(".snapshot-evidence-row").length,
      causeStatusCount: document.querySelectorAll(".snapshot-cause-status").length,
      causalGridCount: document.querySelectorAll(".snapshot-causal-grid").length,
      causalSummaryCount: causalSummaries.length,
      causalSummaryLengths: causalSummaries.map(
        (summary) => [...(summary.textContent ?? "").trim()].length,
      ),
      causalKeyCount: document.querySelectorAll(".snapshot-causal-key").length,
      causalBoundaryCount: document.querySelectorAll(
        ".snapshot-causal-boundary",
      ).length,
      attributionEmptyCount: document.querySelectorAll(
        ".snapshot-group-indices .snapshot-attribution-empty",
      ).length,
      causalWidthDeltas,
      happenedLabelCount: [
        ...document.querySelectorAll("main strong"),
      ].filter((element) => /发生了什么|What happened/u.test(element.textContent)).length,
      whyLabelCount: [...document.querySelectorAll("main")].filter(
        (element) => /为什么|Why it moved/u.test(element.innerText),
      ).length,
      unverifiedCount: (mainText.match(/原因未证实|Cause unverified/gu) ?? []).length,
      rawTimestamps:
        mainText.match(
          /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/gu,
        ) ?? [],
      forbiddenCopy:
        mainText.match(
          /API\s*Skill|market_data_query|codex-daily|agentModel|schemaVersion|contractVersion/giu,
        ) ?? [],
      clipped,
      offCanvas,
    };
  });

  const prefix = `v11-attribution-${language}-${market.toLowerCase()}-${width}`;
  await page.screenshot({
    path: resolve(screenshotDir, `${prefix}-full.png`),
    fullPage: true,
    scale: "css",
  });
  await page.locator(".market-snapshot").screenshot({
    path: resolve(screenshotDir, `${prefix}-market.png`),
  });
  return { layout, consoleErrors, httpErrors };
}

const browserArgs = ["--disable-dev-shm-usage"];
if (/localhost|127\.0\.0\.1|localtest\.me/u.test(baseUrl)) {
  browserArgs.push("--no-proxy-server");
}
const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: browserArgs,
});
const result = {};
for (const language of ["zh", "en"]) {
  for (const market of ["CN", "US"]) {
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      const key = `${language}-${market}-${width}`;
      result[key] = await inspect(page, market, language, width);
      await page.close();
    }
  }
}
await browser.close();

for (const [key, audit] of Object.entries(result)) {
  const [language, market, widthText] = key.split("-");
  const width = Number(widthText);
  const layout = audit.layout;
  const expectedMarketLabel = market;
  assert.ok(layout.scrollWidth <= width, JSON.stringify(result));
  assert.equal(layout.fontsLoaded, "loaded", JSON.stringify(result));
  assert.match(layout.activeMarket, new RegExp(expectedMarketLabel, "u"));
  assert.equal(layout.indexCount, market === "CN" ? 6 : 4, JSON.stringify(result));
  assert.equal(layout.sectorCount, 11, JSON.stringify(result));
  assert.equal(layout.aiLayerCount, 8, JSON.stringify(result));
  assert.equal(layout.causeStatusCount, 0, JSON.stringify(result));
  assert.equal(layout.causalGridCount, 0, JSON.stringify(result));
  assert.equal(layout.causalSummaryCount, layout.evidenceRowCount, JSON.stringify(result));
  assert.ok(
    layout.causalSummaryLengths.every((length) => length >= 100),
    JSON.stringify(result),
  );
  assert.equal(layout.causalKeyCount, layout.causalSummaryCount, JSON.stringify(result));
  assert.equal(
    layout.causalBoundaryCount,
    layout.causalSummaryCount,
    JSON.stringify(result),
  );
  assert.equal(
    layout.attributionEmptyCount,
    market === "CN" ? 1 : 0,
    JSON.stringify(result),
  );
  assert.ok(
    layout.causalWidthDeltas.every((delta) => Math.abs(delta) <= 1),
    JSON.stringify(result),
  );
  assert.equal(layout.happenedLabelCount, 0, JSON.stringify(result));
  assert.equal(layout.whyLabelCount, 0, JSON.stringify(result));
  assert.equal(layout.unverifiedCount, 0, JSON.stringify(result));
  assert.deepEqual(layout.rawTimestamps, [], JSON.stringify(result));
  assert.deepEqual(layout.forbiddenCopy, [], JSON.stringify(result));
  assert.deepEqual(layout.clipped, [], JSON.stringify(result));
  assert.deepEqual(layout.offCanvas, [], JSON.stringify(result));
  assert.deepEqual(audit.consoleErrors, [], JSON.stringify(result));
  assert.deepEqual(audit.httpErrors, [], JSON.stringify(result));
}

console.log(JSON.stringify(result, null, 2));
