/**
 * Org routes: the org row, its flat departments and their members. Every
 * permission question goes through `may()` (which asks `can()`) — these
 * routes only shape the answers. A department another role may not touch
 * reads as a missing one, like every scoped route.
 */
import type { DepartmentInfo, DepartmentSummary, HomeRef, VmSettings } from "@spriessen/contracts";
import {
  netAllowlistProblem,
  totalVmMemoryMiB,
  VM_CHANGE_NOTE,
  vmCapacityProblem,
  vmSettingsProblem,
} from "@spriessen/contracts";
import { effectiveHostAccess } from "@spriessen/mind";
import { totalmem } from "node:os";
import { may } from "./ask.ts";
import { errorOf, type RouteArgs } from "./types.ts";

/** One `permission` audit row (org and department state changes). */
const audited = (args: RouteArgs, name: string): void => {
  args.mind.audit.record({
    at: Date.now(),
    kind: "permission",
    conversationId: "",
    profile: null,
    callId: null,
    name,
    durationMs: null,
    ok: true,
    error: null,
  });
};

/**
 * The slice 4 host-capacity check over REST: with the candidate applied,
 * the CONFIGURED memory of all homes' VMs must stay within half the host's
 * RAM. A configured-sum heuristic over stored settings, never a live
 * measurement (the mind service applies the same rule).
 */
const capacityProblem = (
  candidate: VmSettings | undefined,
  org: VmSettings,
  departments: readonly DepartmentInfo[],
  changedId?: string,
): string | null =>
  vmCapacityProblem(
    totalVmMemoryMiB([
      changedId === undefined ? (candidate ?? org) : org,
      ...departments.map((row) =>
        row.id === changedId && candidate !== undefined ? candidate : row.vm,
      ),
    ]),
    totalmem(),
  );

/**
 * The caller's VM size once `vmSettingsProblem` passed (both fields are
 * whole numbers in range, so the cast only restores that knowledge).
 */
const readVm = (
  input: { cpus?: number; memoryMiB?: number } | undefined,
): VmSettings | undefined =>
  input === undefined
    ? undefined
    : ({ cpus: input.cpus, memoryMiB: input.memoryMiB } as VmSettings);

