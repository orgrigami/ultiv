/**
 * One VM per home, mind side (phase 4 slice 2): the home-scope resolver maps
 * every bot to its home's scope dir (org, or `team-<id>`), with the home's
 * shared-folder gid; the upgrade from per-bot VMs is the mapping alone —
 * an existing org bot lands in the org VM, and a rerun changes nothing.
 * Team removal destroys the team's VM (injected destroyer); the
 * org VM is never destroyed here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { sandboxNameOf } from "@spriessen/ext";
import type { HomeRef } from "@spriessen/contracts";
import {
  botUserName,
  homeScopeDir,
  homeScopeOfProfile,
  openMind,
  orgService,
  readOrgState,
} from "@spriessen/mind";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-home-scope-"));
afterAll(() => handle?.close().then(() => rmSync(scratch, { recursive: true, force: true })));

type MindHandle = Awaited<ReturnType<typeof openMind>>;

let handle: MindHandle;
let mind: MindHandle["mind"];
let owner: string;
let team = "";
let teamLab = "";

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  mind = handle.mind;
  owner = "owner-a";
  await mind.org.ensureOrg(owner, "Personal", true);
  team = (await mind.org.createTeam({ name: "Ops" }, owner)).id;
  teamLab = (await mind.org.createTeam({ name: "Lab" }, owner)).id;
  // The bots: one org bot (as the migration leaves every existing bot), one
  // team bot. The first bot created is the main bot, so it is the org
  // one — the shape an upgraded workspace has.
  await mind.profiles.create(owner, { name: "Scout", onboard: false });
  await mind.profiles.create(owner, { name: "Digger", teamId: team, onboard: false });
});

describe("homeScopeDir", () => {
  it("names the org and each team's VM scope, stable and distinct", () => {
    const org = homeScopeDir(scratch, owner, { kind: "org" });
    const ops = homeScopeDir(scratch, owner, { kind: "team", teamId: team });
    expect(org).toBe(join(scratch, owner, "_home", "org"));
    expect(ops).toBe(join(scratch, owner, "_home", team));
    expect(sandboxNameOf(org)).not.toBe(sandboxNameOf(ops));
    expect(sandboxNameOf(org).startsWith("ultiv-")).toBe(true);
  });
});

describe("homeScopeOfProfile (the upgrade from per-bot VMs)", () => {
  it("an existing org bot runs in the org VM with the org's shared gid", async () => {
    const profiles = await mind.profiles.list(owner);
    const scout = profiles.find((row) => row.name === "Scout");
    expect(scout).toBeDefined();
    const scope = await homeScopeOfProfile(mind.converse, scratch)(owner, scout as never);
    expect(scope?.dir).toBe(join(scratch, owner, "_home", "org"));
    expect(scope?.sharedGid).toBe(10_000);
    // The org-wide folder (slice 2c): read-write in the org VM, its own gid.
    expect(scope?.orgShared).toEqual({
      hostDir: join(scratch, owner, "_shared", "org"),
      gid: 10_001,
      readOnly: false,
    });
  });

  it("a team bot runs in its team's VM with its gid", async () => {
    const profiles = await mind.profiles.list(owner);
    const digger = profiles.find((row) => row.name === "Digger");
    const scope = await homeScopeOfProfile(mind.converse, scratch)(owner, digger as never);
    expect(scope?.dir).toBe(join(scratch, owner, "_home", team));
    expect(scope?.sharedGid).toBe(10_002);
    // The org-wide folder is mounted READ-ONLY in a team VM, with the
    // same store and org gid as everywhere else (slice 2c).
    expect(scope?.orgShared).toEqual({
      hostDir: join(scratch, owner, "_shared", "org"),
      gid: 10_001,
      readOnly: true,
    });
  });

  it("a rerun changes nothing: the mapping and gids are stable", async () => {
    const profiles = await mind.profiles.list(owner);
    const first = await homeScopeOfProfile(mind.converse, scratch)(owner, profiles[0] as never);
    const second = await homeScopeOfProfile(mind.converse, scratch)(owner, profiles[0] as never);
    expect(second).toEqual(first);
    // ensureOrg again: the org row (and its gids) is untouched.
    const again = await mind.org.ensureOrg(owner, "Personal", true);
    expect(again.sharedGid).toBe(10_000);
    expect(again.orgSharedGid).toBe(10_001);
    const state = await readOrgState(mind.converse);
    expect(state.teams.map((row) => row.sharedGid)).toEqual([10_002, 10_003]);
  });

  it("allocated gids never repeat across teams (the org gid is skipped)", async () => {
    const a = await mind.org.createTeam({ name: "Temp A" }, owner);
    const b = await mind.org.createTeam({ name: "Temp B" }, owner);
    expect(a.sharedGid).toBeDefined();
    expect(b.sharedGid).not.toBe(a.sharedGid);
    // No team ever gets the org-wide folder's gid (slice 2c).
    expect(a.sharedGid).not.toBe(10_001);
    expect(b.sharedGid).not.toBe(10_001);
    await mind.org.removeTeam(a.id);
    await mind.org.removeTeam(b.id);
  });

  it("the org's size cap reads by default and the owner can change it", async () => {
    const state = await readOrgState(mind.converse);
    expect(state.org?.orgSharedCapBytes).toBe(1_073_741_824);
    const patched = await mind.org.updateOrg({ orgSharedCapBytes: 2_147_483_648 });
    expect(patched.orgSharedCapBytes).toBe(2_147_483_648);
    await expect(mind.org.updateOrg({ orgSharedCapBytes: 999 })).rejects.toThrow();
    await mind.org.updateOrg({ orgSharedCapBytes: 1_073_741_824 });
  });

  it("caps reach ext: org-shared and every store in the org VM, the own store in a team VM", async () => {
    await mind.org.updateTeam(team, { sharedCapBytes: 5_242_880 });
    await expect(mind.org.updateTeam(team, { sharedCapBytes: 10 })).rejects.toThrow();
    const profiles = await mind.profiles.list(owner);
    const orgBot = profiles.find((row) => row.teamId == null);
    const teamBot = profiles.find((row) => row.teamId === team);
    expect(orgBot).toBeDefined();
    expect(teamBot).toBeDefined();
    const orgScope = await homeScopeOfProfile(mind.converse, scratch)(owner, orgBot as never);
    const teamScope = await homeScopeOfProfile(mind.converse, scratch)(owner, teamBot as never);
    expect(orgScope?.caps?.orgShared).toBe(1_073_741_824);
    expect(orgScope?.caps?.team?.[team]).toBe(5_242_880);
    expect(orgScope?.caps?.shared).toBeUndefined();
    expect(teamScope?.caps?.shared).toBe(5_242_880);
    expect(teamScope?.caps?.team).toBeUndefined();
  });
});

describe("bash stays in the bot's own home VM (reach is messaging only)", () => {
  it("the resolver maps a bot to its home and nothing else — no target to name another VM", async () => {
    const profiles = await mind.profiles.list(owner);
    const scout = profiles.find((row) => row.name === "Scout");
    const digger = profiles.find((row) => row.name === "Digger");
    expect(scout).toBeDefined();
    expect(digger).toBeDefined();
    const orgScope = await homeScopeOfProfile(mind.converse, scratch)(owner, scout as never);
    const teamScope = await homeScopeOfProfile(mind.converse, scratch)(owner, digger as never);
    // Each bot lands in exactly its own home's VM, never another's.
    expect(orgScope?.dir).toBe(homeScopeDir(scratch, owner, { kind: "org" }));
    expect(teamScope?.dir).toBe(homeScopeDir(scratch, owner, { kind: "team", teamId: team }));
    // The resolver takes the bot alone: two parameters, no target argument —
    // there is no way to name another home's VM (owner decision, 1 Nov 2026).
    const resolve = homeScopeOfProfile(mind.converse, scratch);
    expect(resolve.length).toBe(2);
  });
});

describe("team shared folders in the org VM (slice 2d)", () => {
  it("an org bot's scope carries the parent mount, every team's group, and org-bot users", async () => {
    const profiles = await mind.profiles.list(owner);
    const scout = profiles.find((row) => row.name === "Scout");
    expect(scout).toBeDefined();
    const scope = await homeScopeOfProfile(mind.converse, scratch)(owner, scout as never);
    expect(scope?.teamShared?.parentDir).toBe(join(scratch, owner, "_team"));
    expect(scope?.teamShared?.teams).toEqual([
      { id: team, gid: 10_002 },
      { id: teamLab, gid: 10_003 },
    ]);
    // Only org bots that already have a user are reconciled — never
    // pre-created, a user appears at its bot's first use.
    expect(scope?.teamShared?.users).toContain(botUserName(scout?.id as string));
    // A team bot gets its own store, not the org VM's parent mount.
    const digger = profiles.find((row) => row.name === "Digger");
    const teamScope = await homeScopeOfProfile(mind.converse, scratch)(owner, digger as never);
    expect(teamScope?.sharedStore).toBe(join(scratch, owner, "_team", team));
    expect(teamScope?.teamShared).toBeUndefined();
  });

  it("a team create fires the reconcile with its gid; a delete removes store and group", async () => {
    const reconciled: string[] = [];
    const deleted: string[] = [];
    const scoped = orgService(mind.converse, {
      reconcileTeamGroups: async (ofOwner, script) => {
        reconciled.push(`${ofOwner}:${script}`);
      },
      deleteTeamStore: async (ofOwner, teamId) => {
        deleted.push(`${ofOwner}:${teamId}`);
      },
    });
    const temp = await scoped.createTeam({ name: "Temp C" }, owner);
    expect(reconciled.length).toBe(1);
    expect(reconciled[0]).toContain(`groupadd -g ${temp.sharedGid} ultiv-d${temp.sharedGid}`);
    await scoped.removeTeam(temp.id);
    expect(deleted).toEqual([`${owner}:${temp.id}`]);
    // The deleted team's group is no longer in the reconcile set.
    expect(reconciled[1]).not.toContain(`ultiv-d${temp.sharedGid}`);
  });
});

describe("team removal destroys the team's VM (injected)", () => {
  it("the destroyer gets the team home; the org VM is never passed", async () => {
    const destroyed: { owner: string; home: HomeRef }[] = [];
    // A second service over the same document, with the side effect injected.
    const scoped = orgService(mind.converse, {
      destroyHomeVm: async (ofOwner, home) => {
        destroyed.push({ owner: ofOwner, home });
      },
    });
    const temp = await scoped.createTeam({ name: "Doomed" }, owner);
    await expect(scoped.removeTeam(temp.id)).resolves.toBe(true);
    expect(destroyed).toEqual([{ owner, home: { kind: "team", teamId: temp.id } }]);
  });
});
