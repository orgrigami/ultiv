import { describe, expect, it } from "vite-plus/test";
import {
  matchScore,
  moveActive,
  rankItems,
  shortcutOf,
  type KeyLike,
  type QuickItem,
} from "./quick-switch.ts";

const items: QuickItem[] = [
  { id: "c1", kind: "chat", title: "Plan the weekend trip", detail: "Nova" },
  { id: "c2", kind: "chat", title: "Fix the backup cron", detail: "Atlas" },
  { id: "b1", kind: "bot", title: "Nova", detail: "Research and writing" },
  { id: "b2", kind: "bot", title: "Atlas", detail: "Keeps the home server tidy" },
  { id: "s1", kind: "screen", title: "Past chats", keywords: ["history"] },
  { id: "s2", kind: "screen", title: "Needs you", keywords: ["approvals"] },
  { id: "a1", kind: "action", title: "New chat", shortcut: "N" },
];

describe("matchScore", () => {
  it("ranks exact over prefix over word start over anywhere over in-order letters", () => {
    const scores = [
      matchScore("atlas", "Atlas"),
      matchScore("at", "Atlas"),
      matchScore("ch", "Past chats"),
      matchScore("ast", "Past chats"),
      matchScore("pc", "Past chats"),
    ];
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores.every((score) => score > 0)).toBe(true);
  });
  it("is case-insensitive, ignores outer spaces and misses cleanly", () => {
    expect(matchScore("  NOVA ", "nova")).toBe(100);
    expect(matchScore("zz", "Nova")).toBe(0);
    expect(matchScore("", "anything")).toBe(1);
  });
});

describe("rankItems", () => {
  it("groups by kind with nothing typed and caps the chats", () => {
    const rows = rankItems(items, "", { chatsWhenEmpty: 1 });
    expect(rows.map((row) => row.id)).toEqual(["a1", "s1", "s2", "b1", "b2", "c1"]);
  });
  it("puts the best title first", () => {
    expect(rankItems(items, "atl")[0]?.id).toBe("b2");
    expect(rankItems(items, "backup")[0]?.id).toBe("c2");
  });
  it("finds by keywords and by detail, without the detail outranking a title", () => {
    expect(rankItems(items, "history")[0]?.id).toBe("s1");
    const nova = rankItems(items, "nova").map((row) => row.id);
    expect(nova[0]).toBe("b1");
    expect(nova).toContain("c1");
  });
  it("drops what does not match and respects the limit", () => {
    expect(rankItems(items, "qqq")).toEqual([]);
    expect(rankItems(items, "a", { limit: 2 })).toHaveLength(2);
  });
});

describe("moveActive", () => {
  it("wraps both ways and survives an empty list", () => {
    expect(moveActive(0, 3, -1)).toBe(2);
    expect(moveActive(2, 3, 1)).toBe(0);
    expect(moveActive(0, 0, 1)).toBe(0);
  });
});

describe("shortcutOf", () => {
  const key = (over: Partial<KeyLike>): KeyLike => ({
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    typing: false,
    ...over,
  });
  it("opens the switcher with Cmd-K or Ctrl-K, even while typing", () => {
    expect(shortcutOf(key({ key: "k", metaKey: true }))).toBe("switcher");
    expect(shortcutOf(key({ key: "K", ctrlKey: true, typing: true }))).toBe("switcher");
  });
  it("takes bare N and ? only outside fields", () => {
    expect(shortcutOf(key({ key: "n" }))).toBe("new-chat");
    expect(shortcutOf(key({ key: "?" }))).toBe("help");
    expect(shortcutOf(key({ key: "n", typing: true }))).toBeNull();
    expect(shortcutOf(key({ key: "n", metaKey: true }))).toBeNull();
    expect(shortcutOf(key({ key: "k" }))).toBeNull();
  });
});
