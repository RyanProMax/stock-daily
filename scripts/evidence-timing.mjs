export function isCalendarDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function officialReleaseDateInWindow(date, envelope) {
  if (!isCalendarDate(date)) return false;
  const zone = envelope.market === "CN" ? "Asia/Shanghai" : "America/New_York";
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = timestamp => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  // A date-only fact has unknown intraday ordering. This admits the factual
  // release's calendar date, never a fabricated point-in-time availability.
  const firstDate = day(Date.parse(envelope.session.windowStart) - 72 * 3_600_000);
  const lastDate = day(Date.parse(envelope.session.windowEnd));
  return date >= firstDate && date <= lastDate;
}
