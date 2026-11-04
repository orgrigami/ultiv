/**
 * Seating and grouping for the room timeline (`components/room-timeline.tsx`):
 * which side each line sits on, where day dividers fall, and which lines
 * continue the turn above them. Pure, so the rules are tested without a DOM.
 */
import type { RoomLine } from "./api.ts";
import { formatDay } from "./format.ts";

export type Side = "left" | "right";

export type SeatedLine = {
  readonly line: RoomLine;
  /** The day label when this line opens a new day, else null. */
  readonly divider: string | null;
  readonly side: Side;
  /** Continues the previous line's turn: no avatar, name or time of its own. */
  readonly grouped: boolean;
};

/** Consecutive lines from one speaker further apart than this start a new
 *  turn, so a grouped bubble never hides a long silence behind no time. */
export const GROUP_GAP_MS = 5 * 60_000;

const keyOf = (line: RoomLine): string => line.speakerId ?? `name:${line.speaker}`;

/**
 * The room's first participant sits left; every other bot sits right. Rooms
 * are bot-to-bot only, so there is no owner seat. Seating goes by profile id (names can collide, and a deleted bot's
 * fallback name differs between endpoints); a line without one, from an
 * older server, falls back to its name. `participants` is the room's raw
 * list, external senders included, so an external opener sits left too.
 */
export function seatLines(
  lines: readonly RoomLine[],
  participants: readonly string[],
  names: readonly { readonly profileId: string; readonly name: string }[],
  now: Date = new Date(),
): SeatedLine[] {
  const opener = participants[0];
  const sideOf = (line: RoomLine): Side => {
    const id = line.speakerId ?? names.find((entry) => entry.name === line.speaker)?.profileId;
    return id === undefined || id === opener || !participants.includes(id) ? "left" : "right";
  };
  let lastDay = "";
  let previous: RoomLine | null = null;
  return lines.map((line) => {
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
    return {
      line,
      divider,
      side: sideOf(line),
      grouped,
    };
  });
}
