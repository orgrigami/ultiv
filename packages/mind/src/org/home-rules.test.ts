/**
 * The main-bot home rules: the main bot is an org bot and the org keeps at
 * least one active bot — the pure check and the profiles service that asks it.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { homeRuleProblem, openMind } from "@spriessen/mind";

const row = (id: string, departmentId: string | null, archivedAt: number | null = null) => ({
  id,
  owner: "owner-a",
  departmentId,
  archivedAt,
});

describe("homeRuleProblem", () => {
  const rows = [row("main", null), row("org-2", null), row("dept-bot", "dept-x")];

  it("keeps the main bot in the org", () => {
    expect(
      homeRuleProblem(rows, "owner-a", "main", { kind: "move", id: "main", to: "dept-x" }),
    ).toMatch(/main bot lives in the org/);
    expect(
      homeRuleProblem(rows, "owner-a", "main", { kind: "move", id: "org-2", to: "dept-x" }),
    ).toBeNull();
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "set-main", id: "dept-bot" })).toMatch(
      /must be an org bot/,
    );
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "set-main", id: "org-2" })).toBeNull();
  });

  it("never leaves the org without a bot", () => {
    const two = [row("main", null), row("dept-bot", "dept-x")];
    expect(
      homeRuleProblem(two, "owner-a", null, { kind: "move", id: "main", to: "dept-x" }),
    ).toMatch(/at least one bot/);
    expect(homeRuleProblem(two, "owner-a", null, { kind: "remove", id: "main" })).toMatch(
      /at least one bot/,
    );
    expect(homeRuleProblem(two, "owner-a", null, { kind: "archive", id: "main" })).toMatch(
      /paused/,
    );
    expect(homeRuleProblem(two, "owner-a", null, { kind: "remove", id: "dept-bot" })).toBeNull();
    // A paused org bot does not count as keeping the org.
    const paused = [row("main", null), row("org-2", null, 5)];
    expect(homeRuleProblem(paused, "owner-a", null, { kind: "remove", id: "main" })).toMatch(
      /at least one bot/,
    );
  });

  it("refuses removing or pausing the main bot, and a first bot in a department", () => {
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "remove", id: "main" })).toMatch(
      /main bot cannot be removed/,
    );
    expect(homeRuleProblem(rows, "owner-a", "main", { kind: "archive", id: "main" })).toMatch(
      /main bot cannot be paused/,
    );
    expect(homeRuleProblem([], "owner-a", null, { kind: "create", to: "dept-x" })).toMatch(
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
    const dept = await org.createDepartment({ name: "Dept X" }, "owner-a");
    await expect(
      profiles.create("owner-a", { name: "Early", onboard: false, departmentId: dept.id }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/first bot lives in the org/) });
    const main = await profiles.create("owner-a", { name: "Kestrel", onboard: false });
    expect(await profiles.mainOf("owner-a")).toBe(main.id);
    const other = await profiles.create("owner-a", {
      name: "Wren",
      onboard: false,
      departmentId: dept.id,
    });
    await expect(
      profiles.update("owner-a", main.id, { departmentId: dept.id }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/main bot lives in the org/) });
    await expect(profiles.setMain("owner-a", other.id)).rejects.toMatchObject({
      reason: expect.stringMatching(/must be an org bot/),
    });
    await expect(profiles.setArchived("owner-a", main.id, true)).rejects.toMatchObject({
      reason: expect.stringMatching(/cannot be paused/),
    });
    await expect(profiles.remove("owner-a", main.id)).rejects.toMatchObject({
      reason: expect.stringMatching(/cannot be removed/),
    });
    // Allowed: the department bot moves, pauses and goes.
    await profiles.update("owner-a", other.id, { departmentId: null });
    await profiles.setArchived("owner-a", other.id, true);
    await profiles.remove("owner-a", other.id);
    await handle.close();
  });
});
