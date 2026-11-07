/**
 * VM size per home (phase 4 slice 4), mind side: the defaults (1 CPU /
 * 512 MiB) ride on the org and team rows and reach ext through the
 * home-scope resolver; create and edit validate the bounds in the dialog's
 * words; and the host-capacity rule refuses a set of sizes whose CONFIGURED
 * memory sums past half the host's RAM — a configured-sum heuristic over
 * stored settings, never a live host measurement (the injected
 * `hostMemoryBytes` stands in for the host).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { homeScopeOfProfile, openMind, orgService } from "@spriessen/mind";
import { DEFAULT_VM } from "@spriessen/contracts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-vm-size-"));
afterAll(() => handle?.close().then(() => rmSync(scratch, { recursive: true, force: true })));

type MindHandle = Awaited<ReturnType<typeof openMind>>;

const handle: MindHandle = await openMind({ storage: new MemoryStorage() });
const mind = handle.mind;
const owner = "owner-a";

describe("the defaults ride on the rows and reach ext", () => {
  it("a fresh org and a fresh team read the default 1 CPU / 512 MiB", async () => {
    await mind.org.ensureOrg(owner, "Personal", true);
    expect((await mind.org.view()).org?.vm).toEqual(DEFAULT_VM);
    const team = await mind.org.createTeam({ name: "Ops" }, owner);
    expect(team.vm).toEqual({ cpus: 1, memoryMiB: 512 });
  });

  it("the home-scope resolver hands each home ITS stored size to ext", async () => {
    await mind.org.updateOrg({ vm: { cpus: 2, memoryMiB: 1024 } });
    const team = await mind.org.createTeam(
      { name: "Lab", vm: { cpus: 4, memoryMiB: 2048 } },
      owner,
    );
    await mind.profiles.create(owner, { name: "Scout", onboard: false });
    await mind.profiles.create(owner, {
      name: "Digger",
      teamId: team.id,
      onboard: false,
    });
    const profiles = await mind.profiles.list(owner);
    const orgBot = profiles.find((row) => row.name === "Scout");
    const teamBot = profiles.find((row) => row.name === "Digger");
    if (orgBot === undefined || teamBot === undefined) throw new Error("bots not stored");
    const orgScope = await homeScope(orgBot);
    const teamScope = await homeScope(teamBot);
    expect(orgScope?.vm).toEqual({ cpus: 2, memoryMiB: 1024 });
    expect(teamScope?.vm).toEqual({ cpus: 4, memoryMiB: 2048 });
  });
});

describe("the bounds, in the dialog's words", () => {
  it("refuses CPUs out of 1..8 or fractional, on edit and on create", async () => {
    for (const cpus of [0, 9, 1.5]) {
      await expect(mind.org.updateOrg({ vm: { cpus, memoryMiB: 512 } })).rejects.toMatchObject({
        reason: expect.stringMatching(/VM CPUs must be a whole number from 1 to 8/),
      });
      await expect(
        mind.org.createTeam({ name: "X", vm: { cpus, memoryMiB: 512 } }, owner),
      ).rejects.toMatchObject({ reason: expect.stringMatching(/VM CPUs must be a whole number/) });
    }
  });

  it("refuses memory out of 128..8192 MiB, on edit and on create", async () => {
    for (const memoryMiB of [64, 8_193]) {
      await expect(mind.org.updateOrg({ vm: { cpus: 1, memoryMiB } })).rejects.toMatchObject({
        reason: expect.stringMatching(/VM memory \(MiB\) must be a whole number from 128 to 8192/),
      });
      await expect(
        mind.org.createTeam({ name: "X", vm: { cpus: 1, memoryMiB } }, owner),
      ).rejects.toMatchObject({
        reason: expect.stringMatching(/VM memory \(MiB\) must be a whole number/),
      });
    }
  });

  it("a team edit is bounds-checked too; sane sizes pass everywhere", async () => {
    const team = (await mind.org.view()).teams[0];
    if (team === undefined) throw new Error("no team stored");
    await expect(
      mind.org.updateTeam(team.id, { vm: { cpus: 1, memoryMiB: 65_536 } }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/from 128 to 8192/) });
    const patched = await mind.org.updateTeam(team.id, {
      vm: { cpus: 2, memoryMiB: 1024 },
    });
    expect(patched.vm).toEqual({ cpus: 2, memoryMiB: 1024 });
  });
});

describe("the host-capacity refusal (configured-sum heuristic)", () => {
  it("refuses when the homes' CONFIGURED memory sums past half the host's RAM", async () => {
    // A 2 GiB host: the budget is 1 GiB of configured VM memory.
    const org = orgService(mind.converse, { hostMemoryBytes: 2 * 1024 * 1024 * 1024 });
    // The stored state sums to 1024 + 1024 + 512 = 2560 MiB already —
    // every further change is refused with the capacity words.
    await expect(org.updateOrg({ vm: { cpus: 1, memoryMiB: 512 } })).rejects.toMatchObject({
      reason: expect.stringMatching(/ask for \d+ MiB of memory, and the host can hold 1024 MiB/),
    });
    await expect(org.createTeam({ name: "Y" }, owner)).rejects.toMatchObject({
      reason: expect.stringMatching(/half its RAM/),
    });
  });

  it("passes while the sum is within the budget, and a fresh team counts at its default", async () => {
    // A 16 GiB host: the budget is 8192 MiB — room for the stored sizes
    // (2560 MiB) plus more defaults.
    const org = orgService(mind.converse, { hostMemoryBytes: 16 * 1024 * 1024 * 1024 });
    await expect(org.createTeam({ name: "Z" }, owner)).resolves.toMatchObject({
      vm: { cpus: 1, memoryMiB: 512 },
    });
    // But the budget is finite: eight teams at the default plus the
    // org's 1024 sum to 5120; a ninth stays inside, so shrink the host
    // instead to show the refusal counting the DEFAULT of the new home.
    const tight = orgService(mind.converse, { hostMemoryBytes: 5 * 1024 * 1024 * 1024 });
    await expect(tight.createTeam({ name: "W" }, owner)).rejects.toMatchObject({
      reason: expect.stringMatching(/ask for 5120 MiB of memory, and the host can hold 2560 MiB/),
    });
  });

  it("an edit that keeps the sum inside the budget passes", async () => {
    const org = orgService(mind.converse, { hostMemoryBytes: 16 * 1024 * 1024 * 1024 });
    const team = (await mind.org.view()).teams[0];
    if (team === undefined) throw new Error("no team stored");
    await expect(
      org.updateTeam(team.id, { vm: { cpus: 1, memoryMiB: 512 } }),
    ).resolves.toMatchObject({ vm: { cpus: 1, memoryMiB: 512 } });
  });
});

/** The home scope of one profile, through the mind's resolver. */
const homeScope = (profile: { readonly id: string; readonly teamId?: string | null }) =>
  homeScopeOfProfile(mind.converse, scratch)(owner, profile);
