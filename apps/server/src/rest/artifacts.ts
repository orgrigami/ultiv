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

const UNSAFE_INLINE = new Set(["text/html", "image/svg+xml", "application/xhtml+xml"]);

/**
 * Content-Disposition for `?dl=1`: a sanitized ASCII fallback plus the RFC 5987
 * `filename*` form, so unicode names survive and headers stay injectable-proof.
 */
const dispositionOf = (name: string): string => {
  const ascii = Array.from(name)
    .map((ch) => (ch >= " " && ch <= "~" ? ch : " "))
    .join("")
    .replaceAll('"', " ")
    .trim();
  return `attachment; filename="${ascii === "" ? "file" : ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const serveMeta = async (args: RouteArgs, id: string): Promise<boolean> => {
  const found = await findArtifact(args, id);
  if (found === undefined) {
    args.json(404, { error: "unknown artifact" });
    return true;
  }
  if (!ownedBy(found.info, args.owner)) {
    args.json(403, { error: "not your artifact" });
    return true;
  }
  args.json(200, found.info);
  return true;
};

const serveRaw = async (args: RouteArgs, id: string): Promise<boolean> => {
  const found = await findArtifact(args, id);
  const file = found !== undefined ? artifactFile(found.dir, found.info.id) : undefined;
  if (found === undefined || file === undefined) {
    args.json(404, { error: "unknown artifact" });
    return true;
  }
  if (!ownedBy(found.info, args.owner)) {
    args.json(403, { error: "not your artifact" });
    return true;
  }
  const download = queryOr(args, "dl") === "1";
  args.res.writeHead(200, {
    "content-type": found.info.mime,
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    ...(download
      ? { "content-disposition": dispositionOf(found.info.name) }
      : UNSAFE_INLINE.has(found.info.mime)
        ? { "content-security-policy": "sandbox" }
        : {}),
  });
  args.res.end(readFileSync(file));
  return true;
};

export async function artifactRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
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
    // Meta first: ids never contain a slash, and ?dl=1 stays in the query.
    const seg = segment("/api/artifacts/");
    return seg.endsWith("/meta")
      ? serveMeta(args, seg.slice(0, -"/meta".length))
      : serveRaw(args, seg);
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
