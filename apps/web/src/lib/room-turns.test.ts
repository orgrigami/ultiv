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

const PARTICIPANTS = ["a", "b"];
const NAMES = [
  { profileId: "a", name: "Ada" },
  { profileId: "b", name: "Bea" },
];

describe("seatLines", () => {
  it("seats the opener left and the other bot right", () => {
    const seated = seatLines([line("a", at(9)), line("b", at(9, 1))], PARTICIPANTS, NAMES, NOW);
    expect(seated.map((entry) => entry.side)).toEqual(["left", "right"]);
  });

  it("seats by id when two bots share a name", () => {
    const lines = [line("a", at(9), { speaker: "Echo" }), line("b", at(9, 1), { speaker: "Echo" })];
    const seated = seatLines(lines, PARTICIPANTS, NAMES, NOW);
    expect(seated.map((entry) => entry.side)).toEqual(["left", "right"]);
    expect(seated[1]?.grouped).toBe(false);
  });

  it("falls back to the name for lines without an id", () => {
    const seated = seatLines(
      [line(undefined, at(9), { speaker: "Bea" })],
      PARTICIPANTS,
      NAMES,
      NOW,
    );
    expect(seated[0]?.side).toBe("right");
  });

  it("seats an external opener left and the bot answering right", () => {
    const seated = seatLines(
      [line("external:mail", at(9)), line("a", at(9, 1))],
      ["external:mail", "a"],
      [{ profileId: "a", name: "Ada" }],
      NOW,
    );
    expect(seated.map((entry) => entry.side)).toEqual(["left", "right"]);
  });

  it("seats a bot named owner like any other bot", () => {
    const seated = seatLines([line("b", at(9), { speaker: "owner" })], PARTICIPANTS, NAMES, NOW);
    expect(seated[0]?.side).toBe("right");
  });

  it("puts one divider per day, not per minute", () => {
    const lines = [line("a", at(9)), line("b", at(9, 7)), line("a", at(11, 30))];
    const seated = seatLines(lines, PARTICIPANTS, NAMES, NOW);
    expect(seated.map((entry) => entry.divider)).toEqual([formatDay(at(9), NOW), null, null]);
  });

  it("groups one speaker's consecutive lines within the gap", () => {
    const lines = [
      line("a", at(9)),
      line("a", at(9, 2)),
      line("a", at(9, 2) + GROUP_GAP_MS + 1),
      line("b", at(10)),
    ];
    const seated = seatLines(lines, PARTICIPANTS, NAMES, NOW);
    expect(seated.map((entry) => entry.grouped)).toEqual([false, true, false, false]);
  });

  it("breaks a group at a system line and at a new day", () => {
    const yesterday = new Date(2026, 10, 3, 23, 59).getTime();
    const lines = [
      line("a", yesterday),
      line("a", at(0, 1)),
      line(undefined, at(0, 2), { system: true }),
      line("a", at(0, 3)),
    ];
    const seated = seatLines(lines, PARTICIPANTS, NAMES, NOW);
    expect(seated.map((entry) => entry.grouped)).toEqual([false, false, false, false]);
    expect(seated[1]?.divider).toBe("Today");
  });
});
