/**
 * Artifact routes over the per-profile partitioned workspace:
 * ARTIFACTS_DIR/{owner}/{profile}/, with the flat root kept for legacy
 * sidecars (owner null — uuid-capability access, exactly as before).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  artifactFile,
  artifactsDir,
  clearArtifacts,
  deleteArtifact,
  listArtifacts,
  mimeOfName,
  readArtifactInfo,
  searchArtifacts,
  writeArtifact,
} from "@ultiv/ext";
import { queryOr, type RouteArgs } from "./types.ts";

/** Every directory the owner's artifacts may live in: their profile dirs + the legacy root. */
const dirsOf = async (args: RouteArgs, profile?: string): Promise<string[]> => {
  const root = artifactsDir();
  if (profile !== undefined) return [join(root, args.owner, profile)];
  const profiles = await args.mind.profiles.list(args.owner);
  return [root, ...profiles.map((p) => join(root, args.owner, p.id))];
};

const conversationIdOf = async (
  mind: RouteArgs["mind"],
  owner: string,
  sessionId: string,
): Promise<string | undefined> => {
  const key = await mind.profiles.keyForSession(owner, sessionId);
  return (await Effect.runPromise(mind.converse.conversationIdOf(key))) ?? undefined;
};

const findArtifact = async (
  args: RouteArgs,
  id: string,
): Promise<{ dir: string; info: NonNullable<ReturnType<typeof readArtifactInfo>> } | undefined> => {
  for (const dir of await dirsOf(args)) {
    const info = readArtifactInfo(dir, id);
    if (info !== undefined) return { dir, info };
  }
  return undefined;
};

const ownedBy = (info: { owner: string | null }, owner: string): boolean =>
  info.owner === null || info.owner === owner;

export async function artifactRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json, res } = args;
  const method = req.method ?? "GET";
  if (path === "/api/artifacts" && method === "GET") {
    const profile = queryOr(args, "profile");
    const sessionId = queryOr(args, "sessionId");
    const conversationId =
      sessionId !== undefined
        ? await conversationIdOf(mind, args.owner, sessionId)
        : (queryOr(args, "conversationId") ?? undefined);
    const q = queryOr(args, "q");
    const filter: { conversationId?: string; query?: string } = {};
    if (conversationId !== undefined) filter.conversationId = conversationId;
    if (q !== undefined) filter.query = q;
    const items = (await dirsOf(args, profile)).flatMap((dir) => searchArtifacts(dir, filter));
    const deduped = new Map(items.map((item) => [item.id, item]));
    json(
      200,
      [...deduped.values()].sort((a, b) => b.createdAt - a.createdAt),
    );
    return true;
  }
  if (path === "/api/artifacts" && method === "POST") {
    const name = queryOr(args, "name") ?? "upload.bin";
    const mime = queryOr(args, "mime") ?? mimeOfName(name);
    const sessionId = queryOr(args, "sessionId");
    const row = sessionId !== undefined ? await mind.profiles.rowOf(sessionId) : undefined;
    const conversationId =
      sessionId !== undefined
        ? ((await conversationIdOf(mind, args.owner, sessionId)) ?? null)
        : null;
    const body = await args.readBody(req);
    json(
      200,
      writeArtifact(
        row !== undefined ? join(artifactsDir(), row.owner, row.profile) : artifactsDir(),
        {
          name,
          mime,
          content: body.toString("utf8"),
          conversationId,
          owner: row?.owner ?? null,
          profile: row?.profile ?? null,
        },
      ),
    );
    return true;
  }
  if (path === "/api/artifacts" && method === "DELETE") {
    if (args.owner === "guest") {
      json(403, { error: "clearing the workspace requires an identified user" });
      return true;
    }
    json(200, { ok: true, cleared: clearArtifacts(artifactsDir()) });
    return true;
  }
  if (path.startsWith("/api/artifacts/") && method === "GET") {
    const found = await findArtifact(args, segment("/api/artifacts/"));
    const file = found !== undefined ? artifactFile(found.dir, found.info.id) : undefined;
    if (found === undefined || file === undefined) {
      json(404, { error: "unknown artifact" });
      return true;
    }
    if (!ownedBy(found.info, args.owner)) {
      json(403, { error: "not your artifact" });
      return true;
    }
    res.writeHead(200, { "content-type": found.info.mime, "access-control-allow-origin": "*" });
    res.end(readFileSync(file));
    return true;
  }
  if (path.startsWith("/api/artifacts/") && method === "DELETE") {
    const found = await findArtifact(args, segment("/api/artifacts/"));
    if (found === undefined) {
      json(404, { error: "unknown artifact" });
      return true;
    }
    if (!ownedBy(found.info, args.owner)) {
      json(403, { error: "not your artifact" });
      return true;
    }
    json(200, { ok: deleteArtifact(found.dir, found.info.id) });
    return true;
  }
  void listArtifacts;
  return false;
}
