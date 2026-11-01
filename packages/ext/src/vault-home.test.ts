/**
 * Vaults per home (phase 4 slice 6): a vault item belongs to one home — a
 * department or the org — and every bot-side read (store scope, the vault
 * tools, broker resolution) refuses a bot from another home, audited at the
 * broker. Grants (Phase 3) stay the way a NAMED item crosses homes.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AuditEvent } from "@spriessen/contracts";
import { createScopeHolder, vaultPlugin, type ScopeHolder } from "./plugins/vault.ts";
import { makeVaultStore, type VaultStore } from "./vault.ts";
import { makeBindingStore } from "./broker/bindings.ts";
import { createBrokerHooks } from "./broker/hooks.ts";
import { httpRequestTool } from "./broker/http-request-tool.ts";
import { startServer, type TestServer } from "./broker/test-servers.ts";

process.env.VAULT_KEY = "test-vault-key";

const dirs: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spriessen-vault-home-"));
  dirs.push(dir);
  return dir;
};

const ORG = { kind: "org" } as const;
const DEPT_A = { kind: "department", departmentId: "dept-a" } as const;
const DEPT_B = { kind: "department", departmentId: "dept-b" } as const;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("vault items belong to a home (store)", () => {
  it("a department item is seen by that department's bots only; an org item by org bots only", () => {
    const store = makeVaultStore(tempRoot());
    const orgItem = store.create("owner-a", {
      kind: "key",
      name: "Org key",
      key: { secret: "org-tok" },
    });
    expect(orgItem.home).toEqual(ORG);
    const deptItem = store.create("owner-a", {
      kind: "key",
      name: "Dept key",
      departmentId: "dept-a",
      key: { secret: "dept-tok" },
    });
    expect(deptItem.home).toEqual(DEPT_A);
    store.create("owner-a", {
      kind: "key",
      name: "Other key",
      departmentId: "dept-b",
      key: { secret: "other-tok" },
    });
    store.create("owner-a", {
      kind: "key",
      name: "Private",
      profile: "bot-a",
      key: { secret: "private-tok" },
    });
    // An org bot (home = org): org items plus its own profile items.
    const orgBot = store.list("owner-a", { profile: "bot-org", home: ORG });
    expect(orgBot.map((item) => item.name).sort()).toEqual(["Org key"]);
    // A department A bot: A's items, never the org's or B's.
    const deptBot = store.list("owner-a", { profile: "bot-x", home: DEPT_A });
    expect(deptBot.map((item) => item.name).sort()).toEqual(["Dept key"]);
    // A department B bot sees neither the org's nor A's item.
    expect(store.list("owner-a", { profile: "bot-y", home: DEPT_B }).map((i) => i.name)).toEqual([
      "Other key",
    ]);
    // A profile-scoped item stays visible to its profile (plus that home's
    // owner-level items)...
    expect(store.list("owner-a", { profile: "bot-a", home: DEPT_A }).map((i) => i.name)).toEqual([
      "Private",
      "Dept key",
    ]);
    // ...and invisible to a sibling bot in the same home (unchanged).
    expect(store.list("owner-a", { profile: "bot-x", home: DEPT_A }).map((i) => i.name)).toEqual([
      "Dept key",
    ]);
  });

  it("an item stored before the field existed reads as the org (the recorded decision)", () => {
    const root = tempRoot();
    const store = makeVaultStore(root);
    const item = store.create("owner-a", { kind: "key", name: "Legacy", key: { secret: "tok" } });
    const path = join(root, "owner-a", "items", `${item.id}.json`);
    const stored = JSON.parse(readFileSync(path, "utf8")) as { info: { home?: unknown } };
    delete stored.info.home;
    writeFileSync(path, JSON.stringify(stored));
    expect(store.get("owner-a", item.id)?.home).toBeUndefined();
    // Still visible to an org bot, refused to a department bot.
    expect(store.list("owner-a", { profile: "bot-o", home: ORG }).map((i) => i.name)).toEqual([
      "Legacy",
    ]);
    expect(store.list("owner-a", { profile: "bot-x", home: DEPT_A }).length).toBe(0);
  });

  it("no home in the scope keeps the pre-slice-6 behaviour (owner items visible)", () => {
    const store = makeVaultStore(tempRoot());
    store.create("owner-a", { kind: "key", name: "Shared", key: { secret: "tok" } });
    expect(store.list("owner-a", { profile: "anyone" }).map((i) => i.name)).toEqual(["Shared"]);
  });

  it("refuses an item that names both a profile and a department", () => {
    const store = makeVaultStore(tempRoot());
    let reason: string | undefined;
    try {
      store.create("owner-a", {
        kind: "key",
        name: "Both",
        profile: "bot-a",
        departmentId: "dept-a",
        key: { secret: "tok" },
      });
    } catch (cause) {
      reason = (cause as { reason?: string }).reason;
    }
    expect(reason).toMatch(/cannot also name a department/);
  });

  it("contacts are home-scoped too", () => {
    const store = makeVaultStore(tempRoot());
    store.create("owner-a", {
      kind: "contact",
      name: "Alpha lead",
      departmentId: "dept-a",
      contact: { email: "lead@a.example" },
    });
    store.create("owner-a", {
      kind: "contact",
      name: "Org contact",
      contact: { email: "org@example.com" },
    });
    expect(
      store.contacts("owner-a", { profile: "bot-x", home: DEPT_A }).map((c) => c.name),
    ).toEqual(["Alpha lead"]);
    expect(store.contacts("owner-a", { profile: "bot-o", home: ORG }).map((c) => c.name)).toEqual([
      "Org contact",
    ]);
  });
});

/** A holder for one bot of a home, for tool- and broker-level tests. */
const holderOf = (store: VaultStore, home: unknown): ScopeHolder => {
  const holder = createScopeHolder();
  holder.set({
    scopeOf: () => ({ owner: "owner-a", profile: "bot-x" }),
    homeOf: () => home as never,
  });
  return holder;
};

