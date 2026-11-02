/**
 * Plain-language text for a 5-field cron expression ("Every weekday at
 * 9:00 AM"). Covers the common shapes; anything else returns null so the
 * caller can show the raw expression instead of guessing.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ALIASES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const isNumber = (field: string): boolean => /^\d+$/.test(field);

/** "9:00 AM", "12:30 PM", "12:00 AM". */
export function clockText(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "a", "a and b", "a, b and c". */
function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const ordinal = (n: number): string =>
  n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** Weekday field → sorted day numbers (0 = Sunday), or null if unsupported. */
function parseDays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.toLocaleLowerCase("en").split(",")) {
    const range = part.split("-");
    const toDay = (value: string): number | null => {
      const alias = DAY_ALIASES.indexOf(value);
      if (alias >= 0) return alias;
      if (!isNumber(value) || Number(value) > 7) return null;
      return Number(value) % 7;
    };
    const start = toDay(range[0] ?? "");
    const end = range.length === 2 ? toDay(range[1] ?? "") : start;
    if (start === null || end === null || range.length > 2) return null;
    // "5-0"/"5-7" style wrap-around ranges stay unsupported unless 7 ends them.
    const last = range.length === 2 && range[1] === "7" ? 7 : end;
    if (last < start) return null;
    for (let day = start; day <= last; day += 1) days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}

function daysText(days: number[]): string {
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Every weekday";
  if (key === "0,6") return "Every weekend";
  if (days.length === 7) return "Every day";
  return `Every ${listText(days.map((day) => DAY_NAMES[day] ?? String(day)))}`;
}

/** Minute field + hour field → "at 9:00 AM" / "at 9:00 AM and 5:00 PM", or null. */
function timesText(minute: string, hour: string): string | null {
  if (!isNumber(minute) || !/^\d+(,\d+)*$/.test(hour)) return null;
  const hours = hour.split(",").map(Number);
  if (Number(minute) > 59 || hours.some((h) => h > 23)) return null;
  return `at ${listText(hours.map((h) => clockText(h, Number(minute))))}`;
}

/** Sub-daily shapes: every minute, every N minutes, hourly, every N hours. */
function frequentText(minute: string, hour: string): string | null {
  const step = (field: string): number | null => {
    const match = /^\*\/(\d+)$/.exec(field);
    return match === null ? null : Number(match[1]);
  };
  if (hour === "*") {
    if (minute === "*") return "Every minute";
    const everyMinutes = step(minute);
    if (everyMinutes !== null) {
      return everyMinutes === 1 ? "Every minute" : `Every ${everyMinutes} minutes`;
    }
    if (isNumber(minute)) {
      return minute === "0" ? "Every hour" : `Every hour at :${minute.padStart(2, "0")}`;
    }
    return null;
  }
  const everyHours = step(hour);
  if (everyHours !== null && isNumber(minute)) {
    const base = everyHours === 1 ? "Every hour" : `Every ${everyHours} hours`;
    return minute === "0" ? base : `${base} at :${minute.padStart(2, "0")}`;
  }
  return null;
}

export function cronToText(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const frequent = frequentText(minute, hour);
    if (frequent !== null) return frequent;
  }
  const at = timesText(minute, hour);
  if (at === null) return null;

  if (dayOfMonth === "*" && month === "*") {
    if (dayOfWeek === "*") return `Every day ${at}`;
    const days = parseDays(dayOfWeek);
    return days === null || days.length === 0 ? null : `${daysText(days)} ${at}`;
  }
  if (dayOfWeek !== "*" || !isNumber(dayOfMonth)) return null;
  const day = Number(dayOfMonth);
  if (day < 1 || day > 31) return null;
  if (month === "*") return `Every month on the ${ordinal(day)} ${at}`;
  if (!isNumber(month)) return null;
  const monthName = MONTH_NAMES[Number(month) - 1];
  return monthName === undefined ? null : `Every year on ${monthName} ${day} ${at}`;
}
