/**
 * A file's earlier versions (fs/versions.ts in ext): writing a bot's file
 * again at its path keeps the old bytes as a version. A version is an
 * artifact of its own, so its bytes are served by the plain
 * `/api/artifacts/<versionId>` route; these routes list and restore them.
 *
 * - `GET  /api/artifacts/:id/versions` — newest first (another owner's file: 404)
 * - `POST /api/artifacts/:id/versions/:versionId/restore` — the version's bytes
 *   go back at the file's path; what was there becomes a version itself.
 */
import { restoreVersion, versionsOf } from "@spriessen/ext";
import { findArtifact, ownedBy } from "./artifacts.ts";
import type { RouteArgs } from "./types.ts";

const VERSIONS = /^\/api\/artifacts\/([^/]+)\/versions(?:\/([^/]+)\/restore)?$/;

export async function artifactVersionRoutes(args: RouteArgs): Promise<boolean> {
  const match = VERSIONS.exec(args.path);
  if (match === null) return false;
  const method = args.req.method ?? "GET";
  const id = decodeURIComponent(match[1] ?? "");
  const versionId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
  if (
    (versionId !== undefined && method !== "POST") ||
    (versionId === undefined && method !== "GET")
  )
    return false;
  const found = await findArtifact(args, id);
  if (found === undefined || !ownedBy(found.info, args.owner)) {
    args.json(404, { error: "unknown artifact" });
    return true;
  }
  if (versionId === undefined) {
    args.json(200, versionsOf(found.dir, found.info.id));
    return true;
  }
  const restored = await restoreVersion(found.dir, found.info.id, versionId, {
    owner: found.info.owner,
    profile: found.info.profile,
  });
  if (restored === undefined) args.json(404, { error: "unknown version" });
  else args.json(200, restored);
  return true;
}
