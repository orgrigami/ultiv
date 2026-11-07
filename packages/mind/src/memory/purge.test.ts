/**
 * The deletion boundary: Forget hides one fact (restorable), Purge deletes
 * the text of forgotten facts and of the inputs that taught them, and
 * nothing else. A purged fact can't come back by Restore, by the search
 * sidecar, or by dedupe swallowing the owner saying it again.
 */
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { openMind } from "../entity.ts";
import { EpisodesDoc, profileKey } from "./model.ts";

const open = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const bot = await handle.mind.profiles.create("harry", { name: "Keeper" });
  const write = (text: string) =>
    handle.mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text,
    });
  const episodes = () =>
    Effect.runPromise(
      handle.mind.converse.docs.snapshotKeyed(EpisodesDoc, profileKey("harry", bot.id)),
    ).then((store) => store?.episodes ?? []);
  return { handle, bot, memory: handle.mind.memory, write, episodes };
};

describe("purge", () => {
  it("clears only the evidence of forgotten facts", async () => {
    const { handle, bot, memory, write, episodes } = await open();
    const kept = await write("the office plant is a monstera");
    const gone = await write("the spare key is under the blue pot");
    await memory.forget("harry", bot.id, gone.id, "moved the key", null);
    expect(await memory.purge("harry", bot.id)).toBe(1);

    const after = await episodes();
    const keptEpisode = after.find((episode) => episode.facts.includes(kept.id));
    expect(keptEpisode?.input).toBe("the office plant is a monstera");
    // The forgotten fact's input and the forget's reason are both gone.
    for (const episode of after.filter((entry) => entry.facts.includes(gone.id))) {
      expect(episode.input).toBe("");
    }
    const facts = await memory.readFacts("harry", bot.id);
    expect(facts.find((fact) => fact.id === kept.id)?.text).toBe("the office plant is a monstera");
    expect(facts.find((fact) => fact.id === gone.id)?.text).toBe("");
    await handle.close();
  });

  it("leaves the search index too: recall no longer finds the text", async () => {
    const { handle, bot, memory, write } = await open();
    const gone = await write("the spare key is under the blue pot");
    const before = await memory.recallV2("harry", bot.id, { query: "spare key blue pot" });
    expect(before.facts.map((fact) => fact.id)).toContain(gone.id);
    await memory.forget("harry", bot.id, gone.id, "", null);
    await memory.purge("harry", bot.id);
    const after = await memory.recallV2("harry", bot.id, { query: "spare key blue pot" });
    expect(after.facts.map((fact) => fact.id)).not.toContain(gone.id);
    await handle.close();
  });

  it("saying it again adds a new fact instead of reviving the tombstone", async () => {
    const { handle, bot, memory, write } = await open();
    const gone = await write("the spare key is under the blue pot");
    await memory.forget("harry", bot.id, gone.id, "", null);
    await memory.purge("harry", bot.id);
    const again = await write("the spare key is under the blue pot");
    expect(again.id).not.toBe(gone.id);
    const facts = await memory.readFacts("harry", bot.id);
    expect(facts.find((fact) => fact.id === again.id)?.status).toBe("current");
    expect(facts.find((fact) => fact.id === gone.id)?.status).toBe("forgotten");
    await handle.close();
  });
});

describe("restore", () => {
  it("brings back a forgotten fact that still has its text", async () => {
    const { handle, bot, memory, write } = await open();
    const fact = await write("standup is at nine");
    await memory.forget("harry", bot.id, fact.id, "", null);
    await memory.restore("harry", bot.id, fact.id);
    const facts = await memory.readFacts("harry", bot.id);
    expect(facts.find((entry) => entry.id === fact.id)?.status).toBe("current");
    await handle.close();
  });

  it("refuses a purged fact and an unknown one, changing nothing", async () => {
    const { handle, bot, memory, write } = await open();
    const fact = await write("standup is at nine");
    await memory.forget("harry", bot.id, fact.id, "", null);
    await memory.purge("harry", bot.id);
    await expect(memory.restore("harry", bot.id, fact.id)).rejects.toMatchObject({
      reason: expect.stringContaining("purged"),
    });
    await expect(memory.restore("harry", bot.id, "no-such-fact")).rejects.toMatchObject({
      what: expect.stringContaining("no-such-fact"),
    });
    const facts = await memory.readFacts("harry", bot.id);
    expect(facts.find((entry) => entry.id === fact.id)).toMatchObject({
      status: "forgotten",
      text: "",
    });
    await handle.close();
  });
});
