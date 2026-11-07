/**
 * The Org service: reads and writes the `ultiv.org` document. Teams,
 * members, grants and templates live here; bots stay in the profiles
 * registry and point at a team with `teamId`. Everything goes
 * through one commit helper so a change lands as one transaction.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { InvalidInput, NotFound, Unavailable } from "@spriessen/core";
import type {
  TeamCreate,
  TeamInfo,
  TeamPatch,
  GrantInfo,
  HomeRef,
  MemberInfo,
  MemberPut,
  OrgInfo,
  OrgState,
  ProfileInfo,
  TemplateInfo,
} from "@spriessen/contracts";
import {
  DEFAULT_TEAM_SHARED_CAP_BYTES,
  DEFAULT_ORG_SHARED_CAP_BYTES,
  DEFAULT_VM,
} from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { botUidPeek, botUserName } from "./bot-users.ts";
import { teamGroupReconcileScript, type TeamStore } from "@spriessen/ext";
import { readProfiles } from "../profiles/docs.ts";
import { OrgDoc, defaultVm, emptyOrgState, homeOf, normalizeOrgState } from "./model.ts";
import { refuseBadVm, type VmSizeOptions } from "./vm-size.ts";
export { teamInstructionsOf, teamOfProfile, teamOfProfileRow } from "./team-of.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** Injectable side effects, so tests never touch a VM. */
export type OrgServiceOptions = VmSizeOptions & {
  /**
   * Tears the HOME's microVM down (best effort, bounded) — wired by the
   * entity with the real `destroySandbox`; tests omit it. A team
   * removal destroys the team's VM; the org VM is destroyed only
   * with the org.
   */
  readonly destroyHomeVm?: (owner: string, home: HomeRef) => Promise<void>;
  /**
   * Retires a removed bot's Linux user (and so its shared-folder group
   * membership) from its home's VM (slice 2b) — wired by the entity with
   * the real `retireSandboxUser` path; tests inject a recorder. Absent in
   * bare service tests, where the sweep is a no-op.
   */
  readonly retireBotUser?: (owner: string, home: HomeRef, profileId: string) => Promise<void>;
  /**
   * Reconciles `/etc/group` in the RUNNING org VM against the stored
   * teams and org bots (slice 2d) — fired on team create and
   * delete. The default runs ext's script in the named VM; tests inject a
   * recorder.
   */
  readonly reconcileTeamGroups?: (owner: string, script: string) => Promise<void>;
  /**
   * Deletes a team's durable shared store with its purge (slice 2d,
   * F-D9 default: delete; archiving is not decided). The default rmSyncs
   * `{ARTIFACTS_DIR}/{owner}/_team/<id>`; tests inject a recorder.
   */
  readonly deleteTeamStore?: (owner: string, teamId: string) => Promise<void>;
  /**
   * Fired after every committed change (slice 10): the entity's host-access
   * watch refreshes its flag snapshot on it and re-applies the bots' tool
   * lists when a switch flipped. Never fails the change.
   */
  readonly onChanged?: () => void;
};

/** The whole org state, normalized (missing fields filled, never overwritten). */
export const readOrgState = (converse: ConverseService): Promise<OrgState> =>
  run(
    Effect.map(converse.docs.snapshot(OrgDoc), (doc) => normalizeOrgState(doc ?? emptyOrgState())),
  );

/** Commit one change to the org document. */
export const commitOrg = (
  converse: ConverseService,
  change: (draft: OrgState) => void,
): Promise<void> =>
  run(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(OrgDoc);
      // Mutate the draft in place; a copy would die with the transaction.
      change(draft as OrgState);
    }),
  );

export interface OrgView {
  readonly org: OrgInfo | null;
  readonly teams: readonly TeamInfo[];
  readonly members: readonly MemberInfo[];
  readonly grants: readonly GrantInfo[];
  readonly templates: readonly TemplateInfo[];
}

