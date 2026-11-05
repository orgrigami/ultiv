import { describe, expect, it } from "vite-plus/test";
import type { ReactionRow } from "@spriessen/contracts";
import { reactionsByEntry } from "./use-reactions.ts";

const row = (entryId: number, emoji: ReactionRow["emoji"]): ReactionRow => ({
  entryId,
  emoji,
  reactorProfileId: "bot-1",
  createdAt: 1_000 + entryId,
});

describe("reactionsByEntry", () => {
  it("keys rows by the transcript entry id the chip attaches to", () => {
    const merged = reactionsByEntry([row(1200, "ack"), row(2400, "done")]);
    expect(merged.size).toBe(2);
    expect(merged.get(1200)?.emoji).toBe("ack");
    expect(merged.get(2400)?.emoji).toBe("done");
    expect(merged.get(999)).toBeUndefined();
  });

  it("merges duplicates by entry id, last write wins", () => {
    const merged = reactionsByEntry([row(1200, "working"), row(1200, "done"), row(2400, "seen")]);
    expect(merged.size).toBe(2);
    expect(merged.get(1200)?.emoji).toBe("done");
    expect(merged.get(1200)?.createdAt).toBe(2200);
  });
});
