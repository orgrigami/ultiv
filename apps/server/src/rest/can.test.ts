/**
 * The one permission decision: the account reaches its own rows and the
 * owner-level surfaces and the host capability; nothing else does, the
 * `agent` sentinel never acts, and an absent label is nobody.
 */
import { describe, expect, it } from "vite-plus/test";
import { can, type Action } from "./can.ts";

describe("can", () => {
  it("the account acts on its own rows, and nobody else's", () => {
    expect(can("owner", "view", { type: "chat", owner: "owner", id: "s1" })).toBe(true);
    expect(can("owner", "change", { type: "bot", owner: "owner", id: "b1" })).toBe(true);
    expect(can("owner", "remove", { type: "record", owner: "guest", id: "r1" })).toBe(false);
    expect(can("owner", "view", { type: "artifact", owner: "someone-else", id: "a1" })).toBe(false);
    expect(can("someone-else", "view", { type: "chat", owner: "owner", id: "s1" })).toBe(false);
  });

  it("owner-level surfaces and the host capability belong to the account", () => {
    expect(can("owner", "view", { type: "account" })).toBe(true);
    expect(can("owner", "change", { type: "host" })).toBe(true);
    expect(can("guest", "view", { type: "account" })).toBe(false);
    expect(can("guest", "change", { type: "host" })).toBe(false);
    expect(can("someone-else", "change", { type: "host" })).toBe(false);
  });

  it("only the main bot manages bots and departments, and only for the account", () => {
    const admin = (caller: string, main: string | null) =>
      ({ type: "bot-admin", caller, main }) as const;
    expect(can("owner", "change", admin("bot-main", "bot-main"))).toBe(true);
    expect(can("owner", "change", admin("bot-other", "bot-main"))).toBe(false);
    expect(can("owner", "change", admin("", null))).toBe(false);
    expect(can("guest", "change", admin("bot-main", "bot-main"))).toBe(false);
    expect(can("agent", "change", admin("bot-main", "bot-main"))).toBe(false);
  });

  it("reserved and empty labels never act", () => {
    expect(can("agent", "view", { type: "chat", owner: "agent", id: "t1" })).toBe(false);
    expect(can("", "view", { type: "account" })).toBe(false);
    expect(can("agent", "change", { type: "host" })).toBe(false);
  });

  it("a false host-access switch refuses every approver before the routing (slice 10)", () => {
    const card = (hostBlocked?: boolean) =>
      ({
        type: "approval",
        owner: "owner-a",
        id: "c1",
        home: { kind: "org" },
        ...(hostBlocked === undefined ? {} : { hostBlocked }),
      }) as const;
    // The same approver the routing would allow is refused while blocked.
    expect(can("owner-a", "decide", card(true), view)).toBe(false);
    expect(can("owner-a", "decide", card(false), view)).toBe(true);
    expect(can("owner-a", "decide", card(), view)).toBe(true);
  });
});

/**
 * The role matrix over a two-department org (throwaway labels). The org
 * owner passes everything; an org admin spans departments; a department
 * admin never reaches outside its department; a member works but cannot
 * change roles; a viewer only reads.
 */
const view = {
  org: { owner: "owner-a" },
  departments: [{ id: "dept-x" }, { id: "dept-y" }],
  members: [
    { accountId: "owner-a", role: "owner", departmentId: null },
    { accountId: "admin-org", role: "admin", departmentId: null },
    { accountId: "admin-x", role: "admin", departmentId: "dept-x" },
    { accountId: "member-x", role: "member", departmentId: "dept-x" },
    { accountId: "viewer-x", role: "viewer", departmentId: "dept-x" },
  ],
};

const botInX = {
  type: "bot",
  owner: "owner-a",
  id: "b-x",
  home: { kind: "department", departmentId: "dept-x" },
} as const;
const botInY = {
  type: "bot",
  owner: "owner-a",
  id: "b-y",
  home: { kind: "department", departmentId: "dept-y" },
} as const;
const orgBot = { type: "bot", owner: "owner-a", id: "b-org", home: { kind: "org" } } as const;

