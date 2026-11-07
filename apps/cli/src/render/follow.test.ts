/**
 * Following a turn live: tools print as they finish (a running one is a
 * live line rewritten when it ends), the reply streams in order and never
 * repeats, nothing runs ahead of a reply still being written, and thinking
 * stays out. Piped, only the reply's words are kept.
 */
import type { TranscriptEntry } from "@spriessen/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createFollower, replyText } from "./follow.ts";
import { paintFor } from "./out.ts";

const plain = paintFor({ isTTY: false });

const tool = (id: number, status: "running" | "done"): TranscriptEntry => ({
  id,
  kind: "tool",
  at: id,
  step: {
    callId: `c${id}`,
    name: "web_search",
    status,
    input: { query: "release notes" },
    output: status === "done" ? "[]" : null,
    durationMs: status === "done" ? 5 : null,
  },
});

const reply = (id: number, text: string, streaming: boolean): TranscriptEntry => ({
  id,
  kind: "output",
  at: id,
  text,
  streaming,
});

describe("the follower", () => {
  it("streams a turn once, in order", () => {
    const follow = createFollower("Wren", plain);
    const mine: TranscriptEntry = { id: 1, kind: "input", at: 1, text: "find them" };
    const thinking: TranscriptEntry = { id: 2, kind: "thinking", at: 2, text: "SECRET" };
    let out = follow.feed([mine, thinking, tool(3, "running")], 1);
    expect(out).toMatch(/… Searching the web/);
    expect(out).not.toContain("SECRET");
    out = follow.feed([mine, thinking, tool(3, "done"), reply(4, "Here", true)], 1);
    expect(out).toContain("\r\u001b[2K");
    expect(out).toMatch(/✓ Searched the web/);
    expect(out).toContain("\nWren\nHere");
    out = follow.feed([mine, thinking, tool(3, "done"), reply(4, "Here they are.", false)], 1);
    expect(out).toBe(" they are.\n");
    expect(
      follow.feed([mine, thinking, tool(3, "done"), reply(4, "Here they are.", false)], 1),
    ).toBe("");
  });

  it("never runs ahead of a reply still being written", () => {
    const follow = createFollower("Wren", plain);
    const out = follow.feed([reply(2, "Half", true), tool(3, "done")], 1);
    expect(out).not.toContain("Searched");
  });

  it("keeps only the reply's words for a pipe", () => {
    expect(replyText([tool(3, "done"), reply(4, "One.\n", false), reply(5, "Two.", false)])).toBe(
      "One.\n\nTwo.",
    );
  });
});
