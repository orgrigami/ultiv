/**
 * The ONE permission decision. Every REST route, the approval decide path
 * and the host-access seam ask here instead of comparing owner labels
 * themselves. Phase 2 has one account, so the model is simple; phase 3
 * attaches roles to it, and phase 4 adds per-department conditions to the
 * host capability. Keep this file the only place that compares labels.
 */
import { AGENT_OWNER } from "@spriessen/mind";
import { OWNER_ID } from "../identity.ts";

/** What is being asked of a resource. */
export type Action = "view" | "change" | "remove" | "decide";

/**
 * What it is asked of. Bot-owned data carries the owner label its row is
 * filed under; `account` is owner-level state (audit, needs-you, sign-in
 * settings); `host` is the capability to run things on the server's own
 * machine (`bash_host`, later other host-running tools).
 */
export type Resource =
  | {
      readonly type: "bot" | "chat" | "record" | "artifact" | "file";
      readonly owner: string;
      readonly id: string;
    }
  | { readonly type: "account" }
  | { readonly type: "host" };

/**
 * Whether `actor` (a principal's owner label: the signed-in account, or a
 * service label) may `action` a `resource`. The `agent` sentinel (bot-spawned
 * task rows) is never an actor: a row filed under it must not become
 * reachable by naming it.
 */
export const can = (actor: string, action: Action, resource: Resource): boolean => {
  if (actor === "" || actor === AGENT_OWNER) return false;
  switch (resource.type) {
    case "account":
    case "host":
      // Host access belongs to the owner's bots for now: every bot runs under
      // the account's authority. Phases 3 and 4 add the switches.
      return actor === OWNER_ID;
    default:
      return actor === resource.owner;
  }
};
