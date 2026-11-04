/**
 * Time-aware search: a query that says WHEN ("yesterday", "minggu lalu",
 * "in March", "3 days ago") is narrowed to that window, and the phrase is
 * taken out of the words to match — LongMemEval's time-aware query
 * expansion, done deterministically in English and Indonesian. Days are
 * the owner's (WIB by default).
 */
import { startOfDay, WIB_OFFSET_HOURS } from "../memory/dates.ts";

export interface TimeWindow {
  readonly since: number;
  readonly until: number;
}

const DAY = 86_400_000;

const MONTHS: Readonly<Record<string, number>> = {
  january: 0,
  jan: 0,
  januari: 0,
  february: 1,
  feb: 1,
  februari: 1,
  pebruari: 1,
  march: 2,
  mar: 2,
  maret: 2,
  april: 3,
  apr: 3,
  may: 4,
  mei: 4,
  june: 5,
  jun: 5,
  juni: 5,
  july: 6,
  jul: 6,
  juli: 6,
  august: 7,
  aug: 7,
  agustus: 7,
  agu: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  oktober: 9,
  okt: 9,
  november: 10,
  nov: 10,
  nopember: 10,
  december: 11,
  dec: 11,
  desember: 11,
  des: 11,
};

const MONTH_WORDS = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

type Rule = {
  readonly pattern: RegExp;
  readonly window: (match: RegExpExecArray, now: number, offset: number) => TimeWindow | null;
};

const dayWindow = (start: number, days = 1): TimeWindow => ({
  since: start,
  until: start + days * DAY - 1,
});

/** Monday 00:00 of the week `at` falls in. */
const weekStart = (at: number, offset: number): number => {
  const day = startOfDay(at, offset);
  const weekday = (new Date(day + offset * 3_600_000).getUTCDay() + 6) % 7;
  return day - weekday * DAY;
};

const monthWindow = (year: number, month: number, offset: number): TimeWindow => {
  const since = Date.UTC(year, month, 1) - offset * 3_600_000;
  const until = Date.UTC(year, month + 1, 1) - offset * 3_600_000 - 1;
  return { since, until };
};

const localDate = (at: number, offset: number): Date => new Date(at + offset * 3_600_000);

const RULES: readonly Rule[] = [
  {
    pattern: /\b(today|hari ini|tadi)\b/,
    window: (_, now, offset) => dayWindow(startOfDay(now, offset)),
  },
  {
    pattern: /\b(yesterday|kemarin|kemaren)\b/,
    window: (_, now, offset) => dayWindow(startOfDay(now, offset) - DAY),
  },
  {
    pattern: /\b(\d{1,2})\s+(days?|hari)\s+(ago|lalu|yang lalu)\b/,
    window: (match, now, offset) => dayWindow(startOfDay(now, offset) - Number(match[1]) * DAY),
  },
  {
    pattern: /\b(this week|minggu ini|pekan ini)\b/,
    window: (_, now, offset) => ({ since: weekStart(now, offset), until: now }),
  },
  {
    pattern: /\b(last week|minggu lalu|pekan lalu|minggu kemarin)\b/,
    window: (_, now, offset) => {
      const start = weekStart(now, offset) - 7 * DAY;
      return dayWindow(start, 7);
    },
  },
  {
    pattern: /\b(this month|bulan ini)\b/,
    window: (_, now, offset) => {
      const local = localDate(now, offset);
      return {
        since: monthWindow(local.getUTCFullYear(), local.getUTCMonth(), offset).since,
        until: now,
      };
    },
  },
  {
    pattern: /\b(last month|bulan lalu|bulan kemarin)\b/,
    window: (_, now, offset) => {
      const local = localDate(now, offset);
      return monthWindow(local.getUTCFullYear(), local.getUTCMonth() - 1, offset);
    },
  },
  {
    // "in March", "bulan maret", "pada mei", "maret 2026", "March 2025" — a bare
    // month word is not enough ("may I ask", "march on"): a preposition or
    // a year must go with it.
    pattern: new RegExp(
      `\\b(?:(?:in|during|di|bulan|pada|sejak) (${MONTH_WORDS})(?: (\\d{4}))?|(${MONTH_WORDS}) (\\d{4}))\\b`,
    ),
    window: (match, now, offset) => {
      const word = match[1] ?? match[3] ?? "";
      const yearText = match[2] ?? match[4];
      const month = MONTHS[word];
      if (month === undefined) return null;
      const local = localDate(now, offset);
      const thisYear = local.getUTCFullYear();
      // A month later than this one, with no year, means last year's.
      const year =
        yearText !== undefined
          ? Number(yearText)
          : month > local.getUTCMonth()
            ? thisYear - 1
            : thisYear;
      return monthWindow(year, month, offset);
    },
  },
];

/**
 * The time window a query names, and the query without that phrase. Only
 * the first phrase counts; a query with none comes back unchanged.
 */
export const timeWindowOf = (
  query: string,
  now = Date.now(),
  offset = WIB_OFFSET_HOURS,
): { readonly window: TimeWindow | null; readonly rest: string } => {
  const lower = query.toLowerCase();
  for (const rule of RULES) {
    const match = rule.pattern.exec(lower);
    if (match === null) continue;
    const window = rule.window(match, now, offset);
    if (window === null) continue;
    const rest = `${query.slice(0, match.index)} ${query.slice(match.index + match[0].length)}`
      .replace(/\s+/g, " ")
      .trim();
    return { window, rest };
  }
  return { window: null, rest: query };
};
