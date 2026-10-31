/**
 * The ONE permission decision. Every REST route, the approval decide path
 * and the host-access seam ask here instead of comparing owner labels or
 * roles themselves. The org rides in the optional `view`: the org owner
 * passes everything; org admins pass org level; a department admin passes
 * only inside its own department; a member works their department but never
 * touches roles, membership or settings; a viewer reads, never writes. This
 * file stays the only place that compares labels or roles.
 */
import type { HomeRef } from "@spriessen/contracts";
import { AGENT_OWNER } from "@spriessen/mind";
import { OWNER_ID } from "../identity.ts";

/** What is being asked of a resource. */
export type Action = "view" | "change" | "remove" | "decide";

/**
 * What it is asked of. Bot-owned data carries the owner label its row is
 * filed under and the `home` its bot lives in (absent on legacy call sites:
 * only the filing account reaches it); `account` is owner-level state
 * (audit, needs-you, sign-in settings); `host` is the capability to run
 * things on the server's own machine. Org kinds: `org-settings` and
 * `member` are org-level state; `department` is one department's own state;
 * `department-summary` its read-only digest; `approval` deciding a pending
 * card; `shared-folder` and `vm` are the open-reach surfaces (every bot may
 * reach any home's). `bot-admin` is a bot managing bots and departments
 * on its account's behalf (the main bot's admin tools).
 */
export type Resource =
  | {
      readonly type: "bot" | "record" | "artifact" | "file";
      readonly owner: string;
      readonly id: string;
      readonly home?: HomeRef;
    }
  | {
      /** A chat is private to the account that started it, whatever the roles. */
      readonly type: "chat";
      readonly owner: string;
      readonly id: string;
    }
  | { readonly type: "account" }
  | { readonly type: "host" }
  | { readonly type: "org-settings" }
  | { readonly type: "host-flag" }
  | { readonly type: "member" }
  | { readonly type: "grant"; readonly home: HomeRef }
  | { readonly type: "template"; readonly departmentId: string }
  | { readonly type: "department"; readonly departmentId: string }
  | { readonly type: "department-summary"; readonly departmentId: string }
  | {
      /** Deciding a pending card; `home` is the bot's home, for the routing. */
      readonly type: "approval";
      readonly owner: string;
      readonly id: string;
      readonly home?: HomeRef;
    }
  | {
      /** `caller` (a bot) managing bots and departments; `main` is its account's main bot. */
      readonly type: "bot-admin";
      readonly caller: string;
      readonly main: string | null;
    }
  | { readonly type: "shared-folder"; readonly home: HomeRef }
  | { readonly type: "vm"; readonly home: HomeRef };

/**
 * The org slice a decision may need: who owns the org, which members hold
 * which roles, and where each bot lives. Absent (legacy call sites, pure
 * tests), decisions fall back to the one-account reading.
 */
export interface OrgView {
  readonly org: { readonly owner: string } | null;
  readonly departments: readonly { readonly id: string }[];
  readonly members: readonly {
    readonly accountId: string;
    readonly role: string;
    readonly departmentId: string | null;
  }[];
}

/** The org-level role of `actor`: "owner", "admin", or null. */
export const orgLevelOf = (actor: string, view: OrgView | undefined): "owner" | "admin" | null => {
  if (view === undefined) return actor === OWNER_ID ? "owner" : null;
  if (view.org !== null && view.org.owner === actor) return "owner";
  const role = view.members.find(
    (member) => member.accountId === actor && member.departmentId === null,
  )?.role;
  return role === "owner" ? "owner" : role === "admin" ? "admin" : null;
};

/** The highest role `actor` holds in `departmentId` (null = org level). */
const roleAt = (
  actor: string,
  view: OrgView,
  departmentId: string | null,
): "admin" | "member" | "viewer" | null => {
  if (departmentId === null) {
    const org = orgLevelOf(actor, view);
    if (org === "owner") return "admin";
    return org === "admin" ? "admin" : null;
  }
  const role = view.members.find(
    (member) => member.accountId === actor && member.departmentId === departmentId,
  )?.role;
  return role === "admin"
    ? "admin"
    : role === "member"
      ? "member"
      : role === "viewer"
        ? "viewer"
        : null;
};

