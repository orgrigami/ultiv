/**
 * Dates as tools receive them. Models write calendar days far more reliably
 * than epoch milliseconds, so every memory date parameter takes
 * `YYYY-MM-DD` (that day's start in the bot's zone, WIB by default), a full
 * ISO time, `today`/`now`, or — for older callers — epoch milliseconds.
 */
import { InvalidInput } from "@spriessen/core";

/** WIB: UTC+7, no daylight saving. */
export const WIB_OFFSET_HOURS = 7;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch ms of a date parameter; undefined when absent. Refuses what it cannot read. */
export const parseWhen = (
  value: string | number | null | undefined,
  now = Date.now(),
  offsetHours = WIB_OFFSET_HOURS,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidInput({ reason: "that date is not a number" });
    return value;
  }
  const text = value.trim().toLowerCase();
  if (text === "") return undefined;
  if (text === "now") return now;
  if (text === "today" || text === "hari ini") return startOfDay(now, offsetHours);
  const day = DAY.exec(text);
  if (day !== null) {
    const utc = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (Number.isNaN(utc) || new Date(utc).getUTCDate() !== Number(day[3])) {
      throw new InvalidInput({ reason: `${value} is not a calendar day; write YYYY-MM-DD` });
    }
    return utc - offsetHours * 3_600_000;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidInput({ reason: `${value} is not a date; write YYYY-MM-DD` });
  }
  return parsed;
};

/** The start of the day `at` falls in, in the given zone. */
export const startOfDay = (at: number, offsetHours = WIB_OFFSET_HOURS): number => {
  const shifted = at + offsetHours * 3_600_000;
  return shifted - (shifted % 86_400_000) - offsetHours * 3_600_000;
};
