/**
 * The one permission decision: the account reaches its own rows and the
 * owner-level surfaces and the host capability; nothing else does, the
 * `agent` sentinel never acts, and an absent label is nobody.
 */
import { describe, expect, it } from "vite-plus/test";
import { can } from "./can.ts";

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

  it("open reach: shared folders and VMs are reachable across homes", () => {
    for (const actor of ["admin-x", "member-x", "viewer-x", "owner-a"]) {
      expect(
        can(
          actor,
          "view",
          { type: "shared-folder", home: { kind: "department", departmentId: "dept-y" } },
          view,
        ),
      ).toBe(true);
      expect(can(actor, "change", { type: "vm", home: { kind: "org" } }, view)).toBe(true);
    }
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
