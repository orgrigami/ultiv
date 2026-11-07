import { describe, expect, it } from "vite-plus/test";
import type { MemoryV2Fact } from "./api-types.ts";
import { evidenceOf } from "./memory-evidence.ts";

const fact = (patch: Partial<MemoryV2Fact>): MemoryV2Fact => ({
  id: "f1",
  scope: "profile",
  text: "Harry trains at Celebrity Fitness",
  status: "current",
  kind: "fact",
  tags: [],
  entities: [],
  importance: 3,
  trust: "self",
  createdAt: Date.UTC(2026, 9, 3),
  expiredAt: null,
  supersededBy: null,
  supersedes: [],
  ...patch,
});

describe("a conflict side's evidence", () => {
  it("says how the bot knows it, since when, and where it was learned", () => {
    const chats = { conv1: { sessionId: "s1", title: "Gym plans", kind: "chat" } };
    expect(
      evidenceOf(
        fact({ basis: "owner_said", source: { conversation: "conv1", origin: "owner" } }),
        chats,
      ),
    ).toEqual(["You said it", "since 2026-10-03", "Learned in Gym plans"]);
  });

  it("flags a guess and outside content, and the main chat by name", () => {
    const chats = { m: { sessionId: "s0", title: "main", kind: "main" } };
    expect(
      evidenceOf(
        fact({
          basis: "inferred",
          trust: "untrusted",
          validFrom: Date.UTC(2026, 10, 1),
          source: { conversation: "m", origin: "webhook" },
        }),
        chats,
      ),
    ).toEqual([
      "The bot's guess",
      "From outside content, unverified",
      "since 2026-11-01",
      "Learned in the main chat",
    ]);
    expect(evidenceOf(fact({ trust: "derived" }), undefined)).toEqual([
      "Taken from outside content",
      "since 2026-10-03",
    ]);
  });
});
