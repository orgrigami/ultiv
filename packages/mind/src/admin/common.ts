/**
 * The main bot's admin seam (bots and teams). Who may manage them is
 * one decision: the server answers it through `can()` (the `bot-admin`
 * resource); a bare mind falls back to the same rule, the main bot only.
 * Every other bot gets the one refusal below, word for word, whatever the
 * tool. Host-access switches are never part of it: no admin tool reads one
 * in from the model, so the owner stays the only one who flips them.
 */
import type { TeamInfo, ProfileInfo } from "@spriessen/contracts";
import { InvalidInput } from "@spriessen/core";
import type { ApprovalsService } from "../approvals.ts";
import type { AuditService } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";
import { findBot } from "../profiles/bots.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { orgService, type OrgService } from "../org/service.ts";
import { textReply } from "../act/task-live.ts";

/** What the host app wires in for the admin tools. */
export interface MindAdmin {
  /** May this bot manage bots and teams? The server asks `can()`; absent: main bot only. */
  readonly mayAdminister?: (scope: {
    readonly owner: string;
    readonly profileId: string;
    readonly mainId: string | null;
  }) => boolean | Promise<boolean>;
  /** The full purge for a deleted bot (every store it touched); absent: the row and its sessions. */
  readonly purgeBot?: (owner: string, id: string) => Promise<unknown>;
}

export interface AdminDeps {
  readonly profiles: ProfilesService;
  readonly approvals: ApprovalsService;
  readonly audit: AuditService;
  readonly converse: ConverseService;
  readonly admin?: MindAdmin;
  /**
   * The mind's org service (with the home-VM teardown wired). When absent a
   * bare one is built — tests, and embedders without a VM per home.
   */
  readonly org?: OrgService;
}

/** The one refusal: the same words for every non-main bot and every admin tool. */
export const ADMIN_REFUSAL =
  "only the main bot manages bots and teams; ask your owner to do it on the Crew page";

/** The calling bot when it may administer; the refusal text otherwise. */
export const adminOf = async (
  deps: AdminDeps,
  conversationId: string,
): Promise<ProfileInfo | string> => {
  const me = deps.profiles.profileOf(conversationId);
  if (me === undefined) return ADMIN_REFUSAL;
  const mainId = await deps.profiles.mainOf(me.owner);
  const allowed =
    deps.admin?.mayAdminister !== undefined
      ? await deps.admin.mayAdminister({ owner: me.owner, profileId: me.id, mainId })
      : me.id === mainId;
  return allowed ? me : ADMIN_REFUSAL;
};

/** The approval guard form: refused before any card is parked. */
export const adminGuard =
  (deps: AdminDeps) =>
  async (_args: unknown, api: unknown): Promise<string | undefined> => {
    const me = await adminOf(deps, String((api as { conversationId: unknown }).conversationId));
    return typeof me === "string" ? me : undefined;
  };

export const orgOf = (deps: AdminDeps): OrgService => deps.org ?? orgService(deps.converse);

/** "the org" for null; a team id or name otherwise (case-insensitive). */
export const resolveHome = async (
  deps: AdminDeps,
  ref: string | undefined,
): Promise<string | null> => {
  const wanted = (ref ?? "").trim();
  if (wanted === "" || wanted.toLowerCase() === "org") return null;
  return (await resolveTeam(deps, wanted)).id;
};

export const resolveTeam = async (deps: AdminDeps, ref: string): Promise<TeamInfo> => {
  const view = await orgOf(deps).view();
  const key = ref.trim().toLowerCase();
  const found = view.teams.find((row) => row.id === ref.trim() || row.name.toLowerCase() === key);
  if (found !== undefined) return found;
  const names = view.teams.map((row) => `"${row.name}"`).join(", ");
  throw new InvalidInput({
    reason:
      `no team "${ref}"; ` +
      (names === "" ? 'there are none yet (use "org")' : `use one of ${names} or "org"`),
  });
};

/** A bot of the owner's by id or exact name; the refusal names close matches. */
export const resolveBot = async (
  deps: AdminDeps,
  owner: string,
  ref: string,
): Promise<ProfileInfo> => {
  const found = findBot(await deps.profiles.list(owner), ref);
  if ("bot" in found) return found.bot;
  const hint = found.close.length > 0 ? `; did you mean ${found.close.join(", ")}?` : "";
  throw new InvalidInput({ reason: `no bot "${ref}"${hint} (bots_list shows them all)` });
};

/** Where a bot lives, in words: team "Team X" or the org (Org name). */
export const homeWords = (
  teamId: string | null | undefined,
  teams: readonly TeamInfo[],
  orgName: string,
): string => {
  const team = teams.find((row) => row.id === teamId);
  return team !== undefined ? `team "${team.name}"` : `the org (${orgName})`;
};

/** One permission audit row for a change the main bot made. */
export const auditChange = (deps: AdminDeps, profile: string, name: string): void => {
  deps.audit.record({
    at: Date.now(),
    kind: "permission",
    conversationId: "",
    profile,
    callId: null,
    name,
    durationMs: null,
    ok: true,
    error: null,
  });
};

/** A refusal or failure as the model's reply: the reason, and what to do next. */
export const failed = (verb: string, cause: unknown, next?: string) => {
  const error = cause as { reason?: string; what?: string } | null;
  const reason =
    typeof cause === "string"
      ? cause
      : (error?.reason ?? error?.what ?? (cause instanceof Error ? cause.message : String(cause)));
  return textReply(`not ${verb}: ${reason}${next !== undefined ? `; ${next}` : ""}`, true);
};

/** VM size from the model's two numbers; absent both = unchanged. */
export const vmOf = (
  cpus: number | undefined,
  memoryMiB: number | undefined,
  current: { readonly cpus: number; readonly memoryMiB: number },
): { cpus: number; memoryMiB: number } | undefined => {
  if (cpus === undefined && memoryMiB === undefined) return undefined;
  const next = { cpus: cpus ?? current.cpus, memoryMiB: memoryMiB ?? current.memoryMiB };
  if (!Number.isInteger(next.cpus) || next.cpus < 1 || next.cpus > 64) {
    throw new InvalidInput({ reason: "cpus must be a whole number from 1 to 64" });
  }
  if (!Number.isInteger(next.memoryMiB) || next.memoryMiB < 128 || next.memoryMiB > 65_536) {
    throw new InvalidInput({ reason: "memoryMiB must be a whole number from 128 to 65536" });
  }
  return next;
};
