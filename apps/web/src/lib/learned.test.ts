import { describe, expect, it } from "vite-plus/test";
import type { BotFileVersion } from "./bot-files.ts";
import { learnedOf, undoActionOf, undoStateOf } from "./learned.ts";

const v = (n: number, reason = "Updated"): BotFileVersion => ({
  n,
  text: `v${n}`,
  at: n,
  by: "learning",
  reason,
});

describe("learned steps", () => {
  it("reads only a well-formed learned save", () => {
    expect(
      learnedOf({ profile: "bot-1", skill: "invoice-filing", version: 2, lesson: "x" }),
    ).toEqual({
      profile: "bot-1",
      skill: "invoice-filing",
      version: 2,
      lesson: "x",
    });
    expect(learnedOf({ profile: "bot-1", skill: "a", version: 0 })).toBeUndefined();
    expect(learnedOf({ skill: "a", version: 1 })).toBeUndefined();
    expect(learnedOf("learned")).toBeUndefined();
    expect(learnedOf(undefined)).toBeUndefined();
  });

  it("undoing a skill the save created removes it; later saves revert", () => {
    expect(undoActionOf([v(1)], 1)).toBe("remove");
    expect(undoActionOf([v(1), v(2), v(3), v(4)], 4)).toBe("revert");
    // Learned, deleted, learned again: v2 created the skill anew.
    expect(undoActionOf([v(1), { ...v(2), created: true }], 2)).toBe("remove");
    expect(undoActionOf([v(1), { ...v(2), created: true }, v(3)], 3)).toBe("revert");
  });

  it("offers undo only while the learned version is the newest", () => {
    expect(undoStateOf([v(1), v(2)], 2)).toBe("undo");
    expect(undoStateOf([v(1), v(2), v(3, "Undid version 2")], 2)).toBe("undone");
    expect(undoStateOf([v(1), v(2), v(3, "Updated")], 2)).toBe("changed");
    expect(undoStateOf([v(1), v(2), v(3, "Undid version 2"), v(4)], 2)).toBe("changed");
    expect(undoStateOf([], 1)).toBe("changed");
  });
});
