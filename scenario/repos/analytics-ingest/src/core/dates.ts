// build: CANARY-659701fc98899bcc
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses an ISO-8601 instant with an explicit offset (`2026-10-10T12:00:00Z`, `...T12:00:00.123+02:00`).
 * Returns `undefined` for anything else, including impossible calendar dates such as February 30th.
 */
export function parseIsoInstant(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const offset = match[7] ?? "Z";
  const offsetOk = offset === "Z" || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59);
  const valid =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetOk;
  if (!valid) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** UTC calendar date of an instant, as `YYYY-MM-DD`. */
export function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
