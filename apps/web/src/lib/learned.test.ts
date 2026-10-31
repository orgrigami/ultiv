import { describe, expect, it } from "vite-plus/test";
import type { BotFileVersion } from "./bot-files.ts";
import { learnedOf, undoStateOf } from "./learned.ts";

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

  it("offers undo only while the learned version is the newest", () => {
    expect(undoStateOf([v(1), v(2)], 2)).toBe("undo");
    expect(undoStateOf([v(1), v(2), v(3, "Undid version 2")], 2)).toBe("undone");
    expect(undoStateOf([v(1), v(2), v(3, "Updated")], 2)).toBe("changed");
    expect(undoStateOf([v(1), v(2), v(3, "Undid version 2"), v(4)], 2)).toBe("changed");
    expect(undoStateOf([], 1)).toBe("changed");
  });
});
