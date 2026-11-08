import {
  arr,
  bool,
  int,
  lit,
  map,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";

/**
 * The org: one per install, holding flat teams and bots. Every bot has
 * exactly one home — one team, or the org itself (an "org bot"). Teams have
 * no parent; no nesting, no depth. Teams were called departments until
 * 2026-11-07; the mind's docs upgrade stored rows on read
 * (packages/mind/src/migrate/teams.ts).
 */

/** A member role. Held at org level (teamId null) or per team. */
export const OrgRoleSchema = oneOf(["owner", "admin", "member", "viewer"]);

export type OrgRole = Static<typeof OrgRoleSchema>;

/** Where a bot, or a bot-owned resource, lives: the org, or one team. */
export const HomeRefSchema = union([
  obj({ kind: lit("org") }, { open: true }),
  obj({ kind: lit("team"), teamId: str() }, { open: true }),
]);

export type HomeRef = Static<typeof HomeRefSchema>;

/**
 * The VM a home's bots share (started in Phase 4). Given at creation;
 * defaults 1 CPU and 512 MiB. The bounds are tightened for a 16 GB-class
 * host (slice 1's numbers): the per-VM maxima are a DEFAULT set from them,
 * not a recorded owner decision — one VM holds at most half this host's
 * cores and memory.
 */
export const VM_CPUS_MIN = 1;
export const VM_CPUS_MAX = 8;
export const VM_MEMORY_MIB_MIN = 128;
export const VM_MEMORY_MIB_MAX = 8_192;

export const VmSettingsSchema = obj(
  {
    cpus: num({ minimum: VM_CPUS_MIN, maximum: VM_CPUS_MAX }),
    memoryMiB: num({ minimum: VM_MEMORY_MIB_MIN, maximum: VM_MEMORY_MIB_MAX }),
  },
  { open: true },
);

export type VmSettings = Static<typeof VmSettingsSchema>;

export const DEFAULT_VM: VmSettings = { cpus: 1, memoryMiB: 512 };

/**
 * The host-capacity rule (slice 4): the CONFIGURED memory of all homes' VMs
 * (the org's plus every team's, defaults included) may reach at most
 * this fraction of the host's physical RAM. This is a configured-sum
 * heuristic over stored settings — NOT a live measurement of what the host
 * holds right now (docs/SECURITY.md).
 */
export const VM_HOST_MEMORY_FRACTION = 0.5;

/**
 * What is wrong with a VM-size value, in the dialog's words (the deadline
 * style); null when it is fine.
 */
export const vmSettingsProblem = (vm: unknown): string | null => {
  if (typeof vm !== "object" || vm === null) return "The VM size needs cpus and memoryMiB.";
  const { cpus, memoryMiB } = vm as { cpus?: unknown; memoryMiB?: unknown };
  if (
    typeof cpus !== "number" ||
    !Number.isInteger(cpus) ||
    cpus < VM_CPUS_MIN ||
    cpus > VM_CPUS_MAX
  ) {
    return `VM CPUs must be a whole number from ${VM_CPUS_MIN} to ${VM_CPUS_MAX}. Leave it out for the default (${DEFAULT_VM.cpus}).`;
  }
  if (
    typeof memoryMiB !== "number" ||
    !Number.isInteger(memoryMiB) ||
    memoryMiB < VM_MEMORY_MIB_MIN ||
    memoryMiB > VM_MEMORY_MIB_MAX
  ) {
    return `VM memory (MiB) must be a whole number from ${VM_MEMORY_MIB_MIN} to ${VM_MEMORY_MIB_MAX}. Leave it out for the default (${DEFAULT_VM.memoryMiB}).`;
  }
  return null;
};

/** The configured memory of every home's VM, added up (MiB). */
export const totalVmMemoryMiB = (vms: readonly VmSettings[]): number =>
  vms.reduce((sum, vm) => sum + vm.memoryMiB, 0);

/**
 * The host-capacity check, in the dialog's words; null when the sum fits.
 * `hostMemoryBytes` is the host's physical RAM (tests inject a smaller
 * value); the budget is `VM_HOST_MEMORY_FRACTION` of it.
 */
export const vmCapacityProblem = (totalMiB: number, hostMemoryBytes: number): string | null => {
  const budgetMiB = Math.floor((hostMemoryBytes * VM_HOST_MEMORY_FRACTION) / (1024 * 1024));
  return totalMiB <= budgetMiB
    ? null
    : `These VM sizes together ask for ${totalMiB} MiB of memory, and the host can hold ${budgetMiB} MiB of configured VM memory (half its RAM). Lower the VM sizes and try again.`;
};

/** Sent with a create/patch that changed a VM's size: when it applies. */
export const VM_CHANGE_NOTE = "The new VM size takes effect the next time this VM starts.";

/** The default size cap of the org-wide shared folder (slice 2c). */
export const DEFAULT_ORG_SHARED_CAP_BYTES = 1_073_741_824;

/** The default size cap of a team's shared folder (its store). */
export const DEFAULT_TEAM_SHARED_CAP_BYTES = 1_073_741_824;

/** The smallest accepted shared-folder cap (1 MiB). */
export const MIN_SHARED_CAP_BYTES = 1_048_576;

/** Whether bots of this home may run tools on the server's own machine. */
export const HostAccessSchema = bool();

/**
 * The per-VM network allowlist (phase 4 slice 3): named hosts the home's VM
 * may reach. Everything else is denied — the DEFAULT for both the org VM and
 * every team VM is NO network. An empty list means fully offline.
 */
export const NetAllowlistSchema = arr(str(), { maxItems: 64 });

export type NetAllowlist = Static<typeof NetAllowlistSchema>;

/**
 * Full network access for one home's VM (owner opt-in): when true the VM's
 * egress is unrestricted — the allowlist is ignored and every host, port
 * and the local network are reachable. Ingress stays denied. The sandbox's
 * network isolation is OFF for such a home; the UI says so loudly.
 */
export const NetOpenSchema = bool();

/** A valid allowlist entry: a hostname (`api.example.com`) or `*.example.com`. */
const HOST_ENTRY =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Validate an allowlist as it arrives over REST: at most 64 entries, each a
 * lowercase hostname (or a `*.suffix` for its subdomains), 253 bytes at
 * most. Returns the problem in owner words, or null when it is fine.
 */
export const netAllowlistProblem = (entries: unknown): string | null => {
  if (!Array.isArray(entries)) return "The allowlist must be a list of host names.";
  if (entries.length > 64) return "The allowlist holds at most 64 host names.";
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length > 253 || !HOST_ENTRY.test(entry)) {
      return `"${String(entry).slice(0, 60)}" is not a host name like api.example.com (or *.example.com).`;
    }
  }
  return null;
};

