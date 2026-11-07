/**
 * The org data model: one org per install, flat teams (no parent
 * field), members with roles, reach grants and published templates. Stored
 * as the `ultiv.org` document — the `ultiv.` prefix every stored record in
 * the repo keeps (see AGENTS.md Naming). The pure helpers here are the ONE
 * definition of "which home is this" and "what are this member's roles";
 * `can()` on the server and the prompt/memory scoping in the mind read them.
 */
import { renameLegacyTeams } from "../migrate/teams.ts";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ProfileInfo } from "@spriessen/contracts";
import {
  DEFAULT_ORG_SHARED_CAP_BYTES,
  DEFAULT_TEAM_SHARED_CAP_BYTES,
  type TeamInfo,
  type HomeRef,
  type MemberInfo,
  type OrgInfo,
  type OrgRole,
  type OrgState,
  type VmSettings,
} from "@spriessen/contracts";

/** The stored org document: everything the org holds besides bots. */
export const OrgDoc = defineDoc<OrgState>({
  kind: "ultiv.org",
  // v2: departments became teams (migrate/teams.ts); ids are unchanged.
  version: 2,
  scope: "session",
  migrate: (value) => renameLegacyTeams(value) as never,
  initial: () => ({ org: null, teams: [], members: [], grants: [], templates: [] }),
  checkpointWhen: () => true,
});

/** The state a fresh install reads (org null: nothing exists yet). */
export const emptyOrgState = (): OrgState => ({
  org: null,
  teams: [],
  members: [],
  grants: [],
  templates: [],
});

/** Fill fields older rows may miss; never overwrites a stored value. */
export const normalizeOrgState = (state: OrgState): OrgState => ({
  org:
    state.org === null || state.org === undefined
      ? null
      : // A legacy org row (before the shared folder existed) reads as the
        // first fixed gid; created rows always carry their own. The
        // org-wide folder's gid (slice 2c) reads as sharedGid + 1 —
        // deterministic and stable, though a legacy first team may
        // hold that same gid (its org-shared mount is read-only, so the
        // duplicate gid grants nothing).
        {
          ...state.org,
          sharedGid: state.org.sharedGid ?? 10_000,
          orgSharedGid: state.org.orgSharedGid ?? (state.org.sharedGid ?? 10_000) + 1,
          orgSharedCapBytes: state.org.orgSharedCapBytes ?? DEFAULT_ORG_SHARED_CAP_BYTES,
          // The network allowlist (slice 3): legacy rows read an empty
          // list — the offline default — until the owner edits one.
          netAllowlist: Array.isArray(state.org.netAllowlist) ? state.org.netAllowlist : [],
          // Full network access (owner opt-in); legacy rows read false.
          netOpen: state.org.netOpen === true,
        },
  teams: (state.teams ?? []).map((row, index) => ({
    ...row,
    instructions: typeof row.instructions === "string" ? row.instructions : "",
    // Legacy team rows read deterministically by position, after the
    // org's gid; created rows always carry their own stored gid.
    sharedGid: row.sharedGid ?? 10_001 + index,
    netAllowlist: Array.isArray(row.netAllowlist) ? row.netAllowlist : [],
    netOpen: row.netOpen === true,
    sharedCapBytes: row.sharedCapBytes ?? DEFAULT_TEAM_SHARED_CAP_BYTES,
  })),
  members: state.members ?? [],
  grants: state.grants ?? [],
  templates: state.templates ?? [],
});

/** The bot's home: its team, or the org when `teamId` is null. */
export const homeOf = (profile: Pick<ProfileInfo, "teamId">): HomeRef =>
  typeof profile.teamId === "string" && profile.teamId !== ""
    ? { kind: "team", teamId: profile.teamId }
    : { kind: "org" };

/**
 * The bot's home as the opaque segment stored resources key on (slice 7:
 * connector config per home): `org`, or `team-<team id>`. ext judges
 * nothing — it stores and compares segments only.
 */
export const homeSegmentOf = (profile: { readonly teamId?: string | null }): string =>
  typeof profile.teamId === "string" && profile.teamId !== "" ? `team-${profile.teamId}` : "org";

/**
 * The inverse, for the storage paths that need the stored id (slice 8: a
 * secure-field secret for a team connector is sealed as a vault item
 * OF that team): the team id a segment names, or undefined for
 * the org (and for anything that is not a team segment). A `dept-` segment
 * (from when teams were departments, before ext's upgradeMcpTeamHomes ran)
 * still names its team.
 */
export const teamIdOfSegment = (home: string): string | undefined => {
  const prefix = ["team-", "dept-"].find((p) => home.startsWith(p) && home.length > p.length);
  return prefix === undefined ? undefined : home.slice(prefix.length);
};

