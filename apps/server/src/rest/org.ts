/**
 * Org routes: the org row, its flat departments and their members. Every
 * permission question goes through `may()` (which asks `can()`) — these
 * routes only shape the answers. A department another role may not touch
 * reads as a missing one, like every scoped route.
 */
import type { DepartmentInfo, DepartmentSummary, VmSettings } from "@spriessen/contracts";
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

/** A caller-supplied VM size, validated; `undefined` when not given, null when malformed. */
const readVm = (
  input: { cpus?: number; memoryMiB?: number } | undefined,
): VmSettings | null | undefined => {
  if (input === undefined) return undefined;
  const cpus = input.cpus;
  const memoryMiB = input.memoryMiB;
  if (
    typeof cpus !== "number" ||
    !Number.isInteger(cpus) ||
    cpus < 1 ||
    typeof memoryMiB !== "number" ||
    !Number.isInteger(memoryMiB) ||
    memoryMiB < 128
  ) {
    return null;
  }
  return { cpus, memoryMiB };
};

export async function orgRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json, owner } = args;
  const method = req.method ?? "GET";
  const segment = (after: string): string => decodeURIComponent(path.slice(after.length));

  if (path === "/api/org" && method === "GET") {
    const view = await mind.org.view();
    return (json(200, view), true);
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
    }>(req);
    if (body.name === undefined || body.name.trim() === "") {
      return (json(400, { error: "a department needs a name" }), true);
    }
    const vm = readVm(body.vm);
    if (vm === null) {
      return (json(400, { error: "vm needs integer cpus (>= 1) and memoryMiB (>= 128)" }), true);
    }
    try {
      const department = await mind.org.createDepartment(
        {
          name: body.name.trim().slice(0, 80),
          ...(vm !== undefined ? { vm } : {}),
          ...(body.hostAccess !== undefined ? { hostAccess: body.hostAccess } : {}),
          ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
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
    if (!(await may(args, "change", { type: "department", departmentId: id }))) {
      return (json(404, { error: "unknown department" }), true);
    }
    const body = await args.readJson<{
      name?: string;
      vm?: { cpus?: number; memoryMiB?: number };
      hostAccess?: boolean;
      instructions?: string;
    }>(req);
    const vm = readVm(body.vm);
    if (vm === null) {
      return (json(400, { error: "vm needs integer cpus (>= 1) and memoryMiB (>= 128)" }), true);
    }
    try {
      const department = await mind.org.updateDepartment(id, {
        ...(body.name !== undefined ? { name: body.name.trim().slice(0, 80) } : {}),
        ...(vm !== undefined ? { vm } : {}),
        ...(body.hostAccess !== undefined ? { hostAccess: body.hostAccess } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
      });
      if (body.hostAccess !== undefined) {
        audited(args, "department-host-access");
      }
      return (json(200, department), true);
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
  return false;
}

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
  const calls = mind.audit
    .tail(5_000)
    .filter(
      (event) =>
        event.kind === "tool_call" &&
        event.profile !== null &&
        ids.has(event.profile) &&
        event.at >= weekAgo,
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
