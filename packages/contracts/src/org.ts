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
 * defaults 1 CPU and 512 MiB.
 */
export const VmSettingsSchema = Type.Object({
  cpus: Type.Number({ minimum: 1, maximum: 64 }),
  memoryMiB: Type.Number({ minimum: 128, maximum: 65_536 }),
});

export type VmSettings = Static<typeof VmSettingsSchema>;

export const DEFAULT_VM: VmSettings = { cpus: 1, memoryMiB: 512 };

/** The default size cap of the org-wide shared folder (slice 2c). */
export const DEFAULT_ORG_SHARED_CAP_BYTES = 1_073_741_824;

/** Whether bots of this home may run tools on the server's own machine. */
export const HostAccessSchema = Type.Boolean();

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
   * configurable. Enforced where the server mediates writes; `bash` writes
   * into the bind mount are not mediated (docs/SECURITY.md).
   */
  orgSharedCapBytes: Type.Optional(Type.Number()),
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
});

export type DepartmentCreate = Static<typeof DepartmentCreateSchema>;

export const DepartmentPatchSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  vm: Type.Optional(VmSettingsSchema),
  hostAccess: Type.Optional(Type.Boolean()),
  instructions: Type.Optional(Type.String({ maxLength: 16_000 })),
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