export interface OrgService {
  /** The current state (org null on a fresh install, before the migration). */
  readonly view: () => Promise<OrgView>;
  /** Create the org once (the migration); repeat calls change nothing. */
  readonly ensureOrg: (owner: string, name: string, hostAccess: boolean) => Promise<OrgInfo>;
  /** Patch the org row (name, VM settings, host-access flag, folder cap, network allowlist). */
  readonly updateOrg: (patch: {
    readonly name?: string;
    readonly vm?: { readonly cpus: number; readonly memoryMiB: number };
    readonly hostAccess?: boolean;
    readonly orgSharedCapBytes?: number;
    readonly netAllowlist?: readonly string[];
    readonly netOpen?: boolean;
  }) => Promise<OrgInfo>;
  readonly createTeam: (input: TeamCreate, by: string) => Promise<TeamInfo>;
  readonly updateTeam: (id: string, patch: TeamPatch) => Promise<TeamInfo>;
  /** Refuses while the team still has bots (move or delete them first). */
  readonly removeTeam: (id: string) => Promise<boolean>;
  /** Set (or replace) one membership row; org owner and org admins manage these. */
  readonly setMember: (input: MemberPut) => Promise<MemberInfo[]>;
  readonly removeMember: (accountId: string, teamId: string | null) => Promise<boolean>;
  readonly addGrant: (
    resource: GrantInfo["resource"],
    grantee: HomeRef,
    by: string,
  ) => Promise<GrantInfo>;
  readonly revokeGrant: (id: string) => Promise<boolean>;
  readonly activeGrants: () => Promise<readonly GrantInfo[]>;
  readonly putTemplate: (template: TemplateInfo) => Promise<TemplateInfo>;
  readonly removeTemplate: (id: string) => Promise<boolean>;
  /**
   * Retire a removed bot's Linux user from its home's VM (slice 2b). False
   * when there is nothing to do: no sweep wired (bare tests) or the bot
   * never ran `bash`, so it has no uid and no user in any VM.
   */
  readonly retireBotUser: (
    owner: string,
    profile: Pick<ProfileInfo, "id" | "teamId">,
  ) => Promise<boolean>;
}

/** The team a HomeRef names, or null for the org. */
const teamOfHome = (home: HomeRef): string | null => (home.kind === "team" ? home.teamId : null);

/**
 * The reconcile script for the org VM's team groups (slice 2d): the
 * stored teams and every org bot that already has a Linux user (never
 * allocating — a user appears at its bot's first use, never pre-created).
 */
const teamReconcileScript = async (converse: ConverseService): Promise<string> => {
  const state = await readOrgState(converse);
  const profiles = await run(readProfiles(converse));
  const users: string[] = [];
  for (const bot of profiles.filter((row) => homeOf(row).kind === "org")) {
    if ((await botUidPeek(converse)(bot.id)) !== undefined) users.push(botUserName(bot.id));
  }
  const teams: TeamStore[] = state.teams
    .filter((row) => row.sharedGid !== undefined)
    .map((row) => ({ id: row.id, gid: row.sharedGid as number }));
  return teamGroupReconcileScript(teams, users);
};

/** Fires the reconciliation best effort; a missing hook or VM is a no-op. */
const fireReconcile = async (
  converse: ConverseService,
  options: OrgServiceOptions,
  owner: string | undefined,
): Promise<void> => {
  if (options.reconcileTeamGroups === undefined || owner === undefined) return;
  try {
    await options.reconcileTeamGroups(owner, await teamReconcileScript(converse));
  } catch {
    // Reconciliation observes; it must never fail a team create.
  }
};

/** A team id that is not in use; `name` is unique among teams. */
const teamId = (name: string): string =>
  `team-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 24) || randomUUID().slice(0, 8)
  }`;

/** The next free shared-folder gid: fixed gids from 10000 up, never reused. */
const nextGid = (state: OrgState): number =>
  Math.max(
    10_000,
    state.org?.sharedGid ?? 0,
    // The org-wide folder's group is a gid of its own: teams never
    // get it (slice 2c).
    state.org?.orgSharedGid ?? 0,
    ...state.teams.map((row) => row.sharedGid ?? 0),
  ) + 1;

/**
 * The slice 4 VM-size checks live in `./vm-size.ts` (`refuseBadVm`): the
 * dialog's-words bounds plus the host-capacity rule, applied to the org
 * and team create and edit paths below.
 */