/** The org row. Exactly one exists after the migration; `owner` is the account that owns it. */
export const OrgInfoSchema = obj(
  {
    id: str(),
    name: str(),
    owner: str(),
    createdAt: num(),
    vm: VmSettingsSchema,
    /** Host access for the org level; the migration sets it true (today's behaviour). */
    hostAccess: HostAccessSchema,
    /**
     * Gid of the org VM's shared-folder group (`/home/shared`): fixed from
     * 10000 up, never reused. Allocated at creation; rows stored before the
     * field existed get a deterministic value on read (`normalizeOrgState`).
     */
    sharedGid: opt(num()),
    /**
     * Gid of the org-wide folder's group (`/home/org-shared`, slice 2c): one
     * extra fixed gid stored with the org, separate from the team
     * groups and from the org VM's `/home/shared` group. Allocated at
     * creation; legacy rows read `sharedGid + 1` on read
     * (`normalizeOrgState`).
     */
    orgSharedGid: opt(num()),
    /**
     * Size cap of `/home/org-shared` in bytes, default 1 GiB, owner
     * configurable. Enforced at the Spriessen tool path, not by a filesystem
     * quota: before and after every `bash` call the store is measured, and
     * over the cap the folder is remounted read-only in the VM (or, where
     * that fails, the call is refused) until usage is back under it. One
     * call may overshoot (docs/SECURITY.md, "Shared-folder caps").
     */
    orgSharedCapBytes: opt(num()),
    /**
     * Named hosts the org VM may reach (slice 3); everything else is denied,
     * including when the field is missing (legacy rows read an empty list).
     */
    netAllowlist: opt(NetAllowlistSchema),
    /** Full network access (no egress restrictions); legacy rows read false. */
    netOpen: opt(NetOpenSchema),
  },
  { open: true },
);

export type OrgInfo = Static<typeof OrgInfoSchema>;

/** One team: flat, no parent field, a home for bots and resources. */
export const TeamInfoSchema = obj(
  {
    id: str(),
    name: str(),
    createdAt: num(),
    vm: VmSettingsSchema,
    hostAccess: HostAccessSchema,
    /** Standing instructions inherited by the team's bots (before their own). */
    instructions: str(),
    /**
     * Gid of the team VM's shared-folder group (`/home/shared`): fixed
     * from 10000 up, never reused. Allocated at creation; rows stored before
     * the field existed get a deterministic value on read
     * (`normalizeOrgState`).
     */
    sharedGid: opt(num()),
    /**
     * Named hosts the team VM may reach (slice 3); everything else is
     * denied, including when the field is missing (legacy rows read []).
     */
    netAllowlist: opt(NetAllowlistSchema),
    /** Full network access (no egress restrictions); legacy rows read false. */
    netOpen: opt(NetOpenSchema),
    /**
     * Size cap of the team's shared store (its VM's `/home/shared`,
     * the org VM's `/home/team-shared/<id>`), default 1 GiB. Enforced the
     * same way as `orgSharedCapBytes`.
     */
    sharedCapBytes: opt(num()),
  },
  { open: true },
);

