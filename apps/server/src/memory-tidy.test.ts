import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind, ProposalsDoc, ownerKey } from "@spreissen/mind";
import type { MemoryProposal } from "@spreissen/contracts";
import { ownersWithProfiles, runTidy, tidyStore } from "./memory-tidy.ts";

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