describe("vault tools are home-scoped", () => {
  const listAs = async (holder: ScopeHolder, store: VaultStore): Promise<string> => {
    const plugin = vaultPlugin(store, holder);
    const cap = plugin.capabilities.find((entry) => entry.kind === "tool");
    if (cap === undefined || cap.kind !== "tool") throw new Error("no vault_list tool");
    const result = await cap.tool.execute(
      {} as never,
      { conversationId: "c1" } as never,
      {} as never,
    );
    return (result.output?.[0] as { text: string } | undefined)?.text ?? "";
  };

  it("vault_list shows a department bot its home's items, never the org's", async () => {
    const store = makeVaultStore(tempRoot());
    store.create("owner-a", { kind: "key", name: "Org key", key: { secret: "o" } });
    store.create("owner-a", {
      kind: "key",
      name: "Dept key",
      departmentId: "dept-a",
      key: { secret: "d" },
    });
    const listed = await listAs(holderOf(store, DEPT_A), store);
    expect(JSON.parse(listed).map((item: { name: string }) => item.name)).toEqual(["Dept key"]);
    const orgListed = await listAs(holderOf(store, ORG), store);
    expect(JSON.parse(orgListed).map((item: { name: string }) => item.name)).toEqual(["Org key"]);
  });
});

describe("the broker refuses another home's credential, audited; a granted item works", () => {
  interface Rig {
    readonly server: TestServer;
    readonly audits: AuditEvent[];
    readonly run: (args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
    readonly store: VaultStore;
    readonly holder: ScopeHolder;
  }

  const setUp = async (home: unknown): Promise<Rig> => {
    const root = tempRoot();
    const server = await startServer((_seen, res) => {
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    const store = makeVaultStore(join(root, "vault"));
    const bindings = makeBindingStore(join(root, "vault"));
    const holder = holderOf(store, home);
    const audits: AuditEvent[] = [];
    const hooks = createBrokerHooks();
    hooks.set({
      confirm: async () => true,
      noteFor: () => undefined,
      audit: (event) => audits.push(event),
    });
    const tool = httpRequestTool({ vault: store, bindings, holder, hooks });
    return {
      server,
      audits,
      store,
      holder,
      run: async (args) => {
        const result = await tool.execute(
          args as never,
          { conversationId: "c1", callId: "call-1" } as never,
          {} as never,
        );
        return {
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
          text: (result.output?.[0] as { text: string } | undefined)?.text ?? "",
        };
      },
    };
  };

  it("an org bot's read of a department secret fails and writes an audit row", async () => {
    const rigA = await setUp(ORG);
    try {
      const item = rigA.store.create("owner-a", {
        kind: "key",
        name: "Dept secret",
        departmentId: "dept-a",
        key: { secret: "«secret-dept»" },
      });
      const refused = await rigA.run({
        method: "GET",
        url: `http://127.0.0.1:${rigA.server.port}/x`,
        credential: "Dept secret",
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/no credential/);
      const row = rigA.audits.find((event) => event.ok === false);
      expect(row).toMatchObject({
        kind: "credential",
        ok: false,
        credential: { item: "Dept secret", method: "GET", status: null },
      });
      expect(JSON.stringify(rigA.audits)).not.toContain("«secret-dept»");
      expect(item.name).toBe("Dept secret");
    } finally {
      await rigA.server.close();
    }
  });

  it("a department bot's read of an org secret (and the reverse home) fails, audited", async () => {
    const rigB = await setUp(DEPT_B);
    try {
      rigB.store.create("owner-a", {
        kind: "key",
        name: "Org secret",
        key: { secret: "«secret-org»" },
      });
      const refused = await rigB.run({
        method: "GET",
        url: `http://127.0.0.1:${rigB.server.port}/x`,
        credential: "Org secret",
      });
      expect(refused.isError).toBe(true);
      expect(rigB.audits.some((event) => event.ok === false && event.kind === "credential")).toBe(
        true,
      );
      expect(JSON.stringify(rigB.audits)).not.toContain("«secret-org»");
    } finally {
      await rigB.server.close();
    }
  });
});
