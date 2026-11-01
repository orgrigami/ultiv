/**
 * Slice 10: the host-access switch as ONE seam. The effective flag (org AND
 * department AND bot, `effectiveHostAccess` in `./model.ts`) decides three
 * things, all reading the same predicate:
 * - the per-call gates (the act's guard for `bash_host`, the connector call
 *   gate for stdio servers) — checked BEFORE any approval decision, so a
 *   false switch wins over yolo, Jev and every stored allow rule (those go
 *   dormant, not deleted: they apply again when the switch turns on);
 * - the tool LIST: `hostExcludedTools` names what a bot loses while the
 *   switch is off, the same exclusion the sandbox toggle uses;
 * - decide time: a queued host-direct call is refused when approved after
 *   the switch turned off (the server's decide paths ask `hostSwitchWatch`'s
 *   live view through `apps/server`'s shared helper).
 *
 * The watch keeps the LAST org view in memory so the tool-list exclusion can
 * stay synchronous, refreshes it on every org commit, and — when the flags
 * actually changed — re-applies every bot's agent (the tool selection is
 * durable per conversation; a flip must reach existing chats at once).
 */
import type { AgentChange } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { ProfileInfo, SessionInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { readProfiles } from "../profiles/docs.ts";
import { taskConversationKey } from "../tasks/tasks.ts";
import { effectiveHostAccess, type HostBlock } from "./model.ts";
import type { OrgView } from "./service.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** Tools that run on the server's own machine, never in a bot's home VM. */
export const HOST_DIRECT_TOOLS: readonly string[] = ["bash_host"];

/** The refusal a host-direct call reads when the switch is off. */
export const HOST_REFUSAL =
  "this bot does not have access to this computer (the owner has not granted it)";

/** The flags the switch reads: the org row and the departments. */
export type HostFlags = Pick<OrgView, "org" | "departments">;

/**
 * The effective answer, with the PRE-MIGRATION state (no org row at all)
 * behaving as before: the switch feature is dormant until the migration
 * creates the org, so nothing is excluded and no approval is refused on its
 * account. A stored org — on or off — decides as `effectiveHostAccess` says.
 */
export const switchAllows = (
  flags: HostFlags | undefined,
  profile: Pick<ProfileInfo, "departmentId" | "hostAccess">,
): boolean =>
  flags === undefined || flags.org === null
    ? true
    : effectiveHostAccess(flags.org, flags.departments, profile).allowed;

/** Which level blocks the switch for this bot, on the live view (null: none). */
export const hostBlockedBy = (
  flags: HostFlags | undefined,
  profile: Pick<ProfileInfo, "departmentId" | "hostAccess">,
): HostBlock | null =>
  flags === undefined ? null : effectiveHostAccess(flags.org, flags.departments, profile).blockedBy;

/**
 * The names to drop from a bot's tool list while its effective host access
 * is false: the host-direct tools plus the stdio connector tools it could
 * load (`bash` and the browser run in the bot's own VM — never here).
 * Unknown flags (before the first read) exclude nothing: the per-call gates
 * still refuse, so this only shapes the list, never opens access.
 */
export const hostExcludedTools = (
  flags: HostFlags | undefined,
  profile: Pick<ProfileInfo, "departmentId" | "hostAccess">,
  stdioToolNames: readonly string[],
): string[] => {
  if (!switchAllows(flags, profile)) return [...HOST_DIRECT_TOOLS, ...stdioToolNames];
  return [];
};

/** What changed in a view for the switch: only the flags themselves. */
const signatureOf = (flags: HostFlags | undefined): string =>
  JSON.stringify([
    flags?.org?.hostAccess ?? null,
    (flags?.departments ?? []).map((row) => [row.id, row.hostAccess]),
  ]);

/** The conversations a profile's agent applies to: its sessions and tasks. */
export interface ReapplyDeps {
  readonly converse: Pick<ConverseService, "open" | "conversationIdOf" | "configure">;
  readonly listSessions: (owner: string, profileId: string) => Promise<readonly SessionInfo[]>;
  readonly keyOfRow: (row: SessionInfo) => Promise<string>;
  /** Conversation ids of the profile's background tasks (they run as the bot). */
  readonly taskConversations: (profile: ProfileInfo) => Promise<readonly string[]>;
}

/**
 * Re-apply ONE profile's tool selection to every conversation it owns
 * (main, sessions, room seats, tasks) — tools only; the model preference is
 * untouched. Best effort per conversation, like the PATCH path.
 */
export const reapplyAgentTools = async (
  deps: ReapplyDeps,
  profile: ProfileInfo,
  tools: AgentChange["tools"],
): Promise<void> => {
  const selection = { tools: tools ?? null };
  const configure = async (conversationId: string): Promise<void> => {
    try {
      const chat = await Effect.runPromise(deps.converse.open(conversationId));
      if (chat === undefined) return;
      await Effect.runPromise(deps.converse.configure(chat, selection));
    } catch {
      // One stale seat never blocks the rest.
    }
  };
  for (const row of await deps.listSessions(profile.owner, profile.id)) {
    if (row.profile !== profile.id) continue;
    const key = await deps.keyOfRow(row);
    const cid = await Effect.runPromise(deps.converse.conversationIdOf(key));
    if (cid !== undefined) await configure(cid);
  }
  for (const cid of await deps.taskConversations(profile)) await configure(cid);
};

/** The live switch: flags snapshot, change watch, per-bot answers. */
export interface HostSwitchWatch {
  /** The last read org view (undefined before the first read). */
  readonly flags: () => HostFlags | undefined;
  /** The effective answer per bot on the snapshot (unknown flags: allowed). */
  readonly allows: (profile: Pick<ProfileInfo, "departmentId" | "hostAccess">) => boolean;
  /** Read the view once (boot). */
  readonly refresh: () => Promise<void>;
  /** Fired on every org commit: refreshes, and re-applies agents on a flip. */
  readonly onOrgChange: () => void;
  /** Re-apply every profile's agent from the CURRENT exclusion rules. */
  readonly resyncAll: (profiles: readonly ProfileInfo[]) => Promise<void>;
}

export const hostSwitchWatch = (deps: {
  readonly view: () => Promise<OrgView>;
  /** Every stored bot: a flip re-applies each one's agent. */
  readonly allProfiles: () => Promise<readonly ProfileInfo[]>;
  readonly agentFor: (profile: ProfileInfo) => AgentChange;
  readonly reapply: ReapplyDeps;
}): HostSwitchWatch => {
  let flags: HostFlags | undefined;
  let signature = signatureOf(undefined);
  const watch: HostSwitchWatch = {
    flags: () => flags,
    allows: (profile) => switchAllows(flags, profile),
    refresh: async () => {
      // Never rejects: a failed first read leaves the flags unknown (the
      // per-call gates still refuse; the list stays as-is until a change).
      try {
        flags = await deps.view();
        signature = signatureOf(flags);
      } catch {
        // Observers must not break boot.
      }
    },
    onOrgChange: () => {
      void (async () => {
        const next = await deps.view();
        const changed = signatureOf(next) !== signature;
        flags = next;
        signature = signatureOf(next);
        if (changed) await watch.resyncAll(await deps.allProfiles());
      })().catch(() => {});
    },
    resyncAll: (profiles) =>
      Promise.all(
        profiles.map((profile) =>
          reapplyAgentTools(deps.reapply, profile, deps.agentFor(profile).tools ?? null).catch(
            () => {},
          ),
        ),
      ).then(() => {}),
  };
  return watch;
};

/**
 * The entity's watch, wired to the real services: the org view, every stored
 * bot, each bot's agent, and the conversation enumeration of `reapply`.
 */
export const mindHostSwitchWatch = (services: {
  readonly org: { readonly view: () => Promise<OrgView> };
  readonly profiles: {
    readonly agentFor: (profile: ProfileInfo) => AgentChange;
    readonly listSessions: (owner: string, profileId: string) => Promise<readonly SessionInfo[]>;
    readonly keyOfRow: (row: SessionInfo) => Promise<string>;
  };
  readonly converse: ConverseService;
  readonly tasks: {
    readonly list: () => Effect.Effect<
      readonly {
        readonly id: string;
        readonly bot?: { readonly owner: string; readonly profileId: string } | null;
      }[],
      unknown
    >;
  };
}): HostSwitchWatch => {
  const watch = hostSwitchWatch({
    view: services.org.view,
    allProfiles: () => run(readProfiles(services.converse)),
    agentFor: services.profiles.agentFor,
    reapply: {
      converse: services.converse,
      listSessions: services.profiles.listSessions,
      keyOfRow: services.profiles.keyOfRow,
      taskConversations: async (profile) => {
        const out: string[] = [];
        for (const task of await run(services.tasks.list())) {
          if (task.bot?.owner !== profile.owner || task.bot.profileId !== profile.id) continue;
          const cid = await run(services.converse.conversationIdOf(taskConversationKey(task.id)));
          if (cid !== undefined) out.push(String(cid));
        }
        return out;
      },
    },
  });
  // Fill the snapshot now: the exclusion reads it from the first agent build.
  void watch.refresh().catch(() => {});
  return watch;
};
