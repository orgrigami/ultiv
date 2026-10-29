/**
 * Skills REST: the owner's surface over the per-profile skill stores: the
 * overview (built-in library plus each bot's namespace), one skill's detail
 * with its parked proposals, owner edits (origin "owner"), enable/disable,
 * revert, delete, and the accept/reject verdicts on evolution proposals.
 * Owner-scoped via `x-ultiv-user` like every route; every mutation lands in
 * the audit trail under kind "skills".
 */
import { errorOf, type RouteArgs } from "./types.ts";
import type { SkillMeta, SkillProposal } from "@ultiv/contracts";

const OWNER_ACT = "skills" as const;

const audited = async (
  args: RouteArgs,
  profile: string,
  name: string,
  run: () => Promise<unknown>,
): Promise<void> => {
  const startedAt = Date.now();
  try {
    await run();
    args.mind.audit.record({
      at: startedAt,
      kind: OWNER_ACT,
      conversationId: "",
      profile,
      callId: null,
      name,
      durationMs: Date.now() - startedAt,
      ok: true,
      error: null,
    });
  } catch (cause) {
    args.mind.audit.record({
      at: startedAt,
      kind: OWNER_ACT,
      conversationId: "",
      profile,
      callId: null,
      name,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: String(cause).slice(0, 200),
    });
    throw cause;
  }
};

/** The owner's whole skills view: built-ins, per-bot namespaces, open proposals. */
const overview = async (args: RouteArgs) => {
  const profiles = (await args.mind.profiles.list(args.owner)).filter(
    (profile) => profile.archivedAt === null,
  );
  const namespaces = await Promise.all(
    profiles.map(async (profile) => ({
      profile: profile.id,
      profileName: profile.name,
      skills: await args.mind.skills.list(args.owner, profile.id),
    })),
  );
  const proposals = await Promise.all(
    profiles.map((profile) => args.mind.skills.proposalsOf(args.owner, profile.id)),
  );
  return {
    builtins: await args.mind.skills.list(args.owner, "-"),
    profiles: namespaces,
    openProposals: proposals.flat().filter((proposal) => proposal.status === "open").length,
  };
};

/** The skills routes; returns false when the path is not ours. */
export async function skillRoutes(args: RouteArgs): Promise<boolean> {
  const { path, json } = args;
  const method = args.req.method ?? "GET";
  if (!path.startsWith("/api/skills") && !path.startsWith("/api/skills/")) return false;
  const detail = path.match(/^\/api\/skills\/([^/]+)\/([^/]+)$/);
  const proposal = path.match(/^\/api\/skills\/([^/]+)\/proposals\/([^/]+)\/(accept|reject)$/);
  const revert = path.match(/^\/api\/skills\/([^/]+)\/([^/]+)\/revert$/);
  try {
    if (path === "/api/skills" && method === "GET") {
      json(200, await overview(args));
      return true;
    }
    if (proposal !== null && method === "POST") {
      const [, profileId, id, verdict] = proposal;
      if (!(await knownProfile(args, profileId))) return notFound(json, "profile", profileId);
      let decided: SkillProposal | undefined;
      await audited(args, profileId ?? "", `skills.owner.proposal.${verdict}`, async () => {
        decided = await args.mind.skills.decide(
          args.owner,
          profileId ?? "",
          id ?? "",
          verdict === "accept" ? "accepted" : "rejected",
        );
      });
      if (decided === undefined) return notFound(json, "open proposal", id);
      json(200, { id: decided.id, status: decided.status });
      return true;
    }
    if (detail !== null && method === "GET") {
      const [, profileId, name] = detail;
      if (!(await knownProfile(args, profileId))) return notFound(json, "profile", profileId);
      const found = await args.mind.skills.read(args.owner, profileId ?? "", name ?? "");
      if (found === undefined) return notFound(json, "skill", name);
      json(200, found);
      return true;
    }
    if (detail !== null && method === "PUT") {
      const [, profileId, name] = detail;
      if (!(await knownProfile(args, profileId))) return notFound(json, "profile", profileId);
      const body = await args.readJson<{ body?: string; enabled?: boolean }>(args.req);
      let meta: SkillMeta | undefined;
      await audited(args, profileId ?? "", "skills.owner.write", async () => {
        if (typeof body.body === "string") {
          meta = await args.mind.skills.write(args.owner, profileId ?? "", {
            name: name ?? "",
            body: body.body,
            origin: "owner",
          });
        }
        if (body.enabled !== undefined) {
          meta = await args.mind.skills.setEnabled(
            args.owner,
            profileId ?? "",
            name ?? "",
            body.enabled,
          );
        }
        if (meta === undefined) throw new Error("nothing to change: send body and/or enabled");
      });
      json(200, meta);
      return true;
    }
    if (detail !== null && method === "DELETE") {
      const [, profileId, name] = detail;
      if (!(await knownProfile(args, profileId))) return notFound(json, "profile", profileId);
      let removed = false;
      await audited(args, profileId ?? "", "skills.owner.remove", async () => {
        removed = await args.mind.skills.remove(args.owner, profileId ?? "", name ?? "");
      });
      if (!removed) return notFound(json, "skill", name);
      json(200, { ok: true });
      return true;
    }
    if (revert !== null && method === "POST") {
      const [, profileId, name] = revert;
      if (!(await knownProfile(args, profileId))) return notFound(json, "profile", profileId);
      let meta: SkillMeta | undefined;
      await audited(args, profileId ?? "", "skills.owner.revert", async () => {
        meta = await args.mind.skills.revert(args.owner, profileId ?? "", name ?? "");
      });
      if (meta === undefined) return notFound(json, "revertable skill", name);
      json(200, meta);
      return true;
    }
    return false;
  } catch (cause) {
    json(400, { error: errorOf(cause) });
    return true;
  }
}

const knownProfile = async (args: RouteArgs, profileId: string | undefined): Promise<boolean> =>
  profileId !== undefined && (await args.mind.profiles.get(args.owner, profileId)) !== undefined;

const notFound = (json: RouteArgs["json"], what: string, id: string | undefined): boolean => {
  json(404, { error: `no ${what}: ${id ?? ""}` });
  return true;
};
