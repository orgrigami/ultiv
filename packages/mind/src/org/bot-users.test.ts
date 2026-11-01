/**
 * Per-bot Linux users, mind side (phase 4 slice 2b): the uid ledger
 * (`ultiv.bot-uids`) allocates fixed uids from 10000 up, keeps rows forever
 * so a uid is never reused, and surfaces the bot's Linux identity through
 * the home-scope seam. The removal sweep retires the user from the home's
 * VM only when a hook is wired and the bot ever ran `bash`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { HomeRef } from "@spriessen/contracts";
import {
  botUidOf,
  botUidPeek,
  botUserName,
  botUserOf,
  homeScopeOfProfile,
  openMind,
  orgService,
} from "@spriessen/mind";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bot-users-"));
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
  await mind.profiles.create(owner, { name: "Scout", onboard: false });
  await mind.profiles.create(owner, { name: "Digger", departmentId: dept, onboard: false });
});

const profileOf = async (name: string) => {
  const row = (await mind.profiles.list(owner)).find((candidate) => candidate.name === name);
  if (row === undefined) throw new Error(`missing ${name}`);
  return row;
};

describe("the uid ledger (ultiv.bot-uids)", () => {
  it("a bot that never ran bash has no uid: nothing to provision, nothing to retire", async () => {
    const scout = await profileOf("Scout");
    expect(await botUidPeek(mind.converse)(scout.id)).toBeUndefined();
  });

  it("the first use allocates a fixed uid from 10000 up, and it never changes", async () => {
    const scout = await profileOf("Scout");
    const uid = await botUidOf(mind.converse)(scout.id);
    expect(uid).toBeGreaterThanOrEqual(10_000);
    expect(await botUidOf(mind.converse)(scout.id)).toBe(uid);
    expect(await botUidPeek(mind.converse)(scout.id)).toBe(uid);
  });

  it("a second bot gets a different uid", async () => {
    const scout = await profileOf("Scout");
    const digger = await profileOf("Digger");
    const first = await botUidOf(mind.converse)(scout.id);
    const second = await botUidOf(mind.converse)(digger.id);
    expect(second).not.toBe(first);
  });

  it("a removed bot keeps its ledger row: its uid is never handed out again", async () => {
    const doomed = await mind.profiles.create(owner, { name: "Doomed", onboard: false });
    const uid = await botUidOf(mind.converse)(doomed.id);
    await mind.profiles.remove(owner, doomed.id);
    expect(await botUidPeek(mind.converse)(doomed.id)).toBe(uid);
    const fresh = await mind.profiles.create(owner, { name: "Fresh", onboard: false });
    expect(await botUidOf(mind.converse)(fresh.id)).not.toBe(uid);
  });
});

describe("the bot's Linux identity", () => {
  it("the name is bot- plus a short stable hash: profile ids are UUIDs, not user names", () => {
    const name = botUserName("0aa2f3b6-6f5d-4c9e-9d3a-9f0b6c2d5e11");
    expect(name).toMatch(/^bot-[0-9a-f]{12}$/);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(botUserName("0aa2f3b6-6f5d-4c9e-9d3a-9f0b6c2d5e11")).toBe(name);
  });

  it("gid equals the uid; the home is the bot's own folder in the VM", async () => {
    const scout = await profileOf("Scout");
    const user = await botUserOf(mind.converse)(scratch, owner, scout.id);
    expect(user.gid).toBe(user.uid);
    expect(user.home).toBe(`/home/${scout.id}`); // a UUID id is a safe folder name
    expect(user.name).toBe(botUserName(scout.id));
  });
});

describe("the home scope carries the user to ext", () => {
  it("a bot's first use of its home VM resolves dir, gid and its own user", async () => {
    const digger = await profileOf("Digger");
    const scope = await homeScopeOfProfile(mind.converse, scratch)(owner, digger);
    expect(scope?.dir).toBe(join(scratch, owner, "_home", dept));
    expect(scope?.sharedGid).toBe(10_002);
    expect(scope?.user).toBeDefined();
    expect(scope?.user?.uid).toBe(await botUidPeek(mind.converse)(digger.id));
    // A rerun resolves the same identity — the same uid in every VM.
    const again = await homeScopeOfProfile(mind.converse, scratch)(owner, digger);
    expect(again).toEqual(scope);
  });
});

describe("the removal sweep (org service)", () => {
  it("without a wired hook there is nothing to do", async () => {
    const bare = orgService(mind.converse);
    const scout = await profileOf("Scout");
    await expect(bare.retireBotUser(owner, scout)).resolves.toBe(false);
  });

  it("the sweep gets the bot's home and id only when the bot has a uid", async () => {
    const swept: { owner: string; home: HomeRef; profileId: string }[] = [];
    const scoped = orgService(mind.converse, {
      retireBotUser: async (ofOwner, home, profileId) => {
        swept.push({ owner: ofOwner, home, profileId });
      },
    });
    const fresh = await mind.profiles.create(owner, { name: "NeverRan", onboard: false });
    await expect(scoped.retireBotUser(owner, fresh)).resolves.toBe(false);
    expect(swept).toEqual([]);
    const scout = await profileOf("Scout");
    await expect(scoped.retireBotUser(owner, scout)).resolves.toBe(true);
    expect(swept).toEqual([{ owner, home: { kind: "org" }, profileId: scout.id }]);
  });

  it("a department bot's sweep names its department home", async () => {
    const swept: HomeRef[] = [];
    const scoped = orgService(mind.converse, {
      retireBotUser: async (_owner, home) => {
        swept.push(home);
      },
    });
    const digger = await profileOf("Digger");
    await scoped.retireBotUser(owner, digger);
    expect(swept).toEqual([{ kind: "department", departmentId: dept }]);
  });
});
