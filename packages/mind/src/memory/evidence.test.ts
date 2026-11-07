import { describe, expect, it } from "vite-plus/test";
import { evidenceLine, originWords, sourceCue } from "./evidence.ts";

const at = Date.UTC(2026, 9, 3, 3);

describe("where a fact came from, in words", () => {
  it("names the origin, the owner's panel, and an unknown one", () => {
    expect(originWords({ origin: "owner", via: "tool" })).toBe("the owner");
    expect(originWords({ origin: "webhook", via: "tool" })).toBe("a webhook");
    expect(originWords({ origin: "owner", via: "rest" })).toBe("the owner, in the Memory panel");
    expect(originWords({ origin: "mystery", via: "tool" })).toBe("an unknown source");
  });

  it("the recalled-line cue adds the learned day only when it differs", () => {
    const source = { origin: "bot", via: "tool" };
    expect(sourceCue(source, "2026-10-03", "2026-10-03")).toBe("from another bot");
    expect(sourceCue(source, "2026-10-03", "2026-09-01")).toBe(
      "from another bot, learned 2026-10-03",
    );
  });

  it("memory_history's line carries the chat and the note, or says the note is gone", () => {
    const source = { origin: "owner", via: "tool" };
    expect(evidenceLine({ source, learnedAt: at, chat: "main", note: "my gym is in Kemang" })).toBe(
      'learned 2026-10-03 from the owner in the main chat: "my gym is in Kemang"',
    );
    expect(evidenceLine({ source, learnedAt: at, chat: null, note: null })).toBe(
      "learned 2026-10-03 from the owner (the note it was saved from is gone)",
    );
    const long = evidenceLine({ source, learnedAt: at, chat: "session", note: "x".repeat(400) });
    expect(long).toContain("in a chat");
    expect(long.endsWith('…"')).toBe(true);
  });
});
