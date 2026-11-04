/**
 * Grouping for the room timeline (`components/room-timeline.tsx`): where day
 * dividers fall, and which lines continue the turn above them (no head of
 * their own). The timeline is house prose with no seating, so a speaker is
 * told apart by profile id (names can collide) and only falls back to the
 * name for lines from an older server. Pure, so the rules are tested
 * without a DOM.
 */
import type { RoomLine } from "./api.ts";
import { formatDay } from "./format.ts";

export type SeatedLine = {
  readonly line: RoomLine;
  /** The day label when this line opens a new day, else null. */
  readonly divider: string | null;
  /** Continues the previous line's turn: no character, name or clock of its own. */
  readonly grouped: boolean;
};

/** Consecutive lines from one speaker further apart than this start a new
 *  turn, so a grouped line never hides a long silence behind no clock. */
export const GROUP_GAP_MS = 5 * 60_000;

const keyOf = (line: RoomLine): string => line.speakerId ?? `name:${line.speaker}`;

export function seatLines(lines: readonly RoomLine[], now: Date = new Date()): SeatedLine[] {
  let lastDay = "";
  let previous: RoomLine | null = null;
  return lines.map((line) => {
    // Keyed on the DAY: formatDivider carries the clock too, which put a
    // "day" divider before every new minute.
    const day = formatDay(line.at, now);
    const divider = day === lastDay ? null : day;
    lastDay = day;
    const grouped =
      divider === null &&
      previous !== null &&
      !previous.system &&
      !line.system &&
      keyOf(previous) === keyOf(line) &&
      line.at - previous.at <= GROUP_GAP_MS;
    previous = line;
    return { line, divider, grouped };
  });
}