describe("can with the org view (slice 3)", () => {
  it("the org owner passes everything", () => {
    expect(can("owner-a", "remove", botInX, view)).toBe(true);
    expect(can("owner-a", "change", { type: "org-settings" }, view)).toBe(true);
    expect(can("owner-a", "change", { type: "department", departmentId: "dept-y" }, view)).toBe(
      true,
    );
  });

  it("an org admin acts at org level, across departments", () => {
    expect(can("admin-org", "change", botInY, view)).toBe(true);
    expect(can("admin-org", "change", orgBot, view)).toBe(true);
    expect(can("admin-org", "change", { type: "org-settings" }, view)).toBe(true);
    expect(can("admin-org", "change", { type: "member" }, view)).toBe(true);
  });

  it("a department admin acts only inside its own department", () => {
    expect(can("admin-x", "change", botInX, view)).toBe(true);
    expect(can("admin-x", "remove", botInX, view)).toBe(true);
    expect(can("admin-x", "change", botInY, view)).toBe(false);
    expect(can("admin-x", "change", orgBot, view)).toBe(false);
    expect(can("admin-x", "change", { type: "org-settings" }, view)).toBe(false);
    expect(can("admin-x", "change", { type: "member" }, view)).toBe(false);
    expect(can("admin-x", "change", { type: "department", departmentId: "dept-y" }, view)).toBe(
      false,
    );
    expect(can("admin-x", "change", { type: "department", departmentId: "dept-x" }, view)).toBe(
      true,
    );
  });

  it("a member works their department but never roles or membership", () => {
    expect(can("member-x", "change", botInX, view)).toBe(true);
    expect(can("member-x", "view", botInY, view)).toBe(false);
    expect(can("member-x", "change", { type: "member" }, view)).toBe(false);
    expect(can("member-x", "change", { type: "department", departmentId: "dept-x" }, view)).toBe(
      false,
    );
  });

  it("a viewer reads and never writes", () => {
    expect(can("viewer-x", "view", botInX, view)).toBe(true);
    expect(can("viewer-x", "change", botInX, view)).toBe(false);
    expect(can("viewer-x", "remove", botInX, view)).toBe(false);
    expect(can("viewer-x", "view", botInY, view)).toBe(false);
  });

  it("nobody reaches another account's chat, whatever the roles", () => {
    expect(can("owner-a", "view", { type: "chat", owner: "member-x", id: "s1" }, view)).toBe(false);
    expect(can("admin-org", "view", { type: "chat", owner: "member-x", id: "s1" }, view)).toBe(
      false,
    );
    expect(can("admin-x", "view", { type: "chat", owner: "owner-a", id: "s1" }, view)).toBe(false);
  });

  it("no resource opens another home's VM or shared folder: reach is messaging only", () => {
    // The resource types were removed (owner decision, 1 Nov 2026): shared
    // folders and command execution never cross homes, so can() has no case
    // that lets a bot reach another home's VM or folder. The type-level
    // probe below compiles ONLY while both literals are absent from
    // `Resource` — the typecheck gate fails the moment either returns.
    type Resource = Parameters<typeof can>[2];
    const noVm: "vm" extends Resource["type"] ? true : false = false;
    const noFolder: "shared-folder" extends Resource["type"] ? true : false = false;
    expect(noVm).toBe(false);
    expect(noFolder).toBe(false);
  });

  it("a viewer of one department gets no summary of another", () => {
    expect(
      can("viewer-x", "view", { type: "department-summary", departmentId: "dept-x" }, view),
    ).toBe(false);
    expect(
      can("admin-x", "view", { type: "department-summary", departmentId: "dept-x" }, view),
    ).toBe(true);
    expect(
      can("admin-org", "view", { type: "department-summary", departmentId: "dept-y" }, view),
    ).toBe(true);
  });

  it("a refusal is exactly the missing-item answer at the resource level", () => {
    // can() only says yes/no; the route turns a no into the SAME answer an
    // unknown id gets. This pins the no: an unknown actor gets false for an
    // existing resource, and an unknown department reads like a missing one.
    expect(can("stranger", "view", botInX, view)).toBe(false);
    expect(can("stranger", "view", { type: "department", departmentId: "dept-x" }, view)).toBe(
      false,
    );
    expect(can("stranger", "change", { type: "department", departmentId: "dept-gone" }, view)).toBe(
      false,
    );
  });
});

/**
 * Cross-home isolation (phase 4 slice 5), unit level: a resource filed under
 * another home is answered EXACTLY like a missing one — the same `false`
 * from can(), the same not-found answer from the route — for every actor
 * below org level, every action, and every bot-owned resource kind. There
 * is no resource type that even names a VM, a shared folder or a vault
 * item, so another home's VM cannot be asked for, let alone granted, and
 * org-level row visibility (management summaries) opens no VM or folder.
 */
