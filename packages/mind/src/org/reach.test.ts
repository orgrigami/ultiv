/**
 * Open reach (slice 5): cross-home matrix, the mailbox reach audit over the
 * real wired mind, and the broker's granted-credential resolution.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { commitProfiles } from "@spriessen/mind";
import { crossHome, grantedCredential } from "@spriessen/mind";
import { PAIR_RATE_PER_HOUR } from "../mailbox/policy.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-reach-"));
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const org = { kind: "org" } as const;
const teamA = { kind: "team", teamId: "team-a" } as const;
const teamB = { kind: "team", teamId: "team-b" } as const;

describe("crossHome", () => {
  it("org and any team differ; two teams differ; same home does not", () => {
    expect(crossHome(org, teamA)).toBe(true);
    expect(crossHome(teamA, teamB)).toBe(true);
    expect(crossHome(teamA, teamA)).toBe(false);
    expect(crossHome(org, org)).toBe(false);
  });
});

describe("the mailbox reach audit (wired in the entity)", () => {
  it("a cross-home send writes one reach row; a same-home send writes none", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    await handle.mind.org.ensureOrg("owner", "Personal", true);
    const a = await handle.mind.org.createTeam({ name: "Alpha" }, "owner");
    const b = await handle.mind.org.createTeam({ name: "Beta" }, "owner");
    // The first bot lives in the org (it becomes the main bot).
    await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
    const scout = await handle.mind.profiles.create("owner", {
      name: "Scout",
      onboard: false,
      teamId: a.id,
    });
    const scribe = await handle.mind.profiles.create("owner", {
      name: "Scribe",
      onboard: false,
      teamId: b.id,
    });
    const mate = await handle.mind.profiles.create("owner", {
      name: "Mate",
      onboard: false,
      teamId: a.id,
    });
    const before = handle.mind.audit.tail(100).filter((event) => event.kind === "reach").length;
    await handle.mind.mailbox.send({
      owner: "owner",
      from: scout.id,
      to: scribe.id,
      kind: "request",
      body: "hello across the aisle",
      origin: "tool",
    });
    const reach = handle.mind.audit.tail(100).filter((event) => event.kind === "reach");
    expect(reach.length).toBe(before + 1);
    expect(reach[0]?.reach).toEqual({
      from: { kind: "team", teamId: a.id },
      to: { kind: "team", teamId: b.id },
      surface: "message",
    });
    expect(reach[0]?.profile).toBe(scout.id);
    // Same home: no reach row.
    await handle.mind.mailbox.send({
      owner: "owner",
      from: scout.id,
      to: mate.id,
      kind: "request",
      body: "next desk",
      origin: "tool",
    });
    expect(handle.mind.audit.tail(100).filter((event) => event.kind === "reach").length).toBe(
      before + 1,
    );
    await handle.close();
  });

  it("cross-home delivery keeps its caps: org↔team sends hit the pair rate limit", async () => {
    // Open reach is messaging ONLY, and it changes nothing about the loop
    // and cost safety: a tool send from an org bot to a team bot (and
    // the reverse) delivers across the home boundary and counts against the
    // same per-pair rate and budgets as any other pair.
    const handle = await openMind({ storage: new MemoryStorage() });
    await handle.mind.org.ensureOrg("owner", "Personal", true);
    const team = await handle.mind.org.createTeam({ name: "Ops" }, "owner");
    // The first bot is the org bot (main); the second lives in Ops.
    const keeper = await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
    const digger = await handle.mind.profiles.create("owner", {
      name: "Digger",
      teamId: team.id,
      onboard: false,
    });
    const send = (from: string, to: string) =>
      handle.mind.mailbox.send({
        owner: "owner",
        from,
        to,
        kind: "request",
        body: "ping across homes",
        origin: "tool",
      });
    // Tool sends resolve to their entry (delivering across homes); a refused
    // one comes back as the NACK text. The pair rate still binds across homes.
    for (let index = 0; index < PAIR_RATE_PER_HOUR; index += 1) {
      const entry = (await send(keeper.id, digger.id)) as { envelope?: { from: string } };
      expect(entry.envelope?.from).toBe(keeper.id);
    }
    // The send past the pair rate is refused, across homes.
    await expect(send(keeper.id, digger.id)).rejects.toMatchObject({
      reason: expect.stringContaining("pair rate limit reached"),
    });
    // Every admitted one of these writes its reach row (org ↔ team).
    const reach = handle.mind.audit.tail(100).filter((event) => event.kind === "reach");
    expect(reach.length).toBeGreaterThanOrEqual(PAIR_RATE_PER_HOUR);
    await handle.close();
  });
});

describe("grantedCredential", () => {
  const item = {
    id: "item-1",
    name: "Shared key",
    kind: "key",
    profile: "frank",
    createdAt: 1,
  } as never;
  const binding = { adapter: "http" } as never;
  const vault = {
    get: (_owner: string, id: string) => (id === "item-1" ? item : undefined),
  } as never;
  const bindings = {
    get: (_owner: string, id: string) => (id === "item-1" ? binding : undefined),
  } as never;

  it("refuses without a grant, works with one, stops on revoke", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const converse = handle.mind.converse;
    await handle.mind.org.ensureOrg("owner", "Personal", true);
    const teamA = await handle.mind.org.createTeam({ name: "Alpha" }, "owner");
    const teamB = await handle.mind.org.createTeam({ name: "Beta" }, "owner");
    // eve lives in Alpha; the item sits with frank's bot in Beta.
    await commitProfiles(converse, () => [
      {
        id: "eve",
        owner: "owner",
        name: "Eve",
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
        teamId: teamA.id,
      } as never,
    ]);
    const lookup = grantedCredential({
      converse: () => converse,
      vault,
      bindings,
    });
    const scope = { owner: "owner", profile: "eve" };
    // No grant: the item of the other home resolves to nothing.
    expect(await lookup(scope, "Shared key")).toBeUndefined();
    // The grant (Beta's item, granted to Alpha) resolves it.
    await handle.mind.org.addGrant(
      { kind: "vault-item", id: "item-1", home: { kind: "team", teamId: teamB.id } },
      { kind: "team", teamId: teamA.id },
      "owner",
    );
    const granted = await lookup(scope, "shared key");
    expect(granted?.item).toBe(item);
    expect(granted?.binding).toBe(binding);
    // A bot of a third home gets nothing (no grant to it).
    expect(await lookup({ owner: "owner", profile: "ghost" }, "Shared key")).toBeUndefined();
    // Revoking stops it at once.
    const grants = await handle.mind.org.activeGrants();
    expect(await handle.mind.org.revokeGrant(grants[0]?.id ?? "")).toBe(true);
    expect(await lookup(scope, "Shared key")).toBeUndefined();
    await handle.close();
  });
});
