/**
 * One VM per home, mind side (phase 4 slice 2): the home-scope resolver maps
 * every bot to its home's scope dir (org, or `dept-<id>`), with the home's
 * shared-folder gid; the upgrade from per-bot VMs is the mapping alone —
 * an existing org bot lands in the org VM, and a rerun changes nothing.
 * Department removal destroys the department's VM (injected destroyer); the
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
let dept = "";

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  mind = handle.mind;
  owner = "owner-a";
  await mind.org.ensureOrg(owner, "Personal", true);
  dept = (await mind.org.createDepartment({ name: "Ops" }, owner)).id;
  await mind.org.createDepartment({ name: "Lab" }, owner);
  // The bots: one org bot (as the migration leaves every existing bot), one
  // department bot. The first bot created is the main bot, so it is the org
  // one — the shape an upgraded workspace has.
  await mind.profiles.create(owner, { name: "Scout", onboard: false });
  await mind.profiles.create(owner, { name: "Digger", departmentId: dept, onboard: false });
});

describe("homeScopeDir", () => {
  it("names the org and each department's VM scope, stable and distinct", () => {
    const org = homeScopeDir(scratch, owner, { kind: "org" });
    const ops = homeScopeDir(scratch, owner, { kind: "department", departmentId: dept });
    expect(org).toBe(join(scratch, owner, "_home", "org"));
    expect(ops).toBe(join(scratch, owner, "_home", dept));
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
  });

  it("a department bot runs in its department's VM with its gid", async () => {
    const profiles = await mind.profiles.list(owner);
    const digger = profiles.find((row) => row.name === "Digger");
    const scope = await homeScopeOfProfile(mind.converse, scratch)(owner, digger as never);
    expect(scope?.dir).toBe(join(scratch, owner, "_home", dept));
    expect(scope?.sharedGid).toBe(10_001);
  });

  it("a rerun changes nothing: the mapping and gids are stable", async () => {
    const profiles = await mind.profiles.list(owner);
    const first = await homeScopeOfProfile(mind.converse, scratch)(owner, profiles[0] as never);
    const second = await homeScopeOfProfile(mind.converse, scratch)(owner, profiles[0] as never);
    expect(second).toEqual(first);
    // ensureOrg again: the org row (and its gid) is untouched.
    const again = await mind.org.ensureOrg(owner, "Personal", true);
    expect(again.sharedGid).toBe(10_000);
    const state = await readOrgState(mind.converse);
    expect(state.departments.map((row) => row.sharedGid)).toEqual([10_001, 10_002]);
  });

  it("allocated gids never repeat across departments", async () => {
    const a = await mind.org.createDepartment({ name: "Temp A" }, owner);
    const b = await mind.org.createDepartment({ name: "Temp B" }, owner);
    expect(a.sharedGid).toBeDefined();
    expect(b.sharedGid).not.toBe(a.sharedGid);
    await mind.org.removeDepartment(a.id);
    await mind.org.removeDepartment(b.id);
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
    const deptScope = await homeScopeOfProfile(mind.converse, scratch)(owner, digger as never);
    // Each bot lands in exactly its own home's VM, never another's.
    expect(orgScope?.dir).toBe(homeScopeDir(scratch, owner, { kind: "org" }));
    expect(deptScope?.dir).toBe(
      homeScopeDir(scratch, owner, { kind: "department", departmentId: dept }),
    );
    // The resolver takes the bot alone: two parameters, no target argument —
    // there is no way to name another home's VM (owner decision, 1 Nov 2026).
    const resolve = homeScopeOfProfile(mind.converse, scratch);
    expect(resolve.length).toBe(2);
  });
});

describe("department removal destroys the department's VM (injected)", () => {
  it("the destroyer gets the department home; the org VM is never passed", async () => {
    const destroyed: { owner: string; home: HomeRef }[] = [];
    // A second service over the same document, with the side effect injected.
    const scoped = orgService(mind.converse, {
      destroyHomeVm: async (ofOwner, home) => {
        destroyed.push({ owner: ofOwner, home });
      },
    });
    const temp = await scoped.createDepartment({ name: "Doomed" }, owner);
    await expect(scoped.removeDepartment(temp.id)).resolves.toBe(true);
    expect(destroyed).toEqual([{ owner, home: { kind: "department", departmentId: temp.id } }]);
  });
});