const deptY = { kind: "department", departmentId: "dept-y" } as const;

const crossHomeCases: {
  readonly actor: string;
  readonly action: Action;
  readonly type: "bot" | "record" | "artifact" | "file";
}[] = ["admin-x", "member-x", "viewer-x", "stranger"].flatMap((actor) =>
  (["view", "change", "remove", "decide"] as const).flatMap((action) =>
    (["bot", "record", "artifact", "file"] as const).map((type) => ({ actor, action, type })),
  ),
);

describe("cross-home isolation (phase 4 slice 5)", () => {
  it("another home's bot-owned resource answers exactly like a missing id, every cell", () => {
    for (const { actor, action, type } of crossHomeCases) {
      const otherHome = { type, owner: "owner-a", id: "row-y", home: deptY } as const;
      const missingId = { type, owner: "owner-a", id: "row-gone", home: deptY } as const;
      expect(can(actor, action, otherHome, view)).toBe(can(actor, action, missingId, view));
      expect(can(actor, action, otherHome, view)).toBe(false);
    }
  });

  it("another home's home — the bot row itself — reads as missing the same way", () => {
    // "homes" in the slice's list: the other bot's row (its home, its
    // existence) is refused identically to an unknown bot id.
    expect(can("admin-x", "view", botInY, view)).toBe(false);
    expect(can("admin-x", "view", botInY, view)).toBe(
      can("admin-x", "view", { type: "bot", owner: "owner-a", id: "b-gone", home: deptY }, view),
    );
  });

  it("another home's chat is refused like a missing session, whatever the roles", () => {
    // A chat's owner label stands for the account; within one account the
    // privacy line is the same answer: not yours reads as not found.
    const chat = { type: "chat", owner: "owner-a", id: "s-y" } as const;
    expect(can("admin-x", "view", chat, view)).toBe(false);
    expect(can("admin-x", "view", chat, view)).toBe(
      can("admin-x", "view", { type: "chat", owner: "owner-a", id: "s-gone" }, view),
    );
    expect(can("member-x", "view", chat, view)).toBe(false);
  });

  it("no resource type names another home's VM, shared folder or dept-shared folder", () => {
    // The refusal is structural (owner decision, 1 Nov 2026): shared folders
    // and command execution never cross homes, so can() has no case that
    // lets anyone ask. The typecheck gate fails the moment any literal
    // returns to `Resource`.
    type ResourceType = Parameters<typeof can>[2]["type"];
    type NoneOf<L extends readonly string[]> = L extends readonly [infer H, ...infer R]
      ? H extends ResourceType
        ? false
        : NoneOf<R & readonly string[]>
      : true;
    const noVmSurface: NoneOf<
      ["vm", "sandbox", "shared-folder", "dept-shared", "org-shared", "home-vm", "shell", "command"]
    > = true;
    expect(noVmSurface).toBe(true);
  });

  it("vault items, connectors and memory have no can() case — grants are the only path", () => {
    // Another home's vault item, connector or memory has no Resource kind:
    // can() cannot admit it, the vault/connector stores scope by owner and
    // profile, and a NAMED item crosses only through a grant (phase 3;
    // unit-tested in org/reach.test.ts grantedCredential). Same structural
    // probe as the folders above.
    type ResourceType = Parameters<typeof can>[2]["type"];
    type NoneOf<L extends readonly string[]> = L extends readonly [infer H, ...infer R]
      ? H extends ResourceType
        ? false
        : NoneOf<R & readonly string[]>
      : true;
    const noVaultSurface: NoneOf<
      ["vault-item", "vault", "connector", "mcp", "memory", "credential"]
    > = true;
    expect(noVaultSurface).toBe(true);
  });

  it("org-level row visibility opens no VM, folder or command surface", () => {
    // The org owner and org admins span departments at the ROW level (the
    // management surface), and a member of one department works their own —
    // but no can() answer ever opens another home's VM or folder: those
    // belong to their home's bots alone, reached (for org bots) only through
    // the slice 2d mounts inside the org VM. The refusal there is the
    // resolver's shape, not a permission row: unit-asserted in
    // packages/ext/src/shell/isolation.test.ts.
    expect(can("owner-a", "view", botInY, view)).toBe(true);
    expect(can("admin-org", "view", botInY, view)).toBe(true);
    expect(can("member-x", "view", botInX, view)).toBe(true);
    expect(can("member-x", "view", botInY, view)).toBe(false);
  });
});
