import { writeFile } from "node:fs/promises";
import { dailyCutoffAt } from "./daily-policy.mjs";

const projectRoot = new URL("../", import.meta.url);
const reportsPath = new URL("data/reports.json", projectRoot);
const baseUrl = (
  process.argv.find((argument) => argument.startsWith("--base-url="))?.slice(11) ??
  "https://stock-daily-4ip.pages.dev"
).replace(/\/$/, "");

async function fetchJson(path) {
  const response = await fetch(
    `${baseUrl}${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

function verifyReport(report) {
  if (
    !report ||
    report.isSample !== false ||
    report.agentModel?.includes("manual") ||
    !report.marketViews?.CN ||
    !report.marketViews?.US
  ) {
    throw new Error(`${report?.reportDate ?? "unknown"} is not an audited Agent report`);
  }

  const marketCounts = { CN: 0, US: 0 };
  for (const market of report.markets ?? []) {
    if (!(market.region in marketCounts) || !market.source?.startsWith("https://")) {
      throw new Error(`${report.reportDate} contains an untraceable market metric`);
    }
    marketCounts[market.region] += 1;
  }
  if (marketCounts.CN !== 2 || marketCounts.US !== 4) {
    throw new Error(`${report.reportDate} has incomplete CN/US market metrics`);
  }

  const storyCounts = { CN: 0, US: 0 };
  const cutoff = Date.parse(
    dailyCutoffAt(report.reportDate, report.updateKind ?? "morning"),
  );
  for (const story of report.stories ?? []) {
    if (
      !story.source?.startsWith("https://") ||
      !story.publishedAt ||
      Number.isNaN(Date.parse(story.publishedAt)) ||
      Date.parse(story.publishedAt) > cutoff ||
      !Array.isArray(story.regions) ||
      story.regions.length === 0
    ) {
      throw new Error(`${report.reportDate} contains an unaudited story`);
    }
    for (const region of new Set(story.regions)) {
      if (!(region in storyCounts)) {
        throw new Error(`${report.reportDate} contains an invalid story region`);
      }
      storyCounts[region] += 1;
    }
  }
  const weekday = new Date(
    `${report.reportDate}T12:00:00.000Z`,
  ).getUTCDay();
  const minimumPerMarket = weekday === 0 || weekday === 6 ? 3 : 4;
  if (
    storyCounts.CN < minimumPerMarket ||
    storyCounts.US < minimumPerMarket ||
    storyCounts.CN > 6 ||
    storyCounts.US > 6
  ) {
    throw new Error(
      `${report.reportDate} must contain ${minimumPerMarket}–6 stories per market`,
    );
  }
}

const archivePayload = await fetchJson("/api/reports?limit=100");
const dates = archivePayload.data?.map((item) => item.reportDate);
if (!Array.isArray(dates) || dates.length === 0) {
  throw new Error("Production archive is empty");
}

const reports = await Promise.all(
  dates.map(async (date) => {
    const payload = await fetchJson(`/api/reports/${date}`);
    verifyReport(payload.data);
    return payload.data;
  }),
);
reports.sort((left, right) => right.reportDate.localeCompare(left.reportDate));

await writeFile(reportsPath, `${JSON.stringify(reports, null, 2)}\n`);
console.log(`Synced ${reports.length} audited reports from ${baseUrl}.`);
