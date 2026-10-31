import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { EpisodesDoc } from "./model.ts";
import { Effect } from "effect";
import { forgetFact, forgetVerdict } from "./forget.ts";
import { openMind } from "../entity.ts";
import { profileKey } from "./model.ts";

describe("forget authorization", () => {
  it("refuses owner-stated facts without an owner-voiced, clean turn", () => {
    // No context (REST/human path aside, a bot turn always has one): refuse.
    expect(forgetVerdict({ trust: "owner" }, null).ok).toBe(false);
    // Owner-voiced but tainted: refuse.
    expect(
      forgetVerdict({ trust: "owner" }, { origin: "owner", tainted: true, ownerInput: "forget it" })
        .ok,
    ).toBe(false);
    // Clean owner turn: allowed — either store.
    expect(
      forgetVerdict(
        { trust: "owner" },
        { origin: "owner", tainted: false, ownerInput: "forget it" },
      ).ok,
    ).toBe(true);
  });

  it("refuses retractions on outside-content turns, allows own facts otherwise", () => {
    expect(
      forgetVerdict({ trust: "self" }, { origin: "webhook", tainted: true, ownerInput: null }).ok,
    ).toBe(false);
    expect(forgetVerdict({ trust: "self" }, null).ok).toBe(true);
    expect(forgetVerdict({ trust: "derived" }, null).ok).toBe(true);
  });
});

describe("forgetFact (offline, MemoryStorage)", () => {
  it("tombstones a bot's own fact and keeps the reason as an episode", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { memory, converse, profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Retractor" });
    const fact = await memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text: "the standup is at 9am",
    });
    await memory.forget("harry", bot.id, fact.id, "the standup moved to 10am", null);
    const facts = await memory.readFacts("harry", bot.id);
    expect(facts.find((entry) => entry.id === fact.id)?.status).toBe("forgotten");
    // The reason survives as an episode (purge clears it later).
    const episodes = await Effect.runPromise(
      converse.docs.snapshotKeyed(EpisodesDoc, profileKey("harry", bot.id)),
    ).then((store) => store?.episodes ?? []);
    const why = episodes.find((episode) => episode.origin === "forget");
    expect(why?.input).toBe("the standup moved to 10am");
    expect(why?.facts).toEqual([fact.id]);
    await handle.close();
  });

  it("refuses to forget an owner-stated fact without an owner turn", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { memory, profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Eager" });
    // writer null = human/REST: trust owner, in the BOT's own store.
    const stated = await memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: null,
      text: "harry's anniversary is may 3",
    });
    let refused = false;
    try {
      await memory.forget("harry", bot.id, stated.id, "nonsense", null);
    } catch (cause) {
      refused = (cause as { reason?: string }).reason?.includes("owner-stated") === true;
    }
    expect(refused).toBe(true);
    const facts = await memory.readFacts("harry", bot.id);
    expect(facts.find((entry) => entry.id === stated.id)?.status).toBe("current");
    await handle.close();
  });

  it("refuses to forget an owner-store fact stated by the owner", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { memory, profiles } = handle.mind;
    const keeper = await profiles.create("harry", {
      name: "Keeper",
      policies: {
        canInitiate: [],
        autoApprove: [],
        approvalMode: "manual",
        approvalTimeout: "deny",
        dailyTurnBudget: null,
        memoryKeeper: true,
      },
    });
    await memory.write({
      owner: "harry",
      writer: keeper.id,
      scope: "owner",
      text: "harry wakes at 5am",
    });
    const ownerFacts = await memory.readFacts("harry", null);
    const stated = ownerFacts.find((fact) => fact.trust === "owner");
    expect(stated).toBeDefined();
    let refused = false;
    try {
      await memory.forget("harry", keeper.id, stated?.id ?? "", "nope", null);
    } catch (cause) {
      refused = (cause as { reason?: string }).reason?.includes("owner-stated") === true;
    }
    expect(refused).toBe(true);
    await handle.close();
  });

  it("does not find facts from a sibling's store", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { memory, profiles } = handle.mind;
    const a = await profiles.create("harry", { name: "Alpha" });
    const b = await profiles.create("harry", { name: "Beta" });
    const fact = await memory.writeV2({
      owner: "harry",
      profileId: a.id,
      scope: "profile",
      writer: a.id,
      text: "alpha's private note",
    });
    let notFound = false;
    try {
      await forgetFact(
        { converse: handle.mind.converse, profiles, guard: {} },
        "harry",
        b.id,
        fact.id,
        "x",
        null,
      );
    } catch (cause) {
      notFound = (cause as { _tag?: string })._tag === "spreissen/NotFound";
    }
    expect(notFound).toBe(true);
    await handle.close();
  });
});
