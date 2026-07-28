export const DAILY_UPDATE_KINDS = ["morning", "close", "evening"];

const DAILY_CUTOFF_UTC = {
  morning: "01:00",
  close: "07:00",
  evening: "13:00",
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function dailyCutoffAt(reportDate, updateKind) {
  if (!datePattern.test(reportDate)) {
    throw new Error("reportDate must be YYYY-MM-DD");
  }
  if (!DAILY_UPDATE_KINDS.includes(updateKind)) {
    throw new Error("updateKind must be morning, close, or evening");
  }
  return `${reportDate}T${DAILY_CUTOFF_UTC[updateKind]}:00.000Z`;
}

export function marketAsOfFromInput(input) {
  const result = {};
  for (const market of ["CN", "US"]) {
    const dates = [
      ...new Set(
        (input.sectorHeat ?? [])
          .filter((sector) => sector.market === market)
          .map((sector) => sector.asOf)
          .filter((date) => datePattern.test(date)),
      ),
    ];
    if (dates.length === 1) result[market] = dates[0];
  }
  return result;
}

export function marketAsOfFromReport(report) {
  const result = {};
  for (const market of ["CN", "US"]) {
    const storedDate = report?.marketAsOf?.[market];
    if (datePattern.test(storedDate ?? "")) {
      result[market] = storedDate;
      continue;
    }
    const dates = [
      ...new Set(
        (report?.sectorHeat ?? [])
          .filter((sector) => sector.market === market)
          .map((sector) => sector.asOf)
          .filter((date) => datePattern.test(date)),
      ),
    ];
    if (dates.length === 1) result[market] = dates[0];
  }
  return result;
}

function isWeekday(reportDate) {
  const day = new Date(`${reportDate}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

export function assessDailyFreshness(input, previousReport) {
  const marketAsOf = marketAsOfFromInput(input);
  if (
    input.updateKind === "close" &&
    isWeekday(input.reportDate) &&
    marketAsOf.CN !== input.reportDate
  ) {
    return {
      publish: false,
      retryable: true,
      reason: "cn_close_not_available",
      marketAsOf,
      advancedMarkets: [],
      newStoryCount: 0,
    };
  }

  if (!previousReport) {
    return {
      publish: true,
      retryable: false,
      reason: "no_previous_report",
      marketAsOf,
      advancedMarkets: [],
      newStoryCount: input.news?.length ?? 0,
    };
  }

  const previousMarketAsOf = marketAsOfFromReport(previousReport);
  const advancedMarkets = ["CN", "US"].filter(
    (market) =>
      marketAsOf[market] &&
      (!previousMarketAsOf[market] ||
        marketAsOf[market] > previousMarketAsOf[market]),
  );
  const previousSources = new Set(
    (previousReport.stories ?? [])
      .map((story) => story.source)
      .filter((source) => typeof source === "string"),
  );
  const newStoryCount = (input.news ?? []).filter(
    (story) => !previousSources.has(story.url),
  ).length;
  const checkpointChanged =
    previousReport.reportDate !== input.reportDate ||
    previousReport.updateKind !== input.updateKind;
  const materiallyAdvanced =
    advancedMarkets.length > 0 || newStoryCount > 0;
  const publish = checkpointChanged || materiallyAdvanced;

  return {
    publish,
    retryable: false,
    reason: materiallyAdvanced
      ? "material_advance"
      : checkpointChanged
        ? "scheduled_checkpoint"
        : "no_material_advance",
    marketAsOf,
    previousMarketAsOf,
    advancedMarkets,
    newStoryCount,
    checkpointChanged,
  };
}