/** Write actions on bot-owned resources: everything but decide (cards route separately). */
const resourceWrites: readonly Action[] = ["view", "change", "remove"];

/**
 * Whether `actor` (a principal's owner label: the signed-in account, or a
 * service label) may `action` a `resource`. The `agent` sentinel (bot-spawned
 * task rows) is never an actor: a row filed under it must not become
 * reachable by naming it.
 */
export const can = (actor: string, action: Action, resource: Resource, view?: OrgView): boolean => {
  if (actor === "" || actor === AGENT_OWNER) return false;
  const level = orgLevelOf(actor, view);
  switch (resource.type) {
    case "account":
    case "host":
    case "org-settings":
      return level !== null;
    case "host-flag":
      // Only the org owner flips a host-access switch (slice 11, F3): a
      // department admin or member is refused like a missing item.
      return level === "owner";
    case "member":
      // Roles and membership: org owner and org admins, never a department
      // role and never a plain member.
      return level !== null;
    case "department":
    case "template":
    case "grant": {
      // A department's own state, its templates, and grants over its
      // resources: the org level, or that home's own admins (an org-home
      // grant is org level's to give).
      const deptId =
        resource.type === "department"
          ? resource.departmentId
          : resource.type === "template"
            ? resource.departmentId
            : resource.home.kind === "department"
              ? resource.home.departmentId
              : null;
      return (
        level !== null ||
        (view !== undefined && deptId !== null && roleAt(actor, view, deptId) === "admin")
      );
    }
    case "department-summary":
      // Org level, or the department's own admins; members and viewers of
      // the department get no digest (counts, bots, activity are metadata).
      return (
        level !== null ||
        (view !== undefined && roleAt(actor, view, resource.departmentId) === "admin")
      );
    case "approval": {
      // Deciding a card is not reading the chat. Routing (slice 6): the chat
      // starter, then for a department bot its department's admins and the
      // org owner; for an org bot the org owner and org admins.
      if (actor === resource.owner) return true;
      if (view === undefined) return level !== null;
      if (view.org !== null && view.org.owner === actor) return true;
      const home = resource.home;
      if (home === undefined) return false;
      const deptId = home.kind === "department" ? home.departmentId : null;
      return view.members.some(
        (member) =>
          member.accountId === actor &&
          member.role === "admin" &&
          (deptId === null ? member.departmentId === null : member.departmentId === deptId),
      );
    }
    case "chat":
      // Chat privacy: private to whoever started it, whatever the roles. The
      // org owner and org admins see summaries, never chat contents.
      return actor === resource.owner;
    case "bot-admin":
      // The main bot alone manages bots and departments, and only for an
      // account at org level; every other bot gets the same refusal.
      return level !== null && resource.caller !== "" && resource.caller === resource.main;
    case "shared-folder":
    case "vm":
      // Open reach: every bot reaches every home. The audit rows land with
      // the resources themselves in Phase 4.
      return true;
    default: {
      // Bot-owned resources: the filing account, then the role ladder.
      if (actor === resource.owner) return true;
      if (view === undefined || resource.home === undefined) return false;
      if (level !== null) return true; // org level spans departments
      const home = resource.home;
      const role =
        home.kind === "department"
          ? roleAt(actor, view, home.departmentId)
          : roleAt(actor, view, null);
      if (role === "admin") return true;
      if (role === "member") return resourceWrites.includes(action);
      if (role === "viewer") return action === "view";
      return false;
    }
  }
};

/**
 * A background task's row is visible to the account its row (or, for
 * agent-filed rows, its adopted bot) is filed under. The `agent` sentinel
 * never acts, so a caller naming it sees nothing.
 */
export const canSeeTask = (
  actor: string,
  task: {
    readonly owner: string;
    readonly bot?: { readonly owner: string; readonly profileId: string };
  },
): boolean =>
  actor !== AGENT_OWNER &&
  (task.owner === actor || (task.owner === AGENT_OWNER && task.bot?.owner === actor));
