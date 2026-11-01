/**
 * Connectors per home, bot side (phase 4 slice 7): a connector configured in
 * home A is absent from home B's list and refuses B's call; an org connector
 * is absent for department bots, and a department connector is absent for
 * org bots. Calls stay never-auto-approved (the floors unchanged).
 */
import { describe, expect, it } from "vite-plus/test";
import type { McpManager, McpServerView } from "@spriessen/ext";
import { accessOf, visibleServers, type McpMindDeps } from "./access.ts";
import { findOwned, scopeOf } from "./manage-run.ts";

const OWNER = "owner-a";
const CONV = "conv-1";

const view = (id: string, home: string | undefined): McpServerView =>
  ({
    record: {
      name: id,
      transport: "http",
      url: "https://example.test/mcp",
      command: null,
      auth: { kind: "none" },
      profiles: null,
      enabled: true,
      autoAllowReadOnly: false,
      disabledTools: [],
      id,
      owner: OWNER,
      slug: id,
      createdAt: 1,
      firstUseApproved: true,
      ...(home !== undefined ? { home } : {}),
    },
    status: {
      state: "connected",
      reason: null,
      activeTransport: "http",
      serverName: id,
      tools: [],
      hasResources: false,
    },
    tools: [],
    signedIn: false,
  }) as unknown as McpServerView;

/** A conversation whose bot lives in `home` (departmentId null = the org). */
const depsWith = (
  views: McpServerView[],
  bot: { readonly departmentId: string | null },
  profiles: Record<string, { readonly owner: string; readonly profileId: string }> = {
    [CONV]: { owner: OWNER, profileId: "bot-1" },
  },
): McpMindDeps =>
  ({
    manager: {
      views: () => views,
      view: (_owner: string, id: string) => views.find((entry) => entry.record.id === id),
      list: () => views.map((entry) => ({ ...entry.record, state: "connected", tools: [] })),
    } as unknown as McpManager,
    approvals: {} as McpMindDeps["approvals"],
    audit: {} as McpMindDeps["audit"],
    notes: { mark: () => {}, has: () => false },
    callTimeoutMs: 1_000,
    profiles: {
      scopeOf: (conversationId: string) => profiles[conversationId],
      profileOf: () => ({ id: "bot-1", departmentId: bot.departmentId }),
    } as unknown as McpMindDeps["profiles"],
  }) as McpMindDeps;

describe("connector visibility is per home", () => {
  const deptView = view("dept-connector", "dept-alpha");
  const orgView = view("org-connector", "org");
  const legacyView = view("legacy-connector", undefined);

  it("a connector configured in A is absent from B's list and refuses B's call", () => {
    const deps = depsWith([deptView, view("dept-b-connector", "dept-beta")], {
      departmentId: "alpha",
    });
    expect(visibleServers(deps, CONV).map((entry) => entry.record.id)).toEqual(["dept-connector"]);
    const refused = accessOf(deps, CONV, OWNER, "dept-b-connector");
    expect(refused).toMatchObject({ ok: false, reason: "this connector belongs to another home" });
    expect(accessOf(deps, CONV, OWNER, "dept-connector")).toMatchObject({ ok: true });
  });

  it("an org connector is absent for department bots; a department connector is absent for org bots", () => {
    const deptBot = depsWith([orgView, deptView], { departmentId: "alpha" });
    expect(visibleServers(deptBot, CONV).map((entry) => entry.record.id)).toEqual([
      "dept-connector",
    ]);
    expect(accessOf(deptBot, CONV, OWNER, "org-connector")).toMatchObject({ ok: false });
    const orgBot = depsWith([orgView, deptView], { departmentId: null });
    expect(visibleServers(orgBot, CONV).map((entry) => entry.record.id)).toEqual(["org-connector"]);
    expect(accessOf(orgBot, CONV, OWNER, "dept-connector")).toMatchObject({
      ok: false,
      reason: "this connector belongs to another home",
    });
  });

  it("legacy rows (no stored home) read as the org — existing connectors keep working", () => {
    const orgBot = depsWith([legacyView], { departmentId: null });
    expect(visibleServers(orgBot, CONV).map((entry) => entry.record.id)).toEqual([
      "legacy-connector",
    ]);
    expect(accessOf(orgBot, CONV, OWNER, "legacy-connector")).toMatchObject({ ok: true });
    const deptBot = depsWith([legacyView], { departmentId: "alpha" });
    expect(visibleServers(deptBot, CONV)).toEqual([]);
  });

  it("the management tools resolve scope and lookups inside the bot's home only", () => {
    const deps = {
      ...depsWith([deptView, orgView], { departmentId: "alpha" }),
      secrets: {},
      vault: null,
    } as unknown as Parameters<typeof scopeOf>[0];
    const scope = scopeOf(deps, CONV);
    if (typeof scope === "string") throw new Error(scope);
    expect(scope.home).toBe("dept-alpha");
    expect(findOwned(deps, OWNER, "dept-connector", scope.home)).toMatchObject({
      id: "dept-connector",
    });
    expect(findOwned(deps, OWNER, "org-connector", scope.home)).toMatchObject(/no connector/);
    expect(findOwned(deps, OWNER, "org-connector")).toMatchObject({ id: "org-connector" });
  });
});
