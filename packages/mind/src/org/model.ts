/**
 * The org data model: one org per install, flat departments (no parent
 * field), members with roles, reach grants and published templates. Stored
 * as the `ultiv.org` document — the `ultiv.` prefix every stored record in
 * the repo keeps (see AGENTS.md Naming). The pure helpers here are the ONE
 * definition of "which home is this" and "what are this member's roles";
 * `can()` on the server and the prompt/memory scoping in the mind read them.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import type { ProfileInfo } from "@spriessen/contracts";
import {
  DEFAULT_ORG_SHARED_CAP_BYTES,
  type DepartmentInfo,
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
  version: 1,
  scope: "session",
  initial: () => ({ org: null, departments: [], members: [], grants: [], templates: [] }),
  checkpointWhen: () => true,
});

/** The state a fresh install reads (org null: nothing exists yet). */
export const emptyOrgState = (): OrgState => ({
  org: null,
  departments: [],
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
        // deterministic and stable, though a legacy first department may
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
        },
  departments: (state.departments ?? []).map((row, index) => ({
    ...row,
    instructions: typeof row.instructions === "string" ? row.instructions : "",
    // Legacy department rows read deterministically by position, after the
    // org's gid; created rows always carry their own stored gid.
    sharedGid: row.sharedGid ?? 10_001 + index,
    netAllowlist: Array.isArray(row.netAllowlist) ? row.netAllowlist : [],
  })),
  members: state.members ?? [],
  grants: state.grants ?? [],
  templates: state.templates ?? [],
});

/** The bot's home: its department, or the org when `departmentId` is null. */
export const homeOf = (profile: Pick<ProfileInfo, "departmentId">): HomeRef =>
  typeof profile.departmentId === "string" && profile.departmentId !== ""
    ? { kind: "department", departmentId: profile.departmentId }
    : { kind: "org" };

/**
 * The bot's home as the opaque segment stored resources key on (slice 7:
 * connector config per home): `org`, or `dept-<department id>`. ext judges
 * nothing — it stores and compares segments only.
 */
export const homeSegmentOf = (profile: { readonly departmentId?: string | null }): string =>
  typeof profile.departmentId === "string" && profile.departmentId !== ""
    ? `dept-${profile.departmentId}`
    : "org";

/**
 * The inverse, for the storage paths that need the stored id (slice 8: a
 * secure-field secret for a department connector is sealed as a vault item
 * OF that department): the department id a segment names, or undefined for
 * the org (and for anything that is not a `dept-` segment).
 */
export const departmentIdOfSegment = (home: string): string | undefined =>
  home.startsWith("dept-") && home.length > "dept-".length ? home.slice("dept-".length) : undefined;

/** A resource owned by a bot lives in its bot's home — exactly one. */
export const homeOfResource = <T extends { profileId?: string | null }>(
  resource: T,
  profileOf: (id: string) => Pick<ProfileInfo, "departmentId"> | undefined,
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
 * Every bot must have exactly one home that exists: a department id that
 * names a stored department, or null (the org). The single `departmentId`
 * field cannot hold two homes by construction; the check exists so a
 * dangling reference (the home was removed) is caught, and so resources
 * resolve through exactly one bot. Used by tests and the purge cascade.
 */
export const checkHomes = (
  profiles: readonly Pick<ProfileInfo, "id" | "departmentId">[],
  departments: readonly Pick<DepartmentInfo, "id">[],
): HomeViolation[] => {
  const ids = new Set(departments.map((row) => row.id));
  const violations: HomeViolation[] = [];
  for (const profile of profiles) {
    const home = homeOf(profile);
    if (home.kind === "department" && !ids.has(home.departmentId)) {
      violations.push({
        what: "bot",
        id: profile.id,
        problem: `department ${home.departmentId} does not exist`,
      });
    }
  }
  return violations;
};

/** The roles `accountId` holds in `departmentId` (null = org level). */
export const rolesOf = (
  members: readonly MemberInfo[],
  accountId: string,
  departmentId: string | null,
): OrgRole[] =>
  members
    .filter((member) => member.accountId === accountId && member.departmentId === departmentId)
    .map((member) => member.role);

export const hasRole = (
  members: readonly MemberInfo[],
  accountId: string,
  role: OrgRole,
  departmentId: string | null,
): boolean => rolesOf(members, accountId, departmentId).includes(role);

/** The org-level role (owner/admin/member/viewer), if any. */
export const orgRoleOf = (members: readonly MemberInfo[], accountId: string): OrgRole | null =>
  rolesOf(members, accountId, null)[0] ?? null;

/** True when the account administers this department (or sits above it at org level). */
export const administers = (
  members: readonly MemberInfo[],
  accountId: string,
  departmentId: string | null,
): boolean => {
  if (hasRole(members, accountId, "owner", null)) return true;
  if (hasRole(members, accountId, "admin", null)) return true;
  return departmentId !== null && hasRole(members, accountId, "admin", departmentId);
};

/**
 * Who a pending approval card goes to: for a department bot, that
 * department's admins and the org owner; for an org bot, the org owner and
 * the org admins. Never another department's admins.
 */
export const approversFor = (
  members: readonly MemberInfo[],
  orgOwner: string | null,
  botHome: HomeRef,
): string[] => {
  const out = new Set<string>();
  if (orgOwner !== null) out.add(orgOwner);
  if (botHome.kind === "department") {
    for (const member of members) {
      if (member.role === "admin" && member.departmentId === botHome.departmentId) {
        out.add(member.accountId);
      }
    }
  } else {
    for (const member of members) {
      if (member.role === "admin" && member.departmentId === null) out.add(member.accountId);
    }
  }
  return [...out];
};

/** Which level blocks host access: "org", "department" or "bot" (null = not blocked). */
export type HostBlock = "org" | "department" | "bot";

/**
 * Host access, effectively: org AND department AND bot for a department
 * bot; org AND bot for an org bot. `blockedBy` names the level that blocks,
 * for the UI and the refusal — a bot or department on under an off level is
 * allowed by its own flag but inert (F4).
 */
export const effectiveHostAccess = (
  org: Pick<OrgInfo, "hostAccess"> | null,
  departments: readonly { readonly id: string; readonly hostAccess: boolean }[],
  profile: Pick<ProfileInfo, "departmentId" | "hostAccess">,
): { readonly allowed: boolean; readonly blockedBy: HostBlock | null } => {
  if (org === null) return { allowed: false, blockedBy: null };
  if (!org.hostAccess) return { allowed: false, blockedBy: "org" };
  const home = homeOf(profile);
  if (home.kind === "department") {
    const department = departments.find((row) => row.id === home.departmentId);
    if (department === undefined) return { allowed: false, blockedBy: null };
    if (!department.hostAccess) return { allowed: false, blockedBy: "department" };
  }
  if (profile.hostAccess !== true) return { allowed: false, blockedBy: "bot" };
  return { allowed: true, blockedBy: null };
};

export const defaultVm = (): VmSettings => ({ cpus: 1, memoryMiB: 512 });
