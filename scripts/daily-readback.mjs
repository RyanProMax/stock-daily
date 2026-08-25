const DEFAULT_BASE_URL = "https://stock-daily-8k4.pages.dev";
const DEFAULT_RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000, 15_000, 30_000, 30_000];

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function fetchProductionSnapshot(input, baseUrl, fetcher, attempt) {
  const cacheBust = `${Date.now()}-${attempt}`;
  const [healthResponse, reportResponse] = await Promise.all([
    fetcher(`${baseUrl}/api/health?_=${cacheBust}`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(20_000),
    }),
    fetcher(`${baseUrl}/api/reports/${input.reportDate}?_=${cacheBust}`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(20_000),
    }),
  ]);
  if (!healthResponse.ok || !reportResponse.ok) {
    throw new Error(
      `线上回读失败：health=${healthResponse.status}, report=${reportResponse.status}`,
    );
  }
  const [healthPayload, reportPayload] = await Promise.all([
    healthResponse.json(),
    reportResponse.json(),
  ]);
  return { health: healthPayload.data, report: reportPayload.data };
}

export function dailySnapshotIsCurrent(input, { health, report } = {}) {
  const collectedAt = Date.parse(input?.collectedAt ?? "");
  const generatedAt = Date.parse(report?.generatedAt ?? "");
  const finishedAt = Date.parse(health?.latestIngestion?.finishedAt ?? "");
  return (
    Number.isFinite(collectedAt) &&
    Number.isFinite(generatedAt) &&
    Number.isFinite(finishedAt) &&
    report?.reportDate === input.reportDate &&
    report?.updateKind === input.updateKind &&
    health?.latestIngestion?.reportDate === input.reportDate &&
    health?.latestIngestion?.status === "completed" &&
    generatedAt >= collectedAt &&
    finishedAt >= collectedAt
  );
}

export async function fetchFreshDailySnapshot(
  input,
  {
    baseUrl = DEFAULT_BASE_URL,
    fetcher = fetch,
    wait = delay,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    snapshotLoader,
  } = {},
) {
  let lastSnapshot;
  let lastError;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const waitMs = retryDelaysMs[attempt];
    if (waitMs > 0) await wait(waitMs);
    try {
      lastSnapshot = snapshotLoader
        ? await snapshotLoader(input, attempt)
        : await fetchProductionSnapshot(input, baseUrl, fetcher, attempt);
      if (dailySnapshotIsCurrent(input, lastSnapshot)) return lastSnapshot;
    } catch (error) {
      lastError = error;
    }
  }
  const observed = lastSnapshot
    ? `report=${lastSnapshot.report?.reportDate ?? "none"}/${lastSnapshot.report?.updateKind ?? "none"}/${lastSnapshot.report?.generatedAt ?? "none"}`
    : lastError instanceof Error
      ? lastError.message
      : "no snapshot";
  throw new Error(`生产日报在重试窗口内未更新：${observed}`);
}
