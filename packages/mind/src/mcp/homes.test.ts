/**
 * Connectors per home, bot side (phase 4 slice 7): a connector configured in
 * home A is absent from home B's list and refuses B's call; an org connector
 * is absent for team bots, and a team connector is absent for
 * org bots. Calls stay never-auto-approved (the floors unchanged).
 * Slice 8: the vault items a bot may name for a connector are its home's
 * (plus its own profile items), and the segment → team id mapping the
 * secure-field store uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeVaultStore, type McpManager, type McpServerView } from "@spriessen/ext";
import { accessOf, visibleServers, type McpMindDeps } from "./access.ts";
import { findOwned, itemsOf, scopeOf } from "./manage-run.ts";
import { teamIdOfSegment } from "../org/model.ts";

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

/** A conversation whose bot lives in `home` (teamId null = the org). */
const depsWith = (
  views: McpServerView[],
  bot: { readonly teamId: string | null },
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
      profileOf: () => ({ id: "bot-1", teamId: bot.teamId }),
    } as unknown as McpMindDeps["profiles"],
  }) as McpMindDeps;

describe("connector visibility is per home", () => {
  const teamView = view("team-connector", "team-alpha");
  const orgView = view("org-connector", "org");
  const legacyView = view("legacy-connector", undefined);

  it("a connector configured in A is absent from B's list and refuses B's call", () => {
    const deps = depsWith([teamView, view("team-b-connector", "team-beta")], {
      teamId: "alpha",
    });
    expect(visibleServers(deps, CONV).map((entry) => entry.record.id)).toEqual(["team-connector"]);
    const refused = accessOf(deps, CONV, OWNER, "team-b-connector");
    expect(refused).toMatchObject({ ok: false, reason: "connector not found" });
    expect(accessOf(deps, CONV, OWNER, "team-connector")).toMatchObject({ ok: true });
  });

  it("an org connector is absent for team bots; a team connector is absent for org bots", () => {
    const teamBot = depsWith([orgView, teamView], { teamId: "alpha" });
    expect(visibleServers(teamBot, CONV).map((entry) => entry.record.id)).toEqual([
      "team-connector",
    ]);
    expect(accessOf(teamBot, CONV, OWNER, "org-connector")).toMatchObject({ ok: false });
    const orgBot = depsWith([orgView, teamView], { teamId: null });
    expect(visibleServers(orgBot, CONV).map((entry) => entry.record.id)).toEqual(["org-connector"]);
    expect(accessOf(orgBot, CONV, OWNER, "team-connector")).toMatchObject({
      ok: false,
      reason: "connector not found",
    });
  });

  it("legacy rows (no stored home) read as the org — existing connectors keep working", () => {
    const orgBot = depsWith([legacyView], { teamId: null });
    expect(visibleServers(orgBot, CONV).map((entry) => entry.record.id)).toEqual([
      "legacy-connector",
    ]);
    expect(accessOf(orgBot, CONV, OWNER, "legacy-connector")).toMatchObject({ ok: true });
    const teamBot = depsWith([legacyView], { teamId: "alpha" });
    expect(visibleServers(teamBot, CONV)).toEqual([]);
  });

  it("the management tools resolve scope and lookups inside the bot's home only", () => {
    const deps = {
      ...depsWith([teamView, orgView], { teamId: "alpha" }),
      secrets: {},
      vault: null,
    } as unknown as Parameters<typeof scopeOf>[0];
    const scope = scopeOf(deps, CONV);
    if (typeof scope === "string") throw new Error(scope);
    expect(scope.home).toBe("team-alpha");
    expect(scope.homeRef).toEqual({ kind: "team", teamId: "alpha" });
    expect(findOwned(deps, OWNER, "team-connector", scope.home)).toMatchObject({
      id: "team-connector",
    });
    expect(findOwned(deps, OWNER, "org-connector", scope.home)).toMatchObject(/no connector/);
    expect(findOwned(deps, OWNER, "org-connector")).toMatchObject({ id: "org-connector" });
  });
});

describe("a bot names only its home's vault items for a connector (slice 8)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const vaultWithItems = () => {
    process.env.VAULT_KEY ??= "test-vault-key";
    const root = mkdtempSync(join(tmpdir(), "spriessen-mcp-items-"));
    dirs.push(root);
    const vault = makeVaultStore(join(root, "vault"));
    const items = {
      org: vault.create(OWNER, {
        kind: "note",
        name: "Org client id",
        note: { secret: "org-client.apps.googleusercontent.com" },
      }),
      alpha: vault.create(OWNER, {
        kind: "note",
        name: "Alpha client id",
        note: { secret: "alpha-client.apps.googleusercontent.com" },
        teamId: "alpha",
      }),
      beta: vault.create(OWNER, {
        kind: "note",
        name: "Beta client id",
        note: { secret: "beta-client.apps.googleusercontent.com" },
        teamId: "beta",
      }),
      own: vault.create(OWNER, {
        kind: "note",
        name: "Bot 1's own note",
        note: { secret: "bot-one-private-note" },
        profile: "bot-1",
      }),
    };
    return { store: vault, items };
  };

  it("a team bot sees its team's items and its own, never another home's", () => {
    const { store, items } = vaultWithItems();
    const deps = {
      ...depsWith([], { teamId: "alpha" }),
      vault: store,
    } as unknown as Parameters<typeof itemsOf>[0];
    const scope = scopeOf(deps, CONV);
    if (typeof scope === "string") throw new Error(scope);
    const names = itemsOf(deps, scope).map((entry) => entry.name);
    expect(names).toContain("Alpha client id");
    expect(names).toContain("Bot 1's own note");
    expect(names).not.toContain("Org client id");
    expect(names).not.toContain("Beta client id");
    // Naming a cross-home item fails validation instead of wiring a client
    // the connector's home could never redeem.
    expect(itemsOf(deps, scope).find((entry) => entry.id === items.beta.id)).toBeUndefined();
  });

  it("an org bot sees the org's items (and its own), never a team's", () => {
    const { store } = vaultWithItems();
    const deps = {
      ...depsWith([], { teamId: null }),
      vault: store,
    } as unknown as Parameters<typeof itemsOf>[0];
    const scope = scopeOf(deps, CONV);
    if (typeof scope === "string") throw new Error(scope);
    const names = itemsOf(deps, scope).map((entry) => entry.name);
    expect(names).toContain("Org client id");
    expect(names).toContain("Bot 1's own note");
    expect(names).not.toContain("Alpha client id");
    expect(names).not.toContain("Beta client id");
  });

  it("teamIdOfSegment maps the mind's home segments to stored ids", () => {
    expect(teamIdOfSegment("team-alpha")).toBe("alpha");
    expect(teamIdOfSegment("org")).toBeUndefined();
    expect(teamIdOfSegment("team-")).toBeUndefined();
  });
});