export async function orgRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json, owner } = args;
  const method = req.method ?? "GET";
  const segment = (after: string): string => decodeURIComponent(path.slice(after.length));

  if (path === "/api/org" && method === "GET") {
    const view = await mind.org.view();
    return (json(200, view), true);
  }
  if (path === "/api/org" && method === "PATCH") {
    const body = await args.readJson<{
      name?: string;
      vm?: { cpus?: number; memoryMiB?: number };
      hostAccess?: boolean;
      orgSharedCapBytes?: number;
      netAllowlist?: string[];
      netOpen?: boolean;
    }>(req);
    if (body.hostAccess !== undefined && !(await may(args, "change", { type: "host-flag" }))) {
      return (json(404, { error: "no route: PATCH /api/org" }), true);
    }
    if (
      (body.name !== undefined ||
        body.vm !== undefined ||
        body.orgSharedCapBytes !== undefined ||
        body.netAllowlist !== undefined ||
        body.netOpen !== undefined) &&
      !(await may(args, "change", { type: "org-settings" }))
    ) {
      return (json(404, { error: "no route: PATCH /api/org" }), true);
    }
    const view = await mind.org.view();
    if (view.org === null) return (json(404, { error: "the org does not exist yet" }), true);
    const vmProblem = body.vm === undefined ? null : vmSettingsProblem(body.vm);
    if (vmProblem !== null) return (json(400, { error: vmProblem }), true);
    const vm = readVm(body.vm);
    const capProblem = vm === undefined ? null : capacityProblem(vm, view.org.vm, view.departments);
    if (capProblem !== null) return (json(400, { error: capProblem }), true);
    if (
      body.orgSharedCapBytes !== undefined &&
      (!Number.isInteger(body.orgSharedCapBytes) || body.orgSharedCapBytes < 1_048_576)
    ) {
      return (
        json(400, { error: "orgSharedCapBytes must be a whole number of at least 1 MiB" }), true
      );
    }
    const allowProblem =
      body.netAllowlist === undefined ? null : netAllowlistProblem(body.netAllowlist);
    if (allowProblem !== null) return (json(400, { error: allowProblem }), true);
    if (body.netOpen !== undefined && typeof body.netOpen !== "boolean") {
      return (json(400, { error: "netOpen must be true or false" }), true);
    }
    const org = await mind.org.updateOrg({
      ...(body.name !== undefined ? { name: body.name.trim().slice(0, 80) } : {}),
      ...(vm !== undefined ? { vm } : {}),
      ...(body.hostAccess !== undefined ? { hostAccess: body.hostAccess } : {}),
      ...(body.orgSharedCapBytes !== undefined
        ? { orgSharedCapBytes: body.orgSharedCapBytes }
        : {}),
      ...(body.netAllowlist !== undefined ? { netAllowlist: body.netAllowlist } : {}),
      ...(body.netOpen !== undefined ? { netOpen: body.netOpen } : {}),
    });
    if (body.hostAccess !== undefined) audited(args, "org-host-access");
    if (body.netAllowlist !== undefined) audited(args, "org-net-allowlist");
    if (body.netOpen !== undefined) audited(args, "org-net-open");
    return (json(200, body.vm !== undefined ? { ...org, vmNote: VM_CHANGE_NOTE } : org), true);
  }
  if (path === "/api/org/departments" && method === "POST") {
    if (!(await may(args, "change", { type: "org-settings" }))) {
      return (json(404, { error: "unknown route" }), true);
    }
    const body = await args.readJson<{
      name?: string;
      vm?: { cpus?: number; memoryMiB?: number };
      hostAccess?: boolean;
      instructions?: string;
      netAllowlist?: string[];
      netOpen?: boolean;
    }>(req);
    if (body.name === undefined || body.name.trim() === "") {
      return (json(400, { error: "a department needs a name" }), true);
    }
    const vmProblem = body.vm === undefined ? null : vmSettingsProblem(body.vm);
    if (vmProblem !== null) return (json(400, { error: vmProblem }), true);
    const vm = readVm(body.vm);
    const allowProblem =
      body.netAllowlist === undefined ? null : netAllowlistProblem(body.netAllowlist);
    if (allowProblem !== null) return (json(400, { error: allowProblem }), true);
    const view = await mind.org.view();
    if (view.org === null) return (json(404, { error: "the org does not exist yet" }), true);
    const capProblem = vm === undefined ? null : capacityProblem(vm, view.org.vm, view.departments);
    if (capProblem !== null) return (json(400, { error: capProblem }), true);
    try {
      const department = await mind.org.createDepartment(
        {
          name: body.name.trim().slice(0, 80),
          ...(vm !== undefined ? { vm } : {}),
          ...(body.hostAccess !== undefined ? { hostAccess: body.hostAccess } : {}),
          ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
          ...(body.netAllowlist !== undefined ? { netAllowlist: body.netAllowlist } : {}),
          ...(body.netOpen !== undefined ? { netOpen: body.netOpen } : {}),
        },
        owner,
      );
      audited(args, "department-created");
      return (json(200, department), true);
    } catch (cause) {
      return (json(400, { error: errorOf(cause) }), true);
    }
  }
  if (path.startsWith("/api/org/departments/") && method === "PATCH") {
    const id = segment("/api/org/departments/");
    const view = await mind.org.view();
    if (!view.departments.some((row) => row.id === id)) {
      return (json(404, { error: "unknown department" }), true);
    }
    const body = await args.readJson<{
      name?: string;
      vm?: { cpus?: number; memoryMiB?: number };
      hostAccess?: boolean;
      instructions?: string;
      netAllowlist?: string[];
      netOpen?: boolean;
      sharedCapBytes?: number;
    }>(req);
    // A department's admins manage its state (its VM's network allowlist
    // included, slice 3), but a host-access switch is the org owner's alone
    // (F3); a member reads as missing either way.
    if (
      body.hostAccess !== undefined
        ? !(await may(args, "change", { type: "host-flag" }))
        : !(await may(args, "change", { type: "department", departmentId: id }))
    ) {
      return (json(404, { error: "unknown department" }), true);
    }
    const vmProblem = body.vm === undefined ? null : vmSettingsProblem(body.vm);
    if (vmProblem !== null) return (json(400, { error: vmProblem }), true);
    const vm = readVm(body.vm);
    const capProblem =
      vm === undefined || view.org === null
        ? null
        : capacityProblem(vm, view.org.vm, view.departments, id);
    if (capProblem !== null) return (json(400, { error: capProblem }), true);
    const allowProblem =
      body.netAllowlist === undefined ? null : netAllowlistProblem(body.netAllowlist);
    if (allowProblem !== null) return (json(400, { error: allowProblem }), true);
    if (
      body.sharedCapBytes !== undefined &&
      (!Number.isInteger(body.sharedCapBytes) || body.sharedCapBytes < 1_048_576)
    ) {
      return (
        json(400, { error: "sharedCapBytes must be a whole number of at least 1 MiB" }), true
      );
    }
    try {
      const department = await mind.org.updateDepartment(id, {
        ...(body.name !== undefined ? { name: body.name.trim().slice(0, 80) } : {}),
        ...(vm !== undefined ? { vm } : {}),
        ...(body.hostAccess !== undefined ? { hostAccess: body.hostAccess } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.netAllowlist !== undefined ? { netAllowlist: body.netAllowlist } : {}),
        ...(body.netOpen !== undefined ? { netOpen: body.netOpen } : {}),
        ...(body.sharedCapBytes !== undefined ? { sharedCapBytes: body.sharedCapBytes } : {}),
      });
      if (body.hostAccess !== undefined) {
        audited(args, "department-host-access");
      }
      if (body.netAllowlist !== undefined) audited(args, "department-net-allowlist");
      if (body.netOpen !== undefined) audited(args, "department-net-open");
      if (body.sharedCapBytes !== undefined) audited(args, "department-shared-cap");
      return (
        json(200, body.vm !== undefined ? { ...department, vmNote: VM_CHANGE_NOTE } : department),
        true
      );
    } catch (cause) {
      return (json(400, { error: errorOf(cause) }), true);
    }
  }
  if (path.startsWith("/api/org/departments/") && method === "DELETE") {
    const id = segment("/api/org/departments/");
    const view = await mind.org.view();
    if (!view.departments.some((row) => row.id === id)) {
      return (json(404, { error: "unknown department" }), true);
    }
    if (!(await may(args, "remove", { type: "department", departmentId: id }))) {
      return (json(404, { error: "unknown department" }), true);
    }
    try {
      const ok = await mind.org.removeDepartment(id);
      if (ok) audited(args, "department-removed");
      return (json(200, { ok }), true);
    } catch (cause) {
      return (json(400, { error: errorOf(cause) }), true);
    }
  }
  if (path.startsWith("/api/org/departments/") && path.endsWith("/summary") && method === "GET") {
    const id = segment("/api/org/departments/").replace(/\/summary$/, "");
    const view = await mind.org.view();
    const department = view.departments.find((row) => row.id === id);
    if (department === undefined) {
      return (json(404, { error: "unknown department" }), true);
    }
    if (!(await may(args, "view", { type: "department-summary", departmentId: id }))) {
      return (json(404, { error: "unknown department" }), true);
    }
    return (json(200, await departmentSummary(args, department)), true);
  }
  if (path === "/api/org/host-access" && method === "GET") {
    // The effective matrix (slice 11): org AND department AND bot for a
    // department bot; org AND bot for an org bot; blockedBy names the level
    // that blocks (F4).
    const view = await mind.org.view();
    const bots = await mind.profiles.list(args.owner);
    return (
      json(200, {
        org: view.org === null ? null : { hostAccess: view.org.hostAccess },
        bots: bots.map((profile) => {
          const verdict = effectiveHostAccess(view.org, view.departments, profile);
          return {
            profileId: profile.id,
            departmentId: profile.departmentId ?? null,
            own: profile.hostAccess ?? false,
            allowed: verdict.allowed,
            blockedBy: verdict.blockedBy,
          };
        }),
      }),
      true
    );
  }
  if (path === "/api/org/grants" && method === "GET") {
    // Grants touch homes; the org level sees them all.
    if (!(await may(args, "view", { type: "org-settings" }))) {
      return (json(404, { error: "no route: GET /api/org/grants" }), true);
    }
    return (json(200, await mind.org.activeGrants()), true);
  }
  if (path === "/api/org/grants" && method === "POST") {
    const body = await args.readJson<{
      resource?: { kind?: string; id?: string; home?: HomeRef };
      grantee?: HomeRef;
    }>(req);
    const resource = body.resource;
    if (
      resource === undefined ||
      (resource.kind !== "vault-item" && resource.kind !== "connector") ||
      resource.id === undefined ||
      resource.home === undefined ||
      body.grantee === undefined
    ) {
      return (
        json(400, {
          error: "a grant needs resource {kind: vault-item|connector, id, home} and a grantee home",
        }),
        true
      );
    }
    if (!(await may(args, "change", { type: "grant", home: resource.home }))) {
      return (json(404, { error: "unknown route" }), true);
    }
    if (!(await homesExist(mind, resource.home, body.grantee))) {
      return (json(400, { error: "unknown home in grant" }), true);
    }
    const grant = await mind.org.addGrant(
      { kind: resource.kind, id: resource.id, home: resource.home },
      body.grantee,
      args.owner,
    );
    audited(args, "grant-created");
    return (json(200, grant), true);
  }
  if (path.startsWith("/api/org/grants/") && method === "DELETE") {
    const id = segment("/api/org/grants/");
    const grants = await mind.org.activeGrants();
    const grant = grants.find((row) => row.id === id);
    if (grant === undefined) return (json(404, { error: "unknown grant" }), true);
    if (!(await may(args, "change", { type: "grant", home: grant.resource.home }))) {
      return (json(404, { error: "unknown grant" }), true);
    }
    const ok = await mind.org.revokeGrant(id);
    if (ok) audited(args, "grant-revoked");
    return (json(200, { ok }), true);
  }
  return false;
}