export const orgService = (
  converse: ConverseService,
  options: OrgServiceOptions = {},
): OrgService => {
  // Every committed change fires `onChanged` (slice 10): the entity's
  // host-access watch lives on it. Best effort — never fails the change.
  const fireChanged = (): void => {
    try {
      options.onChanged?.();
    } catch {
      // Observers must not break the commit path.
    }
  };
  const commit = async (change: (draft: OrgState) => void): Promise<void> => {
    await commitOrg(converse, change);
    fireChanged();
  };
  const view = async (): Promise<OrgView> => {
    const state = await readOrgState(converse);
    return {
      org: state.org,
      teams: state.teams,
      members: state.members,
      grants: state.grants,
      templates: state.templates,
    };
  };
  return {
    view,
    ensureOrg: async (owner, name, hostAccess) => {
      const state = await readOrgState(converse);
      if (state.org !== null) return state.org;
      const org: OrgInfo = {
        id: "org",
        name,
        owner,
        createdAt: Date.now(),
        vm: defaultVm(),
        hostAccess,
        sharedGid: 10_000,
        // The org-wide folder's own group, separate from /home/shared's and
        // from every team's (slice 2c).
        orgSharedGid: 10_001,
        orgSharedCapBytes: DEFAULT_ORG_SHARED_CAP_BYTES,
      };
      const member: MemberInfo = { accountId: owner, role: "owner", teamId: null };
      await commit((draft) => {
        if (draft.org !== null) return;
        draft.org = org;
        draft.members = [...draft.members, member];
      });
      return org;
    },
    updateOrg: async (patch) => {
      if (patch.orgSharedCapBytes !== undefined) {
        const cap = patch.orgSharedCapBytes;
        if (!Number.isInteger(cap) || cap < 1_048_576) {
          throw new InvalidInput({
            reason: "the shared-folder size cap must be a whole number of at least 1 MiB",
          });
        }
      }
      const state = await readOrgState(converse);
      const org = state.org;
      if (org === null) throw new NotFound({ what: "org" });
      refuseBadVm(
        state,
        patch.vm,
        () => [patch.vm ?? org.vm, ...state.teams.map((row) => row.vm)],
        options,
      );
      let updated: OrgInfo | undefined;
      await commit((draft) => {
        if (draft.org === null) return;
        updated = {
          ...draft.org,
          vm: { ...draft.org.vm },
          // Plain copies: the returned row must not reach into the draft
          // (a settled overlay throws the moment it is stringified).
          netAllowlist: [...(patch.netAllowlist ?? draft.org.netAllowlist ?? [])],
          netOpen: patch.netOpen ?? draft.org.netOpen === true,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.vm !== undefined ? { vm: { ...patch.vm } } : {}),
          ...(patch.hostAccess !== undefined ? { hostAccess: patch.hostAccess } : {}),
          ...(patch.orgSharedCapBytes !== undefined
            ? { orgSharedCapBytes: patch.orgSharedCapBytes }
            : {}),
        };
        draft.org = updated;
      });
      if (updated === undefined) throw new NotFound({ what: "org" });
      return updated;
    },
    createTeam: async (input, _by) => {
      const state = await readOrgState(converse);
      if (state.org === null)
        throw new Unavailable({ faculty: "org", why: "the org does not exist yet" });
      if (state.teams.some((row) => row.name === input.name)) {
        throw new InvalidInput({ reason: "a team with this name already exists" });
      }
      const orgVm = state.org.vm;
      refuseBadVm(
        state,
        input.vm,
        () => [
          orgVm,
          ...state.teams.map((row) => row.vm),
          // A NEW home counts against capacity at its default too: an org
          // with many default teams fills the budget (slice 4).
          input.vm ?? DEFAULT_VM,
        ],
        options,
      );
      const row: TeamInfo = {
        id: teamId(input.name),
        name: input.name,
        createdAt: Date.now(),
        vm: input.vm ?? defaultVm(),
        hostAccess: input.hostAccess ?? false,
        instructions: input.instructions ?? "",
        netAllowlist: input.netAllowlist ?? [],
        netOpen: input.netOpen ?? false,
        sharedCapBytes: DEFAULT_TEAM_SHARED_CAP_BYTES,
        sharedGid: nextGid(state),
      };
      await commit((draft) => {
        draft.teams = [...draft.teams, row];
      });
      // The org VM picks the new store up live (the parent mount shows it);
      // only /etc/group needs reconciling — no VM restart (F-D6).
      await fireReconcile(converse, options, state.org.owner);
      return row;
    },
    updateTeam: async (id, patch) => {
      if (
        patch.sharedCapBytes !== undefined &&
        (!Number.isInteger(patch.sharedCapBytes) || patch.sharedCapBytes < 1_048_576)
      ) {
        throw new InvalidInput({
          reason: "the shared-folder size cap must be a whole number of at least 1 MiB",
        });
      }
      const state = await readOrgState(converse);
      const target = state.teams.find((row) => row.id === id);
      if (target === undefined) throw new NotFound({ what: `team ${id}` });
      refuseBadVm(
        state,
        patch.vm,
        () => [
          ...(state.org === null ? [] : [state.org.vm]),
          ...state.teams.map((row) => (row.id === id ? (patch.vm ?? row.vm) : row.vm)),
        ],
        options,
      );
      let updated: TeamInfo | undefined;
      await commit((draft) => {
        draft.teams = draft.teams.map((row) => {
          if (row.id !== id) return row;
          updated = {
            ...row,
            vm: { ...row.vm },
            // Plain copy: never reach into the settled draft (see updateOrg).
            netAllowlist: [...(patch.netAllowlist ?? row.netAllowlist ?? [])],
            netOpen: patch.netOpen ?? row.netOpen === true,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.vm !== undefined ? { vm: { ...patch.vm } } : {}),
            ...(patch.hostAccess !== undefined ? { hostAccess: patch.hostAccess } : {}),
            ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
            ...(patch.sharedCapBytes !== undefined ? { sharedCapBytes: patch.sharedCapBytes } : {}),
          };
          return updated;
        });
      });
      if (updated === undefined) throw new NotFound({ what: `team ${id}` });
      // A plain copy: draft values die with the transaction.
      return updated;
    },
    removeTeam: async (id) => {
      const state = await readOrgState(converse);
      if (!state.teams.some((row) => row.id === id)) return false;
      const profiles = await run(readProfiles(converse));
      if (profiles.some((profile) => profile.teamId === id)) {
        throw new InvalidInput({ reason: "the team still has bots" });
      }
      await commit((draft) => {
        draft.teams = draft.teams.filter((row) => row.id !== id);
        draft.members = draft.members.filter((member) => member.teamId !== id);
        draft.grants = draft.grants.filter(
          (grant) => teamOfHome(grant.resource.home) !== id && teamOfHome(grant.grantee) !== id,
        );
      });
      // The team's VM goes with it (best effort, bounded, injected —
      // tests omit it). The org VM is destroyed only with the org. The
      // team's durable store is deleted with the purge (F-D9
      // default), and the org VM's /etc/group loses the team's group.
      const owner = state.org?.owner;
      if (options.destroyHomeVm !== undefined && owner !== undefined) {
        await options.destroyHomeVm(owner, { kind: "team", teamId: id });
      }
      if (options.deleteTeamStore !== undefined && owner !== undefined) {
        await options.deleteTeamStore(owner, id).catch(() => {});
      }
      await fireReconcile(converse, options, owner);
      return true;
    },
    setMember: async (input) => {
      await commit((draft) => {
        const rest = draft.members.filter(
          (member) => !(member.accountId === input.accountId && member.teamId === input.teamId),
        );
        draft.members = [...rest, input];
      });
      return (await readOrgState(converse)).members;
    },
    removeMember: async (accountId, teamId) => {
      const before = await readOrgState(converse);
      if (
        !before.members.some((member) => member.accountId === accountId && member.teamId === teamId)
      ) {
        return false;
      }
      await commit((draft) => {
        draft.members = draft.members.filter(
          (member) => !(member.accountId === accountId && member.teamId === teamId),
        );
      });
      return true;
    },
    addGrant: async (resource, grantee, by) => {
      const grant: GrantInfo = {
        id: randomUUID(),
        resource,
        grantee,
        action: "use",
        createdAt: Date.now(),
        createdBy: by,
        revokedAt: null,
      };
      await commit((draft) => {
        draft.grants = [...draft.grants, grant];
      });
      return grant;
    },
    revokeGrant: async (id) => {
      const state = await readOrgState(converse);
      const grant = state.grants.find((row) => row.id === id && row.revokedAt === null);
      if (grant === undefined) return false;
      await commit((draft) => {
        draft.grants = draft.grants.map((row) =>
          row.id === id && row.revokedAt === null ? { ...row, revokedAt: Date.now() } : row,
        );
      });
      return true;
    },
    activeGrants: async () =>
      (await readOrgState(converse)).grants.filter((grant) => grant.revokedAt === null),
    putTemplate: async (template) => {
      await commit((draft) => {
        draft.templates = [...draft.templates.filter((row) => row.id !== template.id), template];
      });
      return template;
    },
    removeTemplate: async (id) => {
      const state = await readOrgState(converse);
      if (!state.templates.some((row) => row.id === id)) return false;
      await commit((draft) => {
        draft.templates = draft.templates.filter((row) => row.id !== id);
      });
      return true;
    },
    retireBotUser: async (owner, profile) => {
      const sweep = options.retireBotUser;
      if (sweep === undefined) return false;
      // A bot that never ran `bash` has no uid, so no user in any VM.
      if ((await botUidPeek(converse)(profile.id)) === undefined) return false;
      await sweep(owner, homeOf(profile), profile.id);
      return true;
    },
  };
};
