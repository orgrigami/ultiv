/**
 * Conversation search through the sidecar, on a real mind: ranked
 * multi-word, bilingual and typo-tolerant matching over every chat of ONE
 * bot (never a sibling's), incremental indexing (a new message is found by
 * the next search), deleted chats leaving the index, role and day filters,
 * and the time phrases a query can carry.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { timeWindowOf } from "./when.ts";
import { messageOf } from "./messages.ts";

const OWNER = "harry";

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles, history } = handle.mind;
  const say = async (profileId: string, title: string | null, text: string) => {
    const session =
      title === null
        ? await profiles.ensureMain(OWNER, profileId)
        : await profiles.createSession(OWNER, profileId, title);
    const key = await profiles.keyForSession(OWNER, session.id);
    const conversation = await Effect.runPromise(converse.ensure(key));
    await Effect.runPromise(converse.interrupt(conversation));
    await Effect.runPromise(converse.submit(conversation, text));
    return session;
  };
  const bot = await profiles.create(OWNER, { name: "Edison", onboard: false });
  const sibling = await profiles.create(OWNER, { name: "Sari", onboard: false });
  return { handle, profiles, history, say, bot, sibling };
};

describe("conversation search", () => {
  it("ranks words in any order, across languages, with a slip", async () => {
    const { handle, history, say, bot } = await setup();
    await say(bot.id, null, "we decided the launch date is March 3");
    await say(bot.id, "Pets", "the vet says the cat needs a checkup in two weeks");
    const reordered = await history.search(OWNER, bot.id, "date of the launch", 5);
    expect(reordered[0]?.snippet).toContain("launch date");
    const bilingual = await history.search(OWNER, bot.id, "kucing", 5);
    expect(bilingual[0]?.snippet).toContain("cat");
    expect(bilingual[0]?.sessionTitle).toBe("Pets");
    const slip = await history.search(OWNER, bot.id, "chekup", 5);
    expect(slip[0]?.snippet).toContain("checkup");
    expect(slip[0]?.at).toBeGreaterThan(0);
    await handle.close();
  });

  it("never returns another bot's words", async () => {
    const { handle, history, say, bot, sibling } = await setup();
    await say(sibling.id, null, "sari private: token 9f8e7d");
    expect(await history.search(OWNER, bot.id, "9f8e7d token", 5)).toEqual([]);
    expect(await history.search(OWNER, sibling.id, "9f8e7d token", 5)).toHaveLength(1);
    expect(await history.search("someone-else", sibling.id, "token", 5)).toEqual([]);
    await handle.close();
  });

  it("indexes new messages on the next search and forgets deleted chats", async () => {
    const { handle, profiles, history, say, bot } = await setup();
    await say(bot.id, null, "first note about the garden");
    expect(await history.search(OWNER, bot.id, "garden", 5)).toHaveLength(1);
    const later = await say(bot.id, "Trip", "pack the passport for the garden tour");
    expect(await history.search(OWNER, bot.id, "garden", 5)).toHaveLength(2);
    expect(await history.search(OWNER, bot.id, "passport", 5)).toHaveLength(1);
    await profiles.removeSession(OWNER, later.id);
    expect(await history.search(OWNER, bot.id, "passport", 5)).toEqual([]);
    await handle.close();
  });

  it("warms up: indexing a bot's chats ahead of any search, only once", async () => {
    const { handle, history, say, bot } = await setup();
    await say(bot.id, null, "the warm-up should find this");
    expect(await history.index(OWNER, bot.id)).toBeGreaterThan(0);
    expect(await history.index(OWNER, bot.id)).toBe(0);
    expect(await history.search(OWNER, bot.id, "warm-up", 5)).toHaveLength(1);
    await handle.close();
  });

  it("filters by who said it and by day", async () => {
    const { handle, history, say, bot } = await setup();
    await say(bot.id, null, "remember the dentist on Friday");
    expect(await history.search(OWNER, bot.id, "dentist", 5, { role: "user" })).toHaveLength(1);
    expect(await history.search(OWNER, bot.id, "dentist", 5, { role: "assistant" })).toEqual([]);
    const past = { until: Date.now() - 86_400_000 };
    expect(await history.search(OWNER, bot.id, "dentist", 5, past)).toEqual([]);
    expect(await history.search(OWNER, bot.id, "dentist today", 5)).toHaveLength(1);
    expect(await history.search(OWNER, bot.id, "dentist yesterday", 5)).toEqual([]);
    await handle.close();
  });

  it("indexes what was said, not system sections or thinking", () => {
    const entry = (kind: string, content: unknown) =>
      ({ id: 1, conversationId: 1, kind, model: [{ role: "x", content, timestamp: 5 }] }) as never;
    expect(messageOf(entry("pi.system", "core memory: …"))).toBeNull();
    expect(
      messageOf(
        entry("pi.assistant", [
          { type: "thinking", thinking: "secret plan" },
          { type: "text", text: "Here you go" },
        ]),
      ),
    ).toEqual({ role: "assistant", text: "Here you go", at: 5 });
    expect(
      messageOf(entry("pi.tool-result", [{ type: "text", text: "x".repeat(5000) }]))?.text,
    ).toHaveLength(2000);
  });
});

describe("time phrases", () => {
  // Wednesday 2026-11-04 15:00 WIB.
  const now = Date.UTC(2026, 10, 4, 8);
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 7 * 3_600_000;

  it("reads days, weeks and months in English and Indonesian", () => {
    expect(timeWindowOf("what did we say yesterday", now).window).toEqual({
      since: day(2026, 11, 3),
      until: day(2026, 11, 4) - 1,
    });
    expect(timeWindowOf("rapat kemarin", now).rest).toBe("rapat");
    expect(timeWindowOf("minggu lalu", now).window?.since).toBe(day(2026, 10, 26));
    expect(timeWindowOf("3 days ago", now).window?.since).toBe(day(2026, 11, 1));
    expect(timeWindowOf("bulan lalu", now).window).toEqual({
      since: day(2026, 10, 1),
      until: day(2026, 11, 1) - 1,
    });
    expect(timeWindowOf("the plan in march", now).window?.since).toBe(day(2026, 3, 1));
    expect(timeWindowOf("desember 2025 trip", now).window?.since).toBe(day(2025, 12, 1));
  });

  it("does not read ordinary words as months", () => {
    expect(timeWindowOf("may I see the march schedule", now).window).toBeNull();
    expect(timeWindowOf("launch date", now)).toEqual({ window: null, rest: "launch date" });
  });
});
