import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind, ProposalsDoc, ownerKey } from "@spriessen/mind";
import type { MemoryProposal } from "@spriessen/contracts";
import { ownersWithProfiles, runTidy, tidyPush, tidyStore } from "./memory-tidy.ts";

describe("memory tidy ownership", () => {
  it("tidies the OWNER STORE under the caller's owner id (not a hardcoded one)", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    // The web user's label is the header id (guest in practice) — "default"
    // matches nothing.
    const bot = await mind.profiles.create("guest", { name: "Tidied" });
    // Two identical owner-store facts → an exact-duplicate merge proposal.
    await mind.memory.write({ owner: "guest", writer: null, scope: "owner", text: "wakes at 5am" });
    await mind.memory.write({ owner: "guest", writer: null, scope: "owner", text: "wakes at 5am" });
    const result = await runTidy({ mind }, "guest");
    expect(result.owner).toBe("guest");
    expect(result.proposals).toBeGreaterThanOrEqual(1);
    const store = await Effect.runPromise(
      mind.converse.docs.snapshotKeyed(ProposalsDoc, ownerKey("guest")),
    ).then((draft) => draft?.proposals ?? []);
    expect(store.some((proposal) => proposal.kind === "merge")).toBe(true);
    expect(bot).toBeDefined();
    await handle.close();
  });

  it("keeps rejected proposals recorded so their fingerprints never return", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("guest", { name: "Rejector" });
    await mind.memory.write({
      owner: "guest",
      writer: bot.id,
      scope: "profile",
      profileId: bot.id,
      text: "likes surabaya",
    });
    await mind.memory.write({
      owner: "guest",
      writer: bot.id,
      scope: "profile",
      profileId: bot.id,
      text: "likes surabaya",
    });
    const first = await tidyStore({ mind }, "guest", bot.id);
    expect(first.created).toBe(1);
    // The owner rejects it.
    const key = `profile:guest:${bot.id}`;
    await Effect.runPromise(
      mind.converse.docs.commit(async (tx) => {
        const store = await tx.doc(ProposalsDoc, key, { proposals: [] });
        store.proposals = store.proposals.map((proposal: MemoryProposal) =>
          proposal.status === "open"
            ? { ...proposal, status: "rejected" as const, decidedAt: Date.now() }
            : proposal,
        );
      }),
    );
    // A second run re-detects nothing NEW — the rejected fingerprint blocks it.
    const second = await tidyStore({ mind }, "guest", bot.id);
    expect(second.created).toBe(0);
    const store = await Effect.runPromise(mind.converse.docs.snapshotKeyed(ProposalsDoc, key)).then(
      (draft) => draft?.proposals ?? [],
    );
    expect(store.some((proposal) => proposal.status === "rejected")).toBe(true);
    await handle.close();
  });

  it("lists every owner that has profiles", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    await mind.profiles.create("guest", { name: "One" });
    await mind.profiles.create("harry", { name: "Two" });
    const owners = await ownersWithProfiles(mind);
    expect(owners.sort()).toEqual(["guest", "harry"]);
    await handle.close();
  });
});

describe("the tidy push", () => {
  it("opens Needs you, where the proposals wait per bot", async () => {
    const sent: { url: string; tag: string }[] = [];
    await tidyPush({ notify: async (_owner, push) => void sent.push(push) })("owner", "x");
    expect(sent).toEqual([expect.objectContaining({ url: "/now", tag: "memory-tidy" })]);
  });
});

describe("the soft limit", () => {
  it("proposes archiving the least valuable facts only past it", async () => {
    const { detectOversize } = await import("./memory-tidy.ts");
    const { LIMITS, newFact } = await import("@spriessen/mind");
    const make = (i: number, importance: number, trust: "self" | "owner" = "self") =>
      newFact({
        id: `f${i}`,
        scope: "profile",
        profile: "p",
        text: `fact ${i}`,
        kind: "note",
        tags: [],
        entities: [],
        triple: null,
        importance,
        confidence: 0.7,
        trust,
        source: { via: "tool", writer: "p", origin: "owner", conversation: null, episode: null },
        validFrom: null,
        supersedes: [],
        at: i,
      });
    const under = Array.from({ length: 20 }, (_, i) => make(i, 1));
    expect(detectOversize(under)).toEqual([]);
    const over = Array.from({ length: LIMITS.softFacts + 3 }, (_, i) =>
      make(i, i < 2 ? 5 : i === 2 ? 1 : 2, i === 3 ? "owner" : "self"),
    );
    const proposals = detectOversize(over);
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => p.kind === "archive")).toBe(true);
    // Oldest low-importance first; never the owner's word, never importance > 2.
    expect(proposals.map((p) => p.factIds[0])).toEqual(["f2", "f4", "f5"]);
  });
});
