import { describe, expect, it } from "vite-plus/test";
import type { RoomLine } from "./api.ts";
import { formatDay } from "./format.ts";
import { GROUP_GAP_MS, seatLines } from "./room-turns.ts";

const NOW = new Date(2026, 10, 4, 15, 0);
const at = (hours: number, minutes = 0): number => new Date(2026, 10, 4, hours, minutes).getTime();

const line = (speakerId: string | undefined, when: number, extra: Partial<RoomLine> = {}) =>
  ({
    at: when,
    speaker: extra.speaker ?? speakerId ?? "?",
    ...(speakerId === undefined ? {} : { speakerId }),
    text: "hi",
    system: false,
    ...extra,
  }) as RoomLine;

describe("seatLines", () => {
  it("puts one divider per day, not per minute", () => {
    const lines = [line("a", at(9)), line("b", at(9, 7)), line("a", at(11, 30))];
    const seated = seatLines(lines, NOW);
    expect(seated.map((entry) => entry.divider)).toEqual([formatDay(at(9), NOW), null, null]);
  });

  it("groups one speaker's consecutive lines within the gap", () => {
    const lines = [
      line("a", at(9)),
      line("a", at(9, 2)),
      line("a", at(9, 2) + GROUP_GAP_MS + 1),
      line("b", at(10)),
    ];
    const seated = seatLines(lines, NOW);
    expect(seated.map((entry) => entry.grouped)).toEqual([false, true, false, false]);
  });

  it("tells speakers apart by id when two bots share a name", () => {
    const lines = [line("a", at(9), { speaker: "Echo" }), line("b", at(9, 1), { speaker: "Echo" })];
    expect(seatLines(lines, NOW)[1]?.grouped).toBe(false);
  });

  it("falls back to the name for lines without an id", () => {
    const lines = [
      line(undefined, at(9), { speaker: "Bea" }),
      line(undefined, at(9, 1), { speaker: "Bea" }),
    ];
    expect(seatLines(lines, NOW)[1]?.grouped).toBe(true);
  });

  it("breaks a group at a system line and at a new day", () => {
    const yesterday = new Date(2026, 10, 3, 23, 59).getTime();
    const lines = [
      line("a", yesterday),
      line("a", at(0, 1)),
      line(undefined, at(0, 2), { system: true }),
      line("a", at(0, 3)),
    ];
    const seated = seatLines(lines, NOW);
    expect(seated.map((entry) => entry.grouped)).toEqual([false, false, false, false]);
    expect(seated[1]?.divider).toBe("Today");
  });
});
