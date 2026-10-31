/**
 * Slices 1 and 2: the org data model and the workspace-to-org migration.
 * The migration runs on fake real-shaped data (pre-org rows with no home
 * fields, a main bot, no org document); the invariant checks hold the
 * one-home rule.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { ProfileInfo } from "@spriessen/contracts";
import {
  checkHomes,
  commitOrg,
  defaultVm,
  effectiveHostAccess,
  emptyOrgState,
  FactsDoc,
  homeOf,
  homeOfResource,
  migrateOrg,
  openMind,
  OrgDoc,
  readOrgState,
} from "@spriessen/mind";
import { commitProfiles } from "@spriessen/mind";
import { Effect } from "effect";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-org-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A pre-org bot row: no home fields at all (as stored before this phase). */
const preOrg = (overrides: Partial<ProfileInfo> = {}): ProfileInfo =>
  ({
    id: "bot-1",
    owner: "owner",
    name: "Scout",
    description: "",
    persona: "",
    timezone: "Asia/Jakarta",
    model: null,
    toolAllowlist: null,
    policies: {
      canInitiate: ["*"],
      autoApprove: [],
      approvalMode: "manual",
      approvalTimeout: "deny",
      dailyTurnBudget: null,
      memoryKeeper: false,
    },
    createdAt: 1,
    archivedAt: null,
    ...overrides,
  }) satisfies ProfileInfo as ProfileInfo;

describe("the workspace-to-org migration", () => {
  it("turns the workspace into the org Personal; every bot an org bot", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const converse = handle.mind.converse;
    // Fake real-shaped data: two pre-org bots and a main-bot entry.
    const a = preOrg({ id: "bot-a", name: "Scout" });
    const b = preOrg({ id: "bot-b", name: "Scribe" });
    await commitProfiles(converse, () => [a, b]);
    const report = await migrateOrg(converse, { owner: "owner" });
    expect(report.createdOrg).toBe(true);
    expect(report.botsStamped).toBe(2);
    expect(report.departments).toBe(0);
    const state = await readOrgState(converse);
    expect(state.org?.name).toBe("Personal");
    expect(state.org?.owner).toBe("owner");
    expect(state.org?.hostAccess).toBe(true);
    expect(state.org?.vm).toEqual(defaultVm());
    expect(state.departments).toEqual([]);
    expect(state.members).toEqual([{ accountId: "owner", role: "owner", departmentId: null }]);
    const rows = await handle.mind.profiles.list("owner");
    expect(rows.map((row) => [row.id, row.departmentId, row.hostAccess])).toEqual([
      ["bot-a", null, true],
      ["bot-b", null, true],
    ]);
    await handle.close();
  });

  it("moves nothing bot-owned: memory stays under the bot's own key", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const converse = handle.mind.converse;
    const bot = preOrg({ id: "bot-m" });
    await commitProfiles(converse, () => [bot]);
    // A memory family the bot owns, written before the migration: facts
    // under the bot's own profile key (the v2 store's family doc).
    await converse.docs.commit(async (tx) => {
      const draft = await tx.doc(
        FactsDoc as never,
        "profile:owner:bot-m" as never,
        {
          facts: [],
          migratedAt: null,
        } as never,
      );
      (draft as unknown as { facts: unknown[] }).facts = [
        { id: "f1", text: "the depot gate code is 1234" },
      ];
    });
    const before = await Effect.runPromise(
      converse.docs.snapshotKeyed(FactsDoc as never, "profile:owner:bot-m" as never),
    );
    await migrateOrg(converse, { owner: "owner" });
    const after = await Effect.runPromise(
      converse.docs.snapshotKeyed(FactsDoc as never, "profile:owner:bot-m" as never),
    );
    expect(after).toEqual(before);
    expect((after as { facts?: unknown }).facts).toHaveLength(1);
    await handle.close();
  });

  it("is repeatable: a second run changes nothing", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const converse = handle.mind.converse;
    await commitProfiles(converse, () => [preOrg({ id: "bot-r" })]);
    await migrateOrg(converse, { owner: "owner" });
    const afterFirst = await readOrgState(converse);
    const report = await migrateOrg(converse, { owner: "owner" });
    expect(report).toEqual({ createdOrg: false, botsStamped: 0, departments: 0 });
    expect(await readOrgState(converse)).toEqual(afterFirst);
    await handle.close();
  });

  it("a restart keeps a moved bot and a switch turned off (it runs at every boot)", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const converse = handle.mind.converse;
    await commitProfiles(converse, () => [preOrg({ id: "bot-a" })]);
    await migrateOrg(converse, { owner: "owner" });
    const dept = await handle.mind.org.createDepartment({ name: "Dept X" }, "owner");
    await handle.mind.profiles.update("owner", "bot-a", { departmentId: dept.id });
    // A bot made after the migration starts with its switch off.
    const fresh = await handle.mind.profiles.create("owner", { name: "Wren", onboard: false });
    const report = await migrateOrg(converse, { owner: "owner" });
    expect(report.botsStamped).toBe(0);
    const rows = await handle.mind.profiles.list("owner");
    expect(rows.map((row) => [row.id, row.departmentId, row.hostAccess])).toEqual([
      ["bot-a", dept.id, true],
      [fresh.id, null, false],
    ]);
    await handle.close();
  });

  it("stamps only what is missing on a partially stamped workspace", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const converse = handle.mind.converse;
    await commitProfiles(converse, () => [
      preOrg({ id: "bot-s", departmentId: null, hostAccess: true }),
    ]);
    const report = await migrateOrg(converse, { owner: "owner" });
    expect(report.botsStamped).toBe(0);
    await handle.close();
  });
});