export type TeamInfo = Static<typeof TeamInfoSchema>;

/** A person's membership: one role, at org level (teamId null) or in one team. */
export const MemberInfoSchema = obj(
  {
    accountId: str(),
    role: OrgRoleSchema,
    /** null = the role is held at org level. */
    teamId: union([str(), nul()]),
  },
  { open: true },
);

export type MemberInfo = Static<typeof MemberInfoSchema>;

/**
 * A reach grant: permission for one home to use a NAMED resource of another
 * home (a vault item or a connector). Messaging needs no grant — open reach
 * (messaging only, owner decision 1 Nov 2026) covers it. Shared folders and
 * VMs never cross homes, so they need no grant either: they belong to their
 * home's own bots alone.
 */
export const GrantInfoSchema = obj(
  {
    id: str(),
    /** The resource being granted, with the home it belongs to. */
    resource: obj(
      {
        kind: oneOf(["vault-item", "connector"]),
        id: str(),
        home: HomeRefSchema,
      },
      { open: true },
    ),
    /** The home receiving the grant. */
    grantee: HomeRefSchema,
    action: lit("use"),
    createdAt: num(),
    createdBy: str(),
    /** Set the moment it is revoked; revoked grants stop working at once. */
    revokedAt: union([num(), nul()]),
  },
  { open: true },
);

export type GrantInfo = Static<typeof GrantInfoSchema>;

/**
 * What a template carries, by kind: `instructions` a text; `skill` its files
 * (path -> text); `bot` the profile definition id-free plus the two bot
 * files. A template never carries vault items, memory or chats.
 */
export const TemplatePayloadSchema = union([
  obj({ text: str() }, { open: true }),
  obj({ files: map(str()) }, { open: true }),
  obj({ name: str(), persona: str(), instructions: str() }, { open: true }),
]);

export type TemplatePayload = Static<typeof TemplatePayloadSchema>;

/** A published template (slice 8): a bot, a skill or an Instructions file another team can copy. */
export const TemplateInfoSchema = obj(
  {
    id: str(),
    kind: oneOf(["bot", "skill", "instructions"]),
    name: str(),
    /** The team that published it. */
    teamId: str(),
    payload: TemplatePayloadSchema,
    publishedAt: num(),
    /** Set when unpublished: new copies are refused, existing copies keep working. */
    unpublishedAt: union([num(), nul()]),
  },
  { open: true },
);

export type TemplateInfo = Static<typeof TemplateInfoSchema>;

/** The stored org document (ultiv.org): the org, its teams, members, grants and templates. */
export const OrgStateSchema = obj(
  {
    org: union([OrgInfoSchema, nul()]),
    teams: arr(TeamInfoSchema),
    members: arr(MemberInfoSchema),
    grants: arr(GrantInfoSchema),
    templates: arr(TemplateInfoSchema),
  },
  { open: true },
);

export type OrgState = Static<typeof OrgStateSchema>;

/** REST payloads. */
export const TeamCreateSchema = obj(
  {
    name: str({ minLength: 1, maxLength: 80 }),
    vm: opt(VmSettingsSchema),
    hostAccess: opt(bool()),
    instructions: opt(str({ maxLength: 16_000 })),
    netAllowlist: opt(NetAllowlistSchema),
    netOpen: opt(NetOpenSchema),
  },
  { open: true },
);

export type TeamCreate = Static<typeof TeamCreateSchema>;

export const TeamPatchSchema = obj(
  {
    name: opt(str({ minLength: 1, maxLength: 80 })),
    vm: opt(VmSettingsSchema),
    hostAccess: opt(bool()),
    instructions: opt(str({ maxLength: 16_000 })),
    netAllowlist: opt(NetAllowlistSchema),
    netOpen: opt(NetOpenSchema),
    sharedCapBytes: opt(int({ minimum: 1_048_576 })),
  },
  { open: true },
);

export type TeamPatch = Static<typeof TeamPatchSchema>;

export const MemberPutSchema = obj(
  {
    accountId: str({ minLength: 1 }),
    role: OrgRoleSchema,
    teamId: union([str(), nul()]),
  },
  { open: true },
);

export type MemberPut = Static<typeof MemberPutSchema>;

/**
 * A team summary (what the org owner or an org admin sees of a
 * team): counts, bots and recent activity — never chat contents.
 */
export const TeamSummarySchema = obj(
  {
    team: TeamInfoSchema,
    bots: arr(obj({ id: str(), name: str() }, { open: true })),
    archivedBots: num(),
    /** The newest audit activity timestamps per kind (tool calls, approvals), no content. */
    activity: obj(
      {
        lastToolCallAt: union([num(), nul()]),
        toolCalls7d: num(),
        openApprovals: num(),
      },
      { open: true },
    ),
  },
  { open: true },
);

export type TeamSummary = Static<typeof TeamSummarySchema>;
