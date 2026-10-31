/**
 * The ONE permission decision. Every REST route, the approval decide path
 * and the host-access seam ask here instead of comparing owner labels or
 * roles themselves. The org (departments, members, roles) rides in the
 * optional `view`: the org owner passes everything, org admins pass org
 * level, a department admin passes only inside its own department — that
 * matrix grows in slice 3; this file stays the only place that compares
 * labels.
 */
import type { HomeRef } from "@spriessen/contracts";
import { AGENT_OWNER } from "@spriessen/mind";
import { OWNER_ID } from "../identity.ts";

/** What is being asked of a resource. */
export type Action = "view" | "change" | "remove" | "decide";

/**
 * What it is asked of. Bot-owned data carries the owner label its row is
 * filed under; `account` is owner-level state (audit, needs-you, sign-in
 * settings); `host` is the capability to run things on the server's own
 * machine (`bash_host`, later other host-running tools). The org kinds:
 * `org-settings` and `member` are org-level state; `department` is one
 * department's own state; `department-summary` is its read-only digest;
 * `approval` is deciding a pending card on a chat; `shared-folder` and `vm`
 * are the open-reach surfaces (every bot may reach any home's).
 */
export type Resource =
  | {
      readonly type: "bot" | "chat" | "record" | "artifact" | "file";
      readonly owner: string;
      readonly id: string;
    }
  | { readonly type: "account" }
  | { readonly type: "host" }
  | { readonly type: "org-settings" }
  | { readonly type: "member" }
  | { readonly type: "department"; readonly departmentId: string }
  | { readonly type: "department-summary"; readonly departmentId: string }
  | { readonly type: "approval"; readonly owner: string; readonly id: string }
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
  if (actor === OWNER_ID && (view === undefined || view.org === null)) return "owner";
  if (view === undefined) return actor === OWNER_ID ? "owner" : null;
  if (view.org !== null && view.org.owner === actor) return "owner";
  const role = view.members.find(
    (member) => member.accountId === actor && member.departmentId === null,
  )?.role;
  return role === "owner" ? "owner" : role === "admin" ? "admin" : null;
};

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
    case "member":
      // Host access belongs to the owner's bots for now: every bot runs under
      // the account's authority. The flags arrive in slice 11.
      return level !== null;
    case "department":
    case "department-summary":
      // Slice 3 narrows this to the department's own admins; today the org
      // level administers every department.
      return level !== null;
    case "approval":
      // Deciding a card is not reading the chat (slice 4 keeps contents
      // private); the routing matrix lands in slice 6.
      return actor === resource.owner || level !== null;
    case "shared-folder":
    case "vm":
      // Open reach: every bot reaches every home. The audit rows land with
      // the resources themselves in Phase 4.
      return true;
    default:
      return actor === resource.owner;
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