/** Both homes of a grant must exist (the org counts as a home). */
const homesExist = async (mind: RouteArgs["mind"], ...homes: HomeRef[]): Promise<boolean> => {
  const view = await mind.org.view();
  return homes.every((home) =>
    home.kind === "org"
      ? view.org !== null
      : view.departments.some((row) => row.id === home.departmentId),
  );
};

/**
 * The department digest: counts, bot names, activity timestamps. Metadata
 * only — never a chat's contents (slice 4).
 */
const departmentSummary = async (
  args: RouteArgs,
  department: DepartmentInfo,
): Promise<DepartmentSummary> => {
  const { mind } = args;
  const bots = (await mind.profiles.list(args.owner)).filter(
    (profile) => profile.departmentId === department.id,
  );
  const active = bots.filter((profile) => profile.archivedAt === null);
  const ids = new Set(bots.map((profile) => profile.id));
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const calls = mind.audit.find(
    (event) => event.kind === "tool_call" && event.profile !== null && ids.has(event.profile),
    { limit: Number.MAX_SAFE_INTEGER, since: weekAgo },
  );
  const pending = (await mind.approvals.pendingAll()).filter((entry) => {
    const scope = mind.profiles.scopeOf(entry.conversationId);
    return scope !== undefined && ids.has(scope.profileId);
  });
  return {
    department,
    bots: active.map((profile) => ({ id: profile.id, name: profile.name })),
    archivedBots: bots.length - active.length,
    activity: {
      lastToolCallAt: calls.reduce<number | null>((last, event) => event.at, null),
      toolCalls7d: calls.length,
      openApprovals: pending.length,
    },
  };
};
