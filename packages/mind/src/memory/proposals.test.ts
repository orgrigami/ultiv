import { MemoryStorage } from "@earendil-works/pi-durable";
import type { MemoryFact, MemoryProposal } from "@spriessen/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { openMind } from "../entity.ts";
import { ProposalsDoc, profileKey } from "./model.ts";
import { applyProposal, decideProposal } from "./proposals.ts";

const fact = (id: string, status: MemoryFact["status"] = "current"): MemoryFact =>
  ({
    id,
    text: `fact ${id}`,
    status,
    validFrom: 1_000,
    validTo: null,
    expiredAt: null,
    supersededBy: null,
    supersedes: [],
  }) as unknown as MemoryFact;

const statusOf = (facts: readonly MemoryFact[], id: string) =>
  facts.find((entry) => entry.id === id)?.status;

describe("applyProposal (pure)", () => {
  it("archives current facts and leaves a forgotten one alone", () => {
    const { facts, skipped } = applyProposal(
      { kind: "archive", factIds: ["a", "b"] },
      [fact("a"), fact("b", "forgotten")],
      5_000,
    );
    expect(statusOf(facts, "a")).toBe("archived");
    // The bug this guards: archiving a forgotten fact took it out of Purge.
    expect(statusOf(facts, "b")).toBe("forgotten");
    expect(skipped).toEqual(["b"]);
  });

  it("forgets a secret from any state but forgotten", () => {
    const { facts } = applyProposal(
      { kind: "secret", factIds: ["a", "b"] },
      [fact("a", "archived"), fact("b")],
      5_000,
    );
    expect(statusOf(facts, "a")).toBe("forgotten");
    expect(statusOf(facts, "b")).toBe("forgotten");
  });

  it("merges into a current primary only", () => {
    const merged = applyProposal(
      { kind: "merge", factIds: ["p", "x"] },
      [fact("p"), fact("x")],
      5_000,
    );
    expect(merged.facts.find((entry) => entry.id === "x")).toMatchObject({
      status: "superseded",
      supersededBy: "p",
    });
    const gone = applyProposal(
      { kind: "merge", factIds: ["p", "x"] },
      [fact("p", "forgotten"), fact("x")],
      5_000,
    );
    expect(statusOf(gone.facts, "x")).toBe("current");
    expect(gone.skipped).toEqual(["p", "x"]);
  });

  it("resolves a conflict only while both sides are current", () => {
    const stale = applyProposal(
      { kind: "conflict", factIds: ["old", "new"] },
      [fact("old"), fact("new", "forgotten")],
      5_000,
    );
    expect(statusOf(stale.facts, "old")).toBe("current");
    expect(stale.skipped).toEqual(["old", "new"]);
  });
});

const seed = async (proposal: Partial<MemoryProposal>) => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { mind } = handle;
  const bot = await mind.profiles.create("harry", { name: "Tidy", onboard: false });
  const write = (text: string) =>
    mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text,
    });
  const a = await write("the printer is on the second floor");
  const b = await write("the wifi password hint is the cat's name");
  const key = profileKey("harry", bot.id);
  await Effect.runPromise(
    mind.converse.docs.commit(async (tx) => {
      const store = await tx.doc(ProposalsDoc, key, { proposals: [] });
      store.proposals = [
        {
          id: "p1",
          kind: "archive",
          at: Date.now(),
          factIds: [a.id, b.id],
          summary: "old",
          fingerprint: "archive|x",
          status: "open",
          decidedAt: null,
          ...proposal,
        },
      ];
    }),
  );
  return { handle, mind, bot, key, a, b };
};

describe("decideProposal", () => {
  it("applies once: a second decision is refused and changes nothing", async () => {
    const { handle, mind, key } = await seed({});
    const first = await decideProposal(mind.converse, key, "p1", "accept");
    expect(first).toMatchObject({ kind: "done", status: "accepted", skipped: [] });
    const second = await decideProposal(mind.converse, key, "p1", "accept");
    expect(second).toEqual({ kind: "decided", status: "accepted" });
    const reject = await decideProposal(mind.converse, key, "p1", "reject");
    expect(reject).toEqual({ kind: "decided", status: "accepted" });
    expect(await decideProposal(mind.converse, key, "nope", "accept")).toEqual({
      kind: "unknown",
    });
    await handle.close();
  });

  it("skips a fact forgotten since the suggestion, so Purge still reaches it", async () => {
    const { handle, mind, bot, key, a, b } = await seed({});
    await mind.memory.tombstone("harry", bot.id, b.id);
    const outcome = await decideProposal(mind.converse, key, "p1", "accept");
    expect(outcome).toMatchObject({ kind: "done", skipped: [b.id] });
    const facts = await mind.memory.readFacts("harry", bot.id);
    expect(statusOf(facts, a.id)).toBe("archived");
    expect(statusOf(facts, b.id)).toBe("forgotten");
    expect(await mind.memory.purge("harry", bot.id)).toBe(1);
    await handle.close();
  });

  it("a reject changes no fact", async () => {
    const { handle, mind, bot, key, a, b } = await seed({});
    expect(await decideProposal(mind.converse, key, "p1", "reject")).toMatchObject({
      kind: "done",
      status: "rejected",
    });
    const facts = await mind.memory.readFacts("harry", bot.id);
    expect([statusOf(facts, a.id), statusOf(facts, b.id)]).toEqual(["current", "current"]);
    await handle.close();
  });
});