/** A resource owned by a bot lives in its bot's home — exactly one. */
export const homeOfResource = <T extends { profileId?: string | null }>(
  resource: T,
  profileOf: (id: string) => Pick<ProfileInfo, "teamId"> | undefined,
): HomeRef | null => {
  const profileId =
    typeof resource.profileId === "string" && resource.profileId !== "" ? resource.profileId : null;
  if (profileId === null) return null;
  const profile = profileOf(profileId);
  return profile === undefined ? null : homeOf(profile);
};

export interface HomeViolation {
  readonly what: string;
  readonly id: string;
  readonly problem: string;
}

/**
 * Every bot must have exactly one home that exists: a team id that
 * names a stored team, or null (the org). The single `teamId`
 * field cannot hold two homes by construction; the check exists so a
 * dangling reference (the home was removed) is caught, and so resources
 * resolve through exactly one bot. Used by tests and the purge cascade.
 */
export const checkHomes = (
  profiles: readonly Pick<ProfileInfo, "id" | "teamId">[],
  teams: readonly Pick<TeamInfo, "id">[],
): HomeViolation[] => {
  const ids = new Set(teams.map((row) => row.id));
  const violations: HomeViolation[] = [];
  for (const profile of profiles) {
    const home = homeOf(profile);
    if (home.kind === "team" && !ids.has(home.teamId)) {
      violations.push({
        what: "bot",
        id: profile.id,
        problem: `team ${home.teamId} does not exist`,
      });
    }
  }
  return violations;
};

/** The roles `accountId` holds in `teamId` (null = org level). */
export const rolesOf = (
  members: readonly MemberInfo[],
  accountId: string,
  teamId: string | null,
): OrgRole[] =>
  members
    .filter((member) => member.accountId === accountId && member.teamId === teamId)
    .map((member) => member.role);

export const hasRole = (
  members: readonly MemberInfo[],
  accountId: string,
  role: OrgRole,
  teamId: string | null,
): boolean => rolesOf(members, accountId, teamId).includes(role);

/** The org-level role (owner/admin/member/viewer), if any. */
export const orgRoleOf = (members: readonly MemberInfo[], accountId: string): OrgRole | null =>
  rolesOf(members, accountId, null)[0] ?? null;

/** True when the account administers this team (or sits above it at org level). */
export const administers = (
  members: readonly MemberInfo[],
  accountId: string,
  teamId: string | null,
): boolean => {
  if (hasRole(members, accountId, "owner", null)) return true;
  if (hasRole(members, accountId, "admin", null)) return true;
  return teamId !== null && hasRole(members, accountId, "admin", teamId);
};

/**
 * Who a pending approval card goes to: for a team bot, that
 * team's admins and the org owner; for an org bot, the org owner and
 * the org admins. Never another team's admins.
 */
export const approversFor = (
  members: readonly MemberInfo[],
  orgOwner: string | null,
  botHome: HomeRef,
): string[] => {
  const out = new Set<string>();
  if (orgOwner !== null) out.add(orgOwner);
  if (botHome.kind === "team") {
    for (const member of members) {
      if (member.role === "admin" && member.teamId === botHome.teamId) {
        out.add(member.accountId);
      }
    }
  } else {
    for (const member of members) {
      if (member.role === "admin" && member.teamId === null) out.add(member.accountId);
    }
  }
  return [...out];
};

/** Which level blocks host access: "org", "team" or "bot" (null = not blocked). */
export type HostBlock = "org" | "team" | "bot";

/**
 * Host access, effectively: org AND team AND bot for a team
 * bot; org AND bot for an org bot. `blockedBy` names the level that blocks,
 * for the UI and the refusal — a bot or team on under an off level is
 * allowed by its own flag but inert (F4).
 */
export const effectiveHostAccess = (
  org: Pick<OrgInfo, "hostAccess"> | null,
  teams: readonly { readonly id: string; readonly hostAccess: boolean }[],
  profile: Pick<ProfileInfo, "teamId" | "hostAccess">,
): { readonly allowed: boolean; readonly blockedBy: HostBlock | null } => {
  if (org === null) return { allowed: false, blockedBy: null };
  if (!org.hostAccess) return { allowed: false, blockedBy: "org" };
  const home = homeOf(profile);
  if (home.kind === "team") {
    const team = teams.find((row) => row.id === home.teamId);
    if (team === undefined) return { allowed: false, blockedBy: null };
    if (!team.hostAccess) return { allowed: false, blockedBy: "team" };
  }
  if (profile.hostAccess !== true) return { allowed: false, blockedBy: "bot" };
  return { allowed: true, blockedBy: null };
};

export const defaultVm = (): VmSettings => ({ cpus: 1, memoryMiB: 512 });
