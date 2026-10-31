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

const scratch = mkdtempSync(join(tmpdir(), "spriessen-reach-"));
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const org = { kind: "org" } as const;
const deptA = { kind: "department", departmentId: "dept-a" } as const;
const deptB = { kind: "department", departmentId: "dept-b" } as const;

describe("crossHome", () => {
  it("org and any department differ; two departments differ; same home does not", () => {
    expect(crossHome(org, deptA)).toBe(true);
    expect(crossHome(deptA, deptB)).toBe(true);
    expect(crossHome(deptA, deptA)).toBe(false);
    expect(crossHome(org, org)).toBe(false);
  });
});

describe("the mailbox reach audit (wired in the entity)", () => {
  it("a cross-home send writes one reach row; a same-home send writes none", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const converse = handle.mind.converse;
    await handle.mind.org.ensureOrg("owner", "Personal", true);
    const a = await handle.mind.org.createDepartment({ name: "Alpha" }, "owner");
    const b = await handle.mind.org.createDepartment({ name: "Beta" }, "owner");
    // The first bot lives in the org (it becomes the main bot).
    await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
    const scout = await handle.mind.profiles.create("owner", {
      name: "Scout",
      onboard: false,
      departmentId: a.id,
    });
    const scribe = await handle.mind.profiles.create("owner", {
      name: "Scribe",
      onboard: false,
      departmentId: b.id,
    });
    const mate = await handle.mind.profiles.create("owner", {
      name: "Mate",
      onboard: false,
      departmentId: a.id,
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
      from: { kind: "department", departmentId: a.id },
      to: { kind: "department", departmentId: b.id },
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
    const deptA = await handle.mind.org.createDepartment({ name: "Alpha" }, "owner");
    const deptB = await handle.mind.org.createDepartment({ name: "Beta" }, "owner");
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
        departmentId: deptA.id,
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
      { kind: "vault-item", id: "item-1", home: { kind: "department", departmentId: deptB.id } },
      { kind: "department", departmentId: deptA.id },
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
