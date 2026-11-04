/**
 * Human times in one place: every date the UI shows goes through here.
 */
const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const clock = (date: Date): string =>
  date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Oct 25", with the year only when it isn't this year's. */
const shortDate = (date: Date, now: Date): string =>
  date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });

/** A day on its own: "Today", "Yesterday", "Tomorrow", else "Oct 25". */
export function formatDay(at: number, now: Date = new Date()): string {
  const date = new Date(at);
  const dayOffset = (days: number): Date => {
    const shifted = new Date(now);
    shifted.setDate(now.getDate() + days);
    return shifted;
  };
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, dayOffset(-1))) return "Yesterday";
  if (sameDay(date, dayOffset(1))) return "Tomorrow";
  return shortDate(date, now);
}

/** A day word (or date) plus the clock time: "Today 5:46 PM", "Tomorrow 9:00 AM". */
export const formatDivider = (at: number, now: Date = new Date()): string =>
  `${formatDay(at, now)} ${clock(new Date(at))}`;

const MINUTE = 60_000;

/** A clock time on its own: "5:46 PM". */
export const formatClock = (at: number): string => clock(new Date(at));

/**
 * A list timestamp: "just now" / "12 min ago" within the hour, the clock time
 * earlier today, "Yesterday 5:46 PM", then "Oct 25" (year only when different).
 */
export function formatWhen(at: number, now: Date = new Date()): string {
  const ago = now.getTime() - at;
  if (ago >= 0 && ago < MINUTE) return "just now";
  if (ago >= 0 && ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)} min ago`;
  const date = new Date(at);
  if (sameDay(date, now)) return clock(date);
  const divider = formatDivider(at, now);
  if (divider.startsWith("Yesterday")) return divider;
  return shortDate(date, now);
}

/** Full date and time, for tooltips. */
export const formatFull = (at: number): string => new Date(at).toLocaleString();
