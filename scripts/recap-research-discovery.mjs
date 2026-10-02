import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stableHash } from "./daily-workflow-core.mjs";
import { openedSourceFromSnapshot, SOURCE_SNAPSHOT_VERSION } from "./evidence-source-snapshots.mjs";
import { decodeSourceBody } from "./daily-source-audit.mjs";
import { yahooLiveArticleIdentity, yahooLiveArticleRecord } from "./yahoo-live-article.mjs";
import { assertAccessibleOriginalArticle, assertSessionClosingClaims } from "./source-session-integrity.mjs";
import { sourceEvidenceDeadline } from "./evidence-timing.mjs";

// Discovery URLs carry no accepted facts or causal conclusions. A new run
// must fetch and verify its own current article before admitting evidence.
export async function priorRecapDiscoveryLeads(workRoot, envelope, { beforeStartedAt = null } = {}) {
  if (envelope.market !== "US") return [];
  const leads = new Map();
  for (const entry of await readdir(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const runDir = resolve(workRoot, entry.name);
      const manifest = JSON.parse(await readFile(resolve(runDir, "manifest.json"), "utf8"));
      if (manifest.market !== envelope.market || manifest.marketAsOf !== envelope.marketAsOf || !["failed", "completed", "ready"].includes(manifest.status)) continue;
      if (beforeStartedAt && Date.parse(manifest.startedAt) >= Date.parse(beforeStartedAt)) continue;
      const book = JSON.parse(await readFile(resolve(runDir, "artifacts/recap-source-snapshots.json"), "utf8"));
      const bookHash = stableHash(book);
      if (book.version !== SOURCE_SNAPSHOT_VERSION || !Array.isArray(book.snapshots) || book.snapshots.length > 200 || manifest.sourceSnapshotsHash !== bookHash || !Object.entries(manifest.stages ?? {}).some(([key, stage]) => key.startsWith("evidence-verification-") && stage.status === "completed" && stage.sourceSnapshotsHash === bookHash)) continue;
      for (const snapshot of book.snapshots) {
        try {
          if (!yahooLiveArticleIdentity(snapshot.source)) continue;
          const opened = openedSourceFromSnapshot(snapshot);
          const record = yahooLiveArticleRecord(decodeSourceBody(opened.rawBody, opened.contentType), opened.finalUrl);
          if (!record || !record.origin.identified || opened.articleProvenance?.publication?.status !== "verified") continue;
          const time = Date.parse(record.currentVersionAt);
          if (time < Date.parse(envelope.session.windowEnd) || time > sourceEvidenceDeadline("market_wrap", envelope.session) || time > Date.parse(snapshot.fetchedAt)) continue;
          assertAccessibleOriginalArticle(opened);
          assertSessionClosingClaims(opened.text, envelope, record.currentVersionAt);
          const lead = { url: opened.finalUrl, title: record.title, publishedAt: record.currentVersionAt, initialPublishedAt: record.initialPublishedAt, reportingOrigin: record.origin.key, bodyHash: snapshot.bodyHash, fetchedAt: snapshot.fetchedAt, originalRun: entry.name, discoveryOnly: true };
          const previous = leads.get(record.canonical);
          if (!previous || Date.parse(lead.fetchedAt) > Date.parse(previous.fetchedAt)) leads.set(record.canonical, lead);
        } catch { /* A malformed or contradictory original supplies no lead. */ }
      }
    } catch { /* Incomplete historical artifacts supply no discovery input. */ }
  }
  return [...leads.values()].sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) || a.url.localeCompare(b.url)).slice(0, 8);
}
