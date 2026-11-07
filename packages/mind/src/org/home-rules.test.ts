/**
 * The main-bot home rules: the main bot is an org bot and the org keeps at
 * least one active bot — the pure check and the profiles service that asks it.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { homeRuleProblem, openMind } from "@spriessen/mind";

const row = (id: string, teamId: string | null, archivedAt: number | null = null) => ({
  id,
  owner: "owner-a",
  teamId,
  archivedAt,
});

describe("homeRuleProblem", () => {
  const rows = [row("main", null), row("org-2", null), row("team-bot", "team-x")];

  it("keeps the main bot in the org", () => {
    expect(
      homeRuleProblem(rows, "owner-a", "main", { kind: "move", id: "main", to: "team-x" }),
    ).toMatch(/main bot lives in the org/);
    expect(
      homeRuleProblem(rows, "owner-a", "main", { kind: "move", id: "org-2", to: "team-x" }),
    ).toBeNull();
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "set-main", id: "team-bot" })).toMatch(
      /must be an org bot/,
    );
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "set-main", id: "org-2" })).toBeNull();
  });

  it("never leaves the org without a bot", () => {
    const two = [row("main", null), row("team-bot", "team-x")];
    expect(
      homeRuleProblem(two, "owner-a", null, { kind: "move", id: "main", to: "team-x" }),
    ).toMatch(/at least one bot/);
    expect(homeRuleProblem(two, "owner-a", null, { kind: "remove", id: "main" })).toMatch(
      /at least one bot/,
    );
    expect(homeRuleProblem(two, "owner-a", null, { kind: "archive", id: "main" })).toMatch(
      /paused/,
    );
    expect(homeRuleProblem(two, "owner-a", null, { kind: "remove", id: "team-bot" })).toBeNull();
    // A paused org bot does not count as keeping the org.
    const paused = [row("main", null), row("org-2", null, 5)];
    expect(homeRuleProblem(paused, "owner-a", null, { kind: "remove", id: "main" })).toMatch(
      /at least one bot/,
    );
  });

  it("refuses removing or pausing the main bot, and a first bot in a team", () => {
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "remove", id: "main" })).toMatch(
      /main bot cannot be removed/,
    );
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "archive", id: "main" })).toMatch(
      /main bot cannot be paused/,
    );
    expect(homeRuleProblem([], "owner-a", null, { kind: "create", to: "team-x" })).toMatch(
      /first bot lives in the org/,
    );
    expect(homeRuleProblem([], "owner-a", null, { kind: "create", to: null })).toBeNull();
  });
});

describe("the profiles service asks the rules", () => {
  it("refuses each breaking write with the rule's words", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles, org } = handle.mind;
    await org.ensureOrg("owner-a", "Org A", false);
    const team = await org.createTeam({ name: "Team X" }, "owner-a");
    await expect(
      profiles.create("owner-a", { name: "Early", onboard: false, teamId: team.id }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/first bot lives in the org/) });
    const main = await profiles.create("owner-a", { name: "Kestrel", onboard: false });
    expect(await profiles.mainOf("owner-a")).toBe(main.id);
    const other = await profiles.create("owner-a", {
      name: "Wren",
      onboard: false,
      teamId: team.id,
    });
    await expect(profiles.update("owner-a", main.id, { teamId: team.id })).rejects.toMatchObject({
      reason: expect.stringMatching(/main bot lives in the org/),
    });
    await expect(profiles.setMain("owner-a", other.id)).rejects.toMatchObject({
      reason: expect.stringMatching(/must be an org bot/),
    });
    await expect(profiles.setArchived("owner-a", main.id, true)).rejects.toMatchObject({
      reason: expect.stringMatching(/cannot be paused/),
    });
    await expect(profiles.remove("owner-a", main.id)).rejects.toMatchObject({
      reason: expect.stringMatching(/cannot be removed/),
    });
    // Allowed: the team bot moves, pauses and goes.
    await profiles.update("owner-a", other.id, { teamId: null });
    await profiles.setArchived("owner-a", other.id, true);
    await profiles.remove("owner-a", other.id);
    await handle.close();
  });
});
