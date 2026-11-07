/**
 * The ONE permission decision. Every REST route, the approval decide path
 * and the host-access seam ask here instead of comparing owner labels or
 * roles themselves. The org rides in the optional `view`: the org owner
 * passes everything; org admins pass org level; a team admin passes
 * only inside its own team; a member works their team but never
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
 * `member` are org-level state; `team` is one team's own state;
 * `team-summary` its read-only digest; `approval` deciding a pending
 * card. Reach is MESSAGING ONLY (owner decision, 1 Nov 2026): no resource
 * here opens another home's VM or shared folder — those belong to their
 * home's own bots alone, and cross-home messaging is audited in the mind
 * (`org/reach.ts`), not gated here. `bot-admin` is a bot managing bots and
 * teams on its account's behalf (the main bot's admin tools).
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
  | { readonly type: "template"; readonly teamId: string }
  | { readonly type: "team"; readonly teamId: string }
  | { readonly type: "team-summary"; readonly teamId: string }
  | {
      /** Deciding a pending card; `home` is the bot's home, for the routing. */
      readonly type: "approval";
      readonly owner: string;
      readonly id: string;
      readonly home?: HomeRef;
      /**
       * The bot's host-access switch went false while the card was parked
       * (slice 10): the switch is checked FIRST, so every approver is
       * refused like the item is missing — the approval rules never run.
       */
      readonly hostBlocked?: boolean;
    }
  | {
      /** A bot (`caller`) managing bots and teams; `main` is its account's main bot. */
      readonly type: "bot-admin";
      readonly caller: string;
      readonly main: string | null;
    };

/**
 * The org slice a decision may need: who owns the org, which members hold
 * which roles, and where each bot lives. Absent (legacy call sites, pure
 * tests), decisions fall back to the one-account reading.
 */
export interface OrgView {
  readonly org: { readonly owner: string } | null;
  readonly teams: readonly { readonly id: string }[];
  readonly members: readonly {
    readonly accountId: string;
    readonly role: string;
    readonly teamId: string | null;
  }[];
}

/** The org-level role of `actor`: "owner", "admin", or null. */
export const orgLevelOf = (actor: string, view: OrgView | undefined): "owner" | "admin" | null => {
  if (view === undefined) return actor === OWNER_ID ? "owner" : null;
  if (view.org !== null && view.org.owner === actor) return "owner";
  const role = view.members.find(
    (member) => member.accountId === actor && member.teamId === null,
  )?.role;
  return role === "owner" ? "owner" : role === "admin" ? "admin" : null;
};

/** The highest role `actor` holds in `teamId` (null = org level). */
const roleAt = (
  actor: string,
  view: OrgView,
  teamId: string | null,
): "admin" | "member" | "viewer" | null => {
  if (teamId === null) {
    const org = orgLevelOf(actor, view);
    if (org === "owner") return "admin";
    return org === "admin" ? "admin" : null;
  }
  const role = view.members.find(
    (member) => member.accountId === actor && member.teamId === teamId,
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
      // team admin or member is refused like a missing item.
      return level === "owner";
    case "member":
      // Roles and membership: org owner and org admins, never a team
      // role and never a plain member.
      return level !== null;
    case "team":
    case "template":
    case "grant": {
      // A team's own state, its templates, and grants over its
      // resources: the org level, or that home's own admins (an org-home
      // grant is org level's to give).
      const teamId =
        resource.type === "team"
          ? resource.teamId
          : resource.type === "template"
            ? resource.teamId
            : resource.home.kind === "team"
              ? resource.home.teamId
              : null;
      return (
        level !== null ||
        (view !== undefined && teamId !== null && roleAt(actor, view, teamId) === "admin")
      );
    }
    case "team-summary":
      // Org level, or the team's own admins; members and viewers of
      // the team get no digest (counts, bots, activity are metadata).
      return (
        level !== null || (view !== undefined && roleAt(actor, view, resource.teamId) === "admin")
      );
    case "approval": {
      // The host-access switch decides first (slice 10): a false switch
      // refuses every approver, before the routing rules below.
      if (resource.hostBlocked === true) return false;
      // Deciding a card is not reading the chat. Routing (slice 6): the chat
      // starter, then for a team bot its team's admins and the
      // org owner; for an org bot the org owner and org admins.
      if (actor === resource.owner) return true;
      if (view === undefined) return level !== null;
      if (view.org !== null && view.org.owner === actor) return true;
      const home = resource.home;
      if (home === undefined) return false;
      const teamId = home.kind === "team" ? home.teamId : null;
      return view.members.some(
        (member) =>
          member.accountId === actor &&
          member.role === "admin" &&
          (teamId === null ? member.teamId === null : member.teamId === teamId),
      );
    }
    case "chat":
      // Chat privacy: private to whoever started it, whatever the roles. The
      // org owner and org admins see summaries, never chat contents.
      return actor === resource.owner;
    case "bot-admin":
      // The main bot alone manages bots and teams, and only for an
      // account at org level; every other bot gets the same refusal.
      return level !== null && resource.caller !== "" && resource.caller === resource.main;
    default: {
      // Bot-owned resources: the filing account, then the role ladder.
      if (actor === resource.owner) return true;
      if (view === undefined || resource.home === undefined) return false;
      if (level !== null) return true; // org level spans teams
      const home = resource.home;
      const role =
        home.kind === "team" ? roleAt(actor, view, home.teamId) : roleAt(actor, view, null);
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
