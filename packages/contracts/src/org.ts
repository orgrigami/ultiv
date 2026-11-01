import { Type, type Static } from "typebox";

/**
 * The org: one per install, holding flat departments (also called teams) and
 * bots. Every bot has exactly one home — one department, or the org itself
 * (an "org bot"). Departments have no parent; no nesting, no depth.
 */

/** A member role. Held at org level (departmentId null) or per department. */
export const OrgRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);

export type OrgRole = Static<typeof OrgRoleSchema>;

/** Where a bot, or a bot-owned resource, lives: the org, or one department. */
export const HomeRefSchema = Type.Union([
  Type.Object({ kind: Type.Literal("org") }),
  Type.Object({ kind: Type.Literal("department"), departmentId: Type.String() }),
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

export const VmSettingsSchema = Type.Object({
  cpus: Type.Number({ minimum: VM_CPUS_MIN, maximum: VM_CPUS_MAX }),
  memoryMiB: Type.Number({ minimum: VM_MEMORY_MIB_MIN, maximum: VM_MEMORY_MIB_MAX }),
});

export type VmSettings = Static<typeof VmSettingsSchema>;

export const DEFAULT_VM: VmSettings = { cpus: 1, memoryMiB: 512 };

/**
 * The host-capacity rule (slice 4): the CONFIGURED memory of all homes' VMs
 * (the org's plus every department's, defaults included) may reach at most
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

/** The default size cap of a department's shared folder (its store). */
export const DEFAULT_DEPT_SHARED_CAP_BYTES = 1_073_741_824;

/** The smallest accepted shared-folder cap (1 MiB). */
export const MIN_SHARED_CAP_BYTES = 1_048_576;

/** Whether bots of this home may run tools on the server's own machine. */
export const HostAccessSchema = Type.Boolean();

/**
 * The per-VM network allowlist (phase 4 slice 3): named hosts the home's VM
 * may reach. Everything else is denied — the DEFAULT for both the org VM and
 * every department VM is NO network. An empty list means fully offline.
 */
export const NetAllowlistSchema = Type.Array(Type.String(), { maxItems: 64 });

export type NetAllowlist = Static<typeof NetAllowlistSchema>;

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
export const OrgInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  owner: Type.String(),
  createdAt: Type.Number(),
  vm: VmSettingsSchema,
  /** Host access for the org level; the migration sets it true (today's behaviour). */
  hostAccess: HostAccessSchema,
  /**
   * Gid of the org VM's shared-folder group (`/home/shared`): fixed from
   * 10000 up, never reused. Allocated at creation; rows stored before the
   * field existed get a deterministic value on read (`normalizeOrgState`).
   */
  sharedGid: Type.Optional(Type.Number()),
  /**
   * Gid of the org-wide folder's group (`/home/org-shared`, slice 2c): one
   * extra fixed gid stored with the org, separate from the department
   * groups and from the org VM's `/home/shared` group. Allocated at
   * creation; legacy rows read `sharedGid + 1` on read
   * (`normalizeOrgState`).
   */
  orgSharedGid: Type.Optional(Type.Number()),
  /**
   * Size cap of `/home/org-shared` in bytes, default 1 GiB, owner
   * configurable. Enforced at the Spriessen tool path, not by a filesystem
   * quota: before and after every `bash` call the store is measured, and
   * over the cap the folder is remounted read-only in the VM (or, where
   * that fails, the call is refused) until usage is back under it. One
   * call may overshoot (docs/SECURITY.md, "Shared-folder caps").
   */
  orgSharedCapBytes: Type.Optional(Type.Number()),
  /**
   * Named hosts the org VM may reach (slice 3); everything else is denied,
   * including when the field is missing (legacy rows read an empty list).
   */
  netAllowlist: Type.Optional(NetAllowlistSchema),
});

export type OrgInfo = Static<typeof OrgInfoSchema>;

/** One department: flat, no parent field, a home for bots and resources. */
export const DepartmentInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  createdAt: Type.Number(),
  vm: VmSettingsSchema,
  hostAccess: HostAccessSchema,
  /** Standing instructions inherited by the department's bots (before their own). */
  instructions: Type.String(),
  /**
   * Gid of the department VM's shared-folder group (`/home/shared`): fixed
   * from 10000 up, never reused. Allocated at creation; rows stored before
   * the field existed get a deterministic value on read
   * (`normalizeOrgState`).
   */
  sharedGid: Type.Optional(Type.Number()),
  /**
   * Named hosts the department VM may reach (slice 3); everything else is
   * denied, including when the field is missing (legacy rows read []).
   */
  netAllowlist: Type.Optional(NetAllowlistSchema),
  /**
   * Size cap of the department's shared store (its VM's `/home/shared`,
   * the org VM's `/home/dept-shared/<id>`), default 1 GiB. Enforced the
   * same way as `orgSharedCapBytes`.
   */
  sharedCapBytes: Type.Optional(Type.Number()),
});

