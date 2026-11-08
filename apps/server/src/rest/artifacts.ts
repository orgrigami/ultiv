/**
 * Artifact routes over the per-profile partitioned workspace:
 * ARTIFACTS_DIR/{owner}/{profile}/, with the flat root kept for legacy
 * sidecars (owner null — uuid-capability access, exactly as before). A
 * bot's files are its tree: an upload lands at uploads/<name> (a free name
 * when taken), a delete removes the file from every path it sits at, and a
 * list sorts by the last write. Versions live in artifact-versions.ts.
 */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import {
  artifactFile,
  artifactsDir,
  deleteArtifact,
  listArtifacts,
  MAX_UPLOAD_BYTES,
  mimeOfName,
  pathForName,
  putFile,
  readArtifactInfo,
  removeFile,
  resolveInside,
  searchArtifacts,
  touchedAt,
  writeArtifactBytes,
} from "@spriessen/ext";
import { artifactVersionRoutes } from "./artifact-versions.ts";
import { artifactSources } from "./artifact-source.ts";
import { ownsProfile, ownsSession } from "./owner-scope.ts";
import { can } from "./can.ts";
import { queryOr, type RouteArgs } from "./types.ts";

/** Every directory the owner's artifacts may live in: their profile dirs + the legacy root. */
const dirsOf = async (args: RouteArgs, profile?: string): Promise<string[]> => {
  const root = artifactsDir();
  if (profile !== undefined) return [resolveInside(root, args.owner, profile)];
  const profiles = await args.mind.profiles.list(args.owner);
  return [root, ...profiles.map((p) => resolveInside(root, args.owner, p.id))];
};

const conversationIdOf = async (
  mind: RouteArgs["mind"],
  owner: string,
  sessionId: string,
): Promise<string | undefined> => {
  const key = await mind.profiles.keyForSession(owner, sessionId);
  return (await Effect.runPromise(mind.converse.conversationIdOf(key))) ?? undefined;
};

export const findArtifact = async (
  args: RouteArgs,
  id: string,
): Promise<{ dir: string; info: NonNullable<ReturnType<typeof readArtifactInfo>> } | undefined> => {
  for (const dir of await dirsOf(args)) {
    const info = readArtifactInfo(dir, id);
    if (info !== undefined) return { dir, info };
  }
  return undefined;
};

/**
 * Legacy flat-root artifacts carry `owner: null` and stay visible to everyone
 * (single-user era). Another owner's artifact answers 404, like a missing one.
 */
export const ownedBy = (info: { owner: string | null; id?: string }, owner: string): boolean =>
  // Legacy sidecars with no owner stay readable, as before (see SECURITY.md).
  info.owner === null ||
  can(owner, "view", { type: "artifact", owner: info.owner, id: info.id ?? "" });

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
    args.json(404, { error: "unknown artifact" });
    return true;
  }
  const resolve = await artifactSources(
    args,
    found.info.profile !== null ? [found.info.profile] : [],
  );
  args.json(200, { ...found.info, source: await resolve(found.info.conversationId) });
  return true;
};

/** `?limit=` (1–200) keeps the newest; `?sources=1` names each file's chat. */
const listed = async (
  args: RouteArgs,
  items: readonly ReturnType<typeof searchArtifacts>[number][],
  profile: string | undefined,
): Promise<unknown[]> => {
  const limit = Number(queryOr(args, "limit") ?? "");
  const newest = [...items].sort((a, b) => touchedAt(b) - touchedAt(a));
  const kept =
    Number.isInteger(limit) && limit > 0 ? newest.slice(0, Math.min(limit, 200)) : newest;
  if (queryOr(args, "sources") !== "1") return kept;
  const profiles =
    profile !== undefined
      ? [profile]
      : (await args.mind.profiles.list(args.owner)).map((row) => row.id);
  const resolve = await artifactSources(args, profiles);
  return Promise.all(
    kept.map(async (item) => ({ ...item, source: await resolve(item.conversationId) })),
  );
};

const serveRaw = async (args: RouteArgs, id: string): Promise<boolean> => {
  const found = await findArtifact(args, id);
  const file = found !== undefined ? artifactFile(found.dir, found.info.id) : undefined;
  if (found === undefined || file === undefined) {
    args.json(404, { error: "unknown artifact" });
    return true;
  }
  if (!ownedBy(found.info, args.owner)) {
    args.json(404, { error: "unknown artifact" });
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
    // Another owner's bot lists like a bot with no artifacts.
    if (profile !== undefined && !(await ownsProfile(args, profile))) {
      json(200, []);
      return true;
    }
    const items = (await dirsOf(args, profile))
      .flatMap((dir) => searchArtifacts(dir, filter))
      .filter((item) => ownedBy(item, args.owner));
    const deduped = new Map(items.map((item) => [item.id, item]));
    json(200, await listed(args, [...deduped.values()], profile));
    return true;
  }
  if (path === "/api/artifacts" && method === "POST") {
    const name = queryOr(args, "name") ?? "upload.bin";
    const mime = queryOr(args, "mime") ?? mimeOfName(name);
    const sessionId = queryOr(args, "sessionId");
    if (sessionId !== undefined && !(await ownsSession(args, sessionId))) {
      json(404, { error: "unknown session" });
      return true;
    }
    const row = sessionId !== undefined ? await mind.profiles.rowOf(sessionId) : undefined;
    const conversationId =
      sessionId !== undefined
        ? ((await conversationIdOf(mind, args.owner, sessionId)) ?? null)
        : null;
    const body = await args.readBody(req);
    if (body.length > MAX_UPLOAD_BYTES) {
      json(413, { error: "file too large (10 MB max)" });
      return true;
    }
    const scope = { conversationId, owner: row?.owner ?? null, profile: row?.profile ?? null };
    if (row === undefined) {
      // No bot, no tree: the legacy root keeps loose files.
      json(200, writeArtifactBytes(artifactsDir(), { name, mime, data: body, ...scope }));
      return true;
    }
    const dir = resolveInside(artifactsDir(), row.owner, row.profile);
    const at = pathForName("uploads", name, "upload.bin");
    const put = await putFile(dir, at, body, { ...scope, unique: true, mime });
    if ("refused" in put) json(409, { error: put.refused });
    else json(200, put.info);
    return true;
  }
  if (path === "/api/artifacts" && method === "DELETE") {
    // Only the caller's own legacy-root artifacts; ownerless legacy ones and
    // anything not the caller's stay.
    const root = artifactsDir();
    const mine = listArtifacts(root).filter((info) => ownedBy(info, args.owner));
    const cleared = mine.filter((info) => deleteArtifact(root, info.id)).length;
    json(200, { ok: true, cleared });
    return true;
  }
  if (await artifactVersionRoutes(args)) return true;
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
      json(404, { error: "unknown artifact" });
      return true;
    }
    json(200, { ok: await removeFile(found.dir, found.info.id) });
    return true;
  }
  return false;
}
