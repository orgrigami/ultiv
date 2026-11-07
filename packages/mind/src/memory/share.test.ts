/**
 * Shared team memory (slice 9): a team bot proposes a fact for
 * its team's store; only acceptance shares it; rejection discards;
 * the team's bots recall the accepted facts. An org bot's flow is
 * unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-memory-share-"));
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("team shared memory", () => {
  it("a proposal shares nothing until accepted; rejection discards", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    await handle.mind.org.ensureOrg("owner", "Personal", true);
    const team = await handle.mind.org.createTeam({ name: "ShareD" }, "owner");
    // The first bot lives in the org (it becomes the main bot).
    await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
    const bot = await handle.mind.profiles.create("owner", {
      name: "Sharer",
      onboard: false,
      teamId: team.id,
    });
    const fact = await handle.mind.memory.writeV2({
      owner: "owner",
      scope: "profile",
      profileId: bot.id,
      writer: bot.id,
      text: "The team's staging server is stag.internal.",
    });
    // Not shared yet: the team store is empty while the proposal is open.
    const proposal = await handle.mind.memory.proposeShare({
      owner: "owner",
      profileId: bot.id,
      teamId: team.id,
      factId: fact.id,
      summary: "staging server hostname",
    });
    expect(proposal.kind).toBe("share");
    expect(proposal.status).toBe("open");
    expect(await handle.mind.memory.teamFacts("owner", team.id)).toEqual([]);
    // Rejection discards: the store stays empty, the proposal is decided.
    expect(
      await handle.mind.memory.decideShare({
        owner: "owner",
        teamId: team.id,
        proposalId: proposal.id,
        accept: false,
      }),
    ).toBe("rejected");
    expect(await handle.mind.memory.teamFacts("owner", team.id)).toEqual([]);
    // A second proposal for the same fact, this time accepted.
    const second = await handle.mind.memory.proposeShare({
      owner: "owner",
      profileId: bot.id,
      teamId: team.id,
      factId: fact.id,
      summary: "staging server hostname",
    });
    expect(
      await handle.mind.memory.decideShare({
        owner: "owner",
        teamId: team.id,
        proposalId: second.id,
        accept: true,
      }),
    ).toBe("accepted");
    const shared = await handle.mind.memory.teamFacts("owner", team.id);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.text).toContain("stag.internal");
    expect(shared[0]?.scope).toBe("team");
    await handle.close();
  });

  it("a team bot recalls the shared store; an org bot does not see it", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    await handle.mind.org.ensureOrg("owner", "Personal", true);
    const team = await handle.mind.org.createTeam({ name: "RecallD" }, "owner");
    // The first bot lives in the org (it becomes the main bot).
    await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
    const bot = await handle.mind.profiles.create("owner", {
      name: "Recaller",
      onboard: false,
      teamId: team.id,
    });
    const orgBot = await handle.mind.profiles.create("owner", { name: "Loner", onboard: false });
    const fact = await handle.mind.memory.writeV2({
      owner: "owner",
      scope: "profile",
      profileId: bot.id,
      writer: bot.id,
      text: "Shared wifi password is printed at the front desk.",
    });
    const proposal = await handle.mind.memory.proposeShare({
      owner: "owner",
      profileId: bot.id,
      teamId: team.id,
      factId: fact.id,
      summary: "wifi password location",
    });
    await handle.mind.memory.decideShare({
      owner: "owner",
      teamId: team.id,
      proposalId: proposal.id,
      accept: true,
    });
    // The team bot recalls it (its team store joins the pool).
    const seen = await handle.mind.memory.recallV2("owner", bot.id, {
      query: "wifi password",
      extraStores: [`team:owner:${team.id}`],
    });
    expect(seen.facts.some((row) => row.id === fact.id)).toBe(true);
    // An org bot (no team) gets nothing of the team store.
    const lone = await handle.mind.memory.recallV2("owner", orgBot.id, { query: "wifi password" });
    expect(lone.facts.some((row) => row.id === fact.id)).toBe(false);
    await handle.close();
  });

  it("refuses to share a fact the bot does not remember", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    await handle.mind.org.ensureOrg("owner", "Personal", true);
    const team = await handle.mind.org.createTeam({ name: "GuardD" }, "owner");
    await expect(
      handle.mind.memory.proposeShare({
        owner: "owner",
        profileId: "ghost-bot",
        teamId: team.id,
        factId: "no-such-fact",
        summary: "invented",
      }),
    ).rejects.toThrow(/share a fact you actually remember/);
    await handle.close();
  });
});
