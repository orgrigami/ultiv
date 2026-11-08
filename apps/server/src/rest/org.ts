/**
 * Org routes: the org row, its flat teams and their members. Every
 * permission question goes through `may()` (which asks `can()`) — these
 * routes only shape the answers. A team another role may not touch
 * reads as a missing one, like every scoped route.
 */
import type { TeamInfo, TeamSummary, HomeRef, VmSettings } from "@spriessen/contracts";
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

/** One `permission` audit row (org and team state changes). */
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
  teams: readonly TeamInfo[],
  changedId?: string,
): string | null =>
  vmCapacityProblem(
    totalVmMemoryMiB([
      changedId === undefined ? (candidate ?? org) : org,
      ...teams.map((row) => (row.id === changedId && candidate !== undefined ? candidate : row.vm)),
    ]),
    totalmem(),
  );

/**
 * The caller's VM size once `vmSettingsProblem` passed (both fields are
 * whole numbers in range, so the cast only restores that knowledge).
 */
const readVm = (input: { cpus?: number; memoryMiB?: number } | undefined): VmSettings | undefined =>
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
    const capProblem = vm === undefined ? null : capacityProblem(vm, view.org.vm, view.teams);
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
  if (path === "/api/org/teams" && method === "POST") {
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
      return (json(400, { error: "a team needs a name" }), true);
    }
    const vmProblem = body.vm === undefined ? null : vmSettingsProblem(body.vm);
    if (vmProblem !== null) return (json(400, { error: vmProblem }), true);
    const vm = readVm(body.vm);
    const allowProblem =
      body.netAllowlist === undefined ? null : netAllowlistProblem(body.netAllowlist);
    if (allowProblem !== null) return (json(400, { error: allowProblem }), true);
    const view = await mind.org.view();
    if (view.org === null) return (json(404, { error: "the org does not exist yet" }), true);
    const capProblem = vm === undefined ? null : capacityProblem(vm, view.org.vm, view.teams);
    if (capProblem !== null) return (json(400, { error: capProblem }), true);
    try {
      const team = await mind.org.createTeam(
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
      audited(args, "team-created");
      return (json(200, team), true);
    } catch (cause) {
      return (json(400, { error: errorOf(cause) }), true);
    }
  }
  if (path.startsWith("/api/org/teams/") && method === "PATCH") {
    const id = segment("/api/org/teams/");
    const view = await mind.org.view();
    if (!view.teams.some((row) => row.id === id)) {
      return (json(404, { error: "unknown team" }), true);
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
    // A team's admins manage its state (its VM's network allowlist
    // included, slice 3), but a host-access switch is the org owner's alone
    // (F3); a member reads as missing either way.
    if (
      body.hostAccess !== undefined
        ? !(await may(args, "change", { type: "host-flag" }))
        : !(await may(args, "change", { type: "team", teamId: id }))
    ) {
      return (json(404, { error: "unknown team" }), true);
    }
    const vmProblem = body.vm === undefined ? null : vmSettingsProblem(body.vm);
    if (vmProblem !== null) return (json(400, { error: vmProblem }), true);
    const vm = readVm(body.vm);
    const capProblem =
      vm === undefined || view.org === null
        ? null
        : capacityProblem(vm, view.org.vm, view.teams, id);
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
      const team = await mind.org.updateTeam(id, {
        ...(body.name !== undefined ? { name: body.name.trim().slice(0, 80) } : {}),
        ...(vm !== undefined ? { vm } : {}),
        ...(body.hostAccess !== undefined ? { hostAccess: body.hostAccess } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.netAllowlist !== undefined ? { netAllowlist: body.netAllowlist } : {}),
        ...(body.netOpen !== undefined ? { netOpen: body.netOpen } : {}),
        ...(body.sharedCapBytes !== undefined ? { sharedCapBytes: body.sharedCapBytes } : {}),
      });
      if (body.hostAccess !== undefined) {
        audited(args, "team-host-access");
      }
      if (body.netAllowlist !== undefined) audited(args, "team-net-allowlist");
      if (body.netOpen !== undefined) audited(args, "team-net-open");
      if (body.sharedCapBytes !== undefined) audited(args, "team-shared-cap");
      return (json(200, body.vm !== undefined ? { ...team, vmNote: VM_CHANGE_NOTE } : team), true);
    } catch (cause) {
      return (json(400, { error: errorOf(cause) }), true);
    }
  }
  if (path.startsWith("/api/org/teams/") && method === "DELETE") {
    const id = segment("/api/org/teams/");
    const view = await mind.org.view();
    if (!view.teams.some((row) => row.id === id)) {
      return (json(404, { error: "unknown team" }), true);
    }
    if (!(await may(args, "remove", { type: "team", teamId: id }))) {
      return (json(404, { error: "unknown team" }), true);
    }
    try {
      const ok = await mind.org.removeTeam(id);
      if (ok) audited(args, "team-removed");
      return (json(200, { ok }), true);
    } catch (cause) {
      return (json(400, { error: errorOf(cause) }), true);
    }
  }
  if (path.startsWith("/api/org/teams/") && path.endsWith("/summary") && method === "GET") {
    const id = segment("/api/org/teams/").replace(/\/summary$/, "");
    const view = await mind.org.view();
    const team = view.teams.find((row) => row.id === id);
    if (team === undefined) {
      return (json(404, { error: "unknown team" }), true);
    }
    if (!(await may(args, "view", { type: "team-summary", teamId: id }))) {
      return (json(404, { error: "unknown team" }), true);
    }
    return (json(200, await teamSummary(args, team)), true);
  }
  if (path === "/api/org/host-access" && method === "GET") {
    // The effective matrix (slice 11): org AND team AND bot for a
    // team bot; org AND bot for an org bot; blockedBy names the level
    // that blocks (F4).
    const view = await mind.org.view();
    const bots = await mind.profiles.list(args.owner);
    return (
      json(200, {
        org: view.org === null ? null : { hostAccess: view.org.hostAccess },
        bots: bots.map((profile) => {
          const verdict = effectiveHostAccess(view.org, view.teams, profile);
          return {
            profileId: profile.id,
            teamId: profile.teamId ?? null,
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
    home.kind === "org" ? view.org !== null : view.teams.some((row) => row.id === home.teamId),
  );
};

/**
 * The team digest: counts, bot names, activity timestamps. Metadata
 * only — never a chat's contents (slice 4).
 */
const teamSummary = async (args: RouteArgs, team: TeamInfo): Promise<TeamSummary> => {
  const { mind } = args;
  const bots = (await mind.profiles.list(args.owner)).filter(
    (profile) => profile.teamId === team.id,
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
    team,
    bots: active.map((profile) => ({ id: profile.id, name: profile.name })),
    archivedBots: bots.length - active.length,
    activity: {
      lastToolCallAt: calls.reduce<number | null>((last, event) => event.at, null),
      toolCalls7d: calls.length,
      openApprovals: pending.length,
    },
  };
};