export type DepartmentInfo = Static<typeof DepartmentInfoSchema>;

/** A person's membership: one role, at org level (departmentId null) or in one department. */
export const MemberInfoSchema = Type.Object({
  accountId: Type.String(),
  role: OrgRoleSchema,
  /** null = the role is held at org level. */
  departmentId: Type.Union([Type.String(), Type.Null()]),
});

export type MemberInfo = Static<typeof MemberInfoSchema>;

/**
 * A reach grant: permission for one home to use a NAMED resource of another
 * home (a vault item or a connector). Messaging needs no grant — open reach
 * (messaging only, owner decision 1 Nov 2026) covers it. Shared folders and
 * VMs never cross homes, so they need no grant either: they belong to their
 * home's own bots alone.
 */
export const GrantInfoSchema = Type.Object({
  id: Type.String(),
  /** The resource being granted, with the home it belongs to. */
  resource: Type.Object({
    kind: Type.Union([Type.Literal("vault-item"), Type.Literal("connector")]),
    id: Type.String(),
    home: HomeRefSchema,
  }),
  /** The home receiving the grant. */
  grantee: HomeRefSchema,
  action: Type.Literal("use"),
  createdAt: Type.Number(),
  createdBy: Type.String(),
  /** Set the moment it is revoked; revoked grants stop working at once. */
  revokedAt: Type.Union([Type.Number(), Type.Null()]),
});

export type GrantInfo = Static<typeof GrantInfoSchema>;

/**
 * What a template carries, by kind: `instructions` a text; `skill` its files
 * (path -> text); `bot` the profile definition id-free plus the two bot
 * files. A template never carries vault items, memory or chats.
 */
export const TemplatePayloadSchema = Type.Union([
  Type.Object({ text: Type.String() }),
  Type.Object({ files: Type.Record(Type.String(), Type.String()) }),
  Type.Object({ name: Type.String(), persona: Type.String(), instructions: Type.String() }),
]);

export type TemplatePayload = Static<typeof TemplatePayloadSchema>;

/** A published template (slice 8): a bot, a skill or an Instructions file another department can copy. */
export const TemplateInfoSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("bot"), Type.Literal("skill"), Type.Literal("instructions")]),
  name: Type.String(),
  /** The department that published it. */
  departmentId: Type.String(),
  payload: TemplatePayloadSchema,
  publishedAt: Type.Number(),
  /** Set when unpublished: new copies are refused, existing copies keep working. */
  unpublishedAt: Type.Union([Type.Number(), Type.Null()]),
});

export type TemplateInfo = Static<typeof TemplateInfoSchema>;

/** The stored org document (ultiv.org): the org, its departments, members, grants and templates. */
export const OrgStateSchema = Type.Object({
  org: Type.Union([OrgInfoSchema, Type.Null()]),
  departments: Type.Array(DepartmentInfoSchema),
  members: Type.Array(MemberInfoSchema),
  grants: Type.Array(GrantInfoSchema),
  templates: Type.Array(TemplateInfoSchema),
});

export type OrgState = Static<typeof OrgStateSchema>;

/** REST payloads. */
export const DepartmentCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  vm: Type.Optional(VmSettingsSchema),
  hostAccess: Type.Optional(Type.Boolean()),
  instructions: Type.Optional(Type.String({ maxLength: 16_000 })),
  netAllowlist: Type.Optional(NetAllowlistSchema),
});

export type DepartmentCreate = Static<typeof DepartmentCreateSchema>;

export const DepartmentPatchSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  vm: Type.Optional(VmSettingsSchema),
  hostAccess: Type.Optional(Type.Boolean()),
  instructions: Type.Optional(Type.String({ maxLength: 16_000 })),
  netAllowlist: Type.Optional(NetAllowlistSchema),
  sharedCapBytes: Type.Optional(Type.Integer({ minimum: 1_048_576 })),
});

export type DepartmentPatch = Static<typeof DepartmentPatchSchema>;

export const MemberPutSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  role: OrgRoleSchema,
  departmentId: Type.Union([Type.String(), Type.Null()]),
});

export type MemberPut = Static<typeof MemberPutSchema>;

/**
 * A department summary (what the org owner or an org admin sees of a
 * department): counts, bots and recent activity — never chat contents.
 */
export const DepartmentSummarySchema = Type.Object({
  department: DepartmentInfoSchema,
  bots: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
  archivedBots: Type.Number(),
  /** The newest audit activity timestamps per kind (tool calls, approvals), no content. */
  activity: Type.Object({
    lastToolCallAt: Type.Union([Type.Number(), Type.Null()]),
    toolCalls7d: Type.Number(),
    openApprovals: Type.Number(),
  }),
});

export type DepartmentSummary = Static<typeof DepartmentSummarySchema>;