describe("the one-home invariant", () => {
  const departments = [{ id: "dept-x" }, { id: "dept-y" }];

  it("org with only bots and no departments is valid", () => {
    expect(checkHomes([preOrg({ id: "b1" }), preOrg({ id: "b2" })], [])).toEqual([]);
  });

  it("a department bot's home is its department", () => {
    expect(homeOf({ departmentId: "dept-x" })).toEqual({
      kind: "department",
      departmentId: "dept-x",
    });
    expect(homeOf({ departmentId: null })).toEqual({ kind: "org" });
    expect(checkHomes([preOrg({ id: "b1", departmentId: "dept-x" })], departments)).toEqual([]);
  });

  it("flags a bot whose department does not exist", () => {
    const bad = checkHomes([preOrg({ id: "b1", departmentId: "dept-gone" })], departments);
    expect(bad).toEqual([
      { what: "bot", id: "b1", problem: "department dept-gone does not exist" },
    ]);
  });

  it("a resource's home is its bot's home; an unknown bot is no home", () => {
    const profiles = new Map(
      [preOrg({ id: "b1", departmentId: "dept-x" }), preOrg({ id: "b2" })].map((row) => [
        row.id,
        row,
      ]),
    );
    const profileOf = (id: string) => profiles.get(id);
    expect(homeOfResource({ profileId: "b1" }, profileOf)).toEqual({
      kind: "department",
      departmentId: "dept-x",
    });
    expect(homeOfResource({ profileId: "b2" }, profileOf)).toEqual({ kind: "org" });
    expect(homeOfResource({ profileId: "ghost" }, profileOf)).toBeNull();
  });

  it("the home field is single-valued: one department, never two", () => {
    // The stored field is one string or null — two homes cannot be stored.
    const row = preOrg({ id: "b1", departmentId: "dept-x" });
    expect(row.departmentId).toBe("dept-x");
  });
});

describe("host access flags (slice 11 data)", () => {
  const org = { hostAccess: true };
  const departments = [
    { id: "dept-x", hostAccess: true },
    { id: "dept-y", hostAccess: false },
  ];
  it("org AND department AND bot for a department bot; org AND bot for an org bot", () => {
    expect(
      effectiveHostAccess(org, departments, { departmentId: "dept-x", hostAccess: true }),
    ).toEqual({
      allowed: true,
      blockedBy: null,
    });
    expect(
      effectiveHostAccess(org, departments, { departmentId: "dept-x", hostAccess: false }),
    ).toEqual({
      allowed: false,
      blockedBy: "bot",
    });
    expect(
      effectiveHostAccess(org, departments, { departmentId: "dept-y", hostAccess: true }),
    ).toEqual({
      allowed: false,
      blockedBy: "department",
    });
    expect(effectiveHostAccess(org, departments, { departmentId: null, hostAccess: true })).toEqual(
      {
        allowed: true,
        blockedBy: null,
      },
    );
  });
});
