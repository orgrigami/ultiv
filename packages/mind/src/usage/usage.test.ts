/**
 * The daily spend ledger: adds land per profile per day, the window is
 * bounded, and the sink resolves a conversation's profile before recording
 * (unknown conversations record nothing).
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { usageDay, usageSinkOf } from "./usage.ts";

describe("the daily spend ledger", () => {
  it("sums per profile per day and reads today back", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    await handle.mind.usage.add("owner", "bot-1", { input: 10, output: 5, totalTokens: 15 });
    await handle.mind.usage.add("owner", "bot-1", { input: 1, output: 1, totalTokens: 2 });
    await handle.mind.usage.add("owner", "bot-2", { input: 0, output: 0, totalTokens: 7 });
    expect(await handle.mind.usage.today("owner", "bot-1")).toBe(17);
    expect(await handle.mind.usage.today("owner", "bot-2")).toBe(7);
    expect(await handle.mind.usage.today("owner", "bot-3")).toBe(0);
    const days = await handle.mind.usage.of("owner", "bot-1");
    expect(days).toEqual([{ day: usageDay(), tokens: 17 }]);
    await handle.close();
  });

  it("the sink records through the profile index and skips unknown conversations", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const bot = await handle.mind.profiles.create("owner", { name: "Spender" });
    const main = await handle.mind.profiles.ensureMain("owner", bot.id);
    // The conversation→profile index fills from the stored rows.
    await handle.mind.profiles.chatConversations();
    const key = await handle.mind.profiles.keyOfRow(main);
    const cid = String((await Effect.runPromise(handle.mind.converse.ensure(key))).id);
    const sink = usageSinkOf({
      converse: handle.mind.converse,
      usage: handle.mind.usage,
      scopeOf: (conversationId) => handle.mind.profiles.scopeOf(conversationId),
    });
    sink(String(cid), { input: 3, output: 4, totalTokens: 7 });
    sink("unknown-conversation", { input: 0, output: 0, totalTokens: 99 });
    // The sink records async; give the write a beat.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await handle.mind.usage.today("owner", bot.id)).toBe(7);
    await handle.close();
  });
});
