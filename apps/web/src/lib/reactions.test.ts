import { describe, expect, it } from "vite-plus/test";
import type { TranscriptEntry } from "@spriessen/contracts";
import { reactionsOf, withoutReactions } from "./reactions";

const react = (
  id: number,
  details: unknown,
  status: "done" | "error" | "running" = "done",
): TranscriptEntry => ({
  id,
  kind: "tool",
  at: 0,
  step: {
    callId: `c${id}`,
    name: "react",
    status,
    input: null,
    output: null,
    durationMs: null,
    details,
  },
});

const owner: TranscriptEntry = { id: 100, kind: "input", at: 0, text: "ship it" };

describe("reactions from the transcript", () => {
  it("maps each owner message to its latest reaction", () => {
    const map = reactionsOf([
      owner,
      react(200, { target: 100, reaction: "looking" }),
      react(300, { target: 100, reaction: "done" }),
    ]);
    expect(map.get(100)).toBe("done");
  });

  it("ignores refused calls and old-shape details", () => {
    const map = reactionsOf([
      owner,
      react(200, { target: 100, reaction: "ok" }, "error"),
      react(300, { entryId: 100, emoji: "ack" }),
    ]);
    expect(map.size).toBe(0);
  });

  it("drops successful react calls so a reaction-only reply draws no empty turn", () => {
    const refused = react(300, undefined, "error");
    const kept = withoutReactions([owner, react(200, { target: 100, reaction: "ok" }), refused]);
    expect(kept).toEqual([owner, refused]);
  });
});
