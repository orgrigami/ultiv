/**
 * The artifact store: one folder per bot (blob + JSON sidecar per file) that
 * the REST surface serves raw bytes from. Its files form the bot's tree
 * (fs/durable-fs.ts keeps the path index; fs/tree.ts is how every writer puts
 * a file at a path); the loose writers here remain for the unscoped legacy
 * root only. Earlier versions of a file (fs/versions.ts) live here too, as
 * sidecars with `versionOf`, and never list. Each artifact records the
 * conversation that wrote it. Metadata lives in the sidecar, so list/read
 * need no database; ids are re-validated before ever touching a path.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isPathEscape, resolveInside, tryResolveInside } from "@spriessen/core";
import type { ArtifactInfo } from "@spriessen/contracts";
import type { ScopeHolder } from "./vault.ts";
import { dataPath } from "@spriessen/core";

/** The workspace filesystem's index lives in a reserved artifact pair. */
export const VFS_INDEX_ID = "vfs-index";

export interface ArtifactsOptions {
  /** Workspace root; default ARTIFACTS_DIR. */
  readonly root?: string;
  /** Profile-scope resolver; when set, artifacts partition by {owner}/{profile}. */
  readonly holder?: ScopeHolder;
}

/** The workspace directory: `ARTIFACTS_DIR`, else `artifacts/` in the data folder (core home.ts). */
export const artifactsDir = (): string => {
  const configured = process.env.ARTIFACTS_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : dataPath("artifacts");
};

const MAX_ID_CHARS = 64;
const MAX_READ_CHARS = 100_000;

/** Upload cap for app-served files; the store itself does not enforce it. */
export const MAX_UPLOAD_BYTES = 10_000_000;
/** Image mimes models see natively; mirrors the MCP result converter's set. */
export const VISION_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** Base64 length cap for one image handed to a model (same budget MCP results use). */
export const MAX_IMAGE_BASE64 = 3_000_000;

const validId = (id: string): boolean =>
  id.length > 0 && id.length <= MAX_ID_CHARS && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);

// Both resolve through resolveInside: an id is already a plain name, but a
// blob or sidecar that is a symlink out of the store is refused all the same.
const sidecarOf = (dir: string, id: string): string => resolveInside(dir, `${id}.json`);
const blobOf = (dir: string, id: string): string => resolveInside(dir, `${id}.bin`);

/** Run a read; a path that escapes the store reads as "not there". */
const confined = <A>(read: () => A | undefined): A | undefined => {
  try {
    return read();
  } catch (cause) {
    if (isPathEscape(cause)) return undefined;
    throw cause;
  }
};

const mimes: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

export const mimeOfName = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return mimes[ext] ?? "application/octet-stream";
};

export interface ArtifactWrite {
  readonly name: string;
  readonly mime?: string;
  readonly content: string;
  /** The conversation writing the file; null for app uploads without a session. */
  readonly conversationId?: string | null;
  /** The owner the artifact belongs to; null = unscoped (legacy behavior). */
  readonly owner?: string | null;
  /** The profile workspace the artifact belongs to; null = unscoped. */
  readonly profile?: string | null;
}

interface ArtifactScope {
  readonly conversationId?: string | null;
  readonly owner?: string | null;
  readonly profile?: string | null;
}

/** The one sidecar writer: raw bytes in, metadata out. */
const store = (
  dir: string,
  name: string,
  mime: string | undefined,
  data: Uint8Array,
  scope: ArtifactScope,
): ArtifactInfo => {
  const id = randomUUID();
  mkdirSync(dir, { recursive: true });
  const info: ArtifactInfo = {
    id,
    name: name.trim() === "" ? id : name.trim().slice(0, 200),
    mime: mime ?? mimeOfName(name),
    bytes: data.byteLength,
    createdAt: Date.now(),
    conversationId: scope.conversationId ?? null,
    owner: scope.owner ?? null,
    profile: scope.profile ?? null,
  };
  writeFileSync(blobOf(dir, id), data);
  writeFileSync(sidecarOf(dir, id), JSON.stringify(info));
  return info;
};

/** Store one artifact (UTF-8 text); returns its metadata. */
export const writeArtifact = (dir: string, input: ArtifactWrite): ArtifactInfo =>
  store(dir, input.name, input.mime, Buffer.from(input.content, "utf8"), input);

export interface ArtifactBinaryWrite extends ArtifactScope {
  readonly name: string;
  readonly mime?: string;
  readonly data: Uint8Array;
}

/** Store one artifact's raw bytes (binary-safe: images, PDFs, anything); returns its metadata. */
export const writeArtifactBytes = (dir: string, input: ArtifactBinaryWrite): ArtifactInfo =>
  store(dir, input.name, input.mime, input.data, input);

/** One sidecar as an artifact: only `<id>.json` holding that id and a name (else undefined). */
const sidecarInfo = (path: string, id: string): ArtifactInfo | undefined => {
  const info = JSON.parse(readFileSync(path, "utf8")) as Partial<ArtifactInfo>;
  return info.id === id && typeof info.name === "string"
    ? normalize(info as ArtifactInfo)
    : undefined;
};

/** Legacy sidecars predate `conversationId` and profile scoping; normalize on every read. */
const normalize = (raw: ArtifactInfo): ArtifactInfo => ({
  ...raw,
  conversationId: raw.conversationId ?? null,
  owner: raw.owner ?? null,
  profile: raw.profile ?? null,
});

/** Read one artifact's metadata and text (UTF-8, capped); undefined when absent. */
export const readArtifact = (
  dir: string,
  id: string,
): { info: ArtifactInfo; text: string } | undefined => confined(() => readArtifactUnsafe(dir, id));

const readArtifactUnsafe = (
  dir: string,
  id: string,
): { info: ArtifactInfo; text: string } | undefined => {
  if (!validId(id)) return undefined;
  const sidecar = sidecarOf(dir, id);
  if (!existsSync(sidecar)) return undefined;
  const info = sidecarInfo(sidecar, id);
  if (info === undefined) return undefined;
  const text = readFileSync(blobOf(dir, id), "utf8");
  return { info, text: text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) : text };
};

/** The absolute path of an artifact's bytes, for raw serving; undefined when absent. */
export const artifactFile = (dir: string, id: string): string | undefined =>
  confined(() => {
    if (!validId(id)) return undefined;
    const blob = blobOf(dir, id);
    return existsSync(blob) ? blob : undefined;
  });

/** Read one artifact's raw bytes (binary-safe); undefined when absent. Callers cap. */
export const readArtifactBytes = (
  dir: string,
  id: string,
): { info: ArtifactInfo; data: Buffer } | undefined =>
  confined(() => {
    if (!validId(id)) return undefined;
    const sidecar = sidecarOf(dir, id);
    if (!existsSync(sidecar)) return undefined;
    const info = sidecarInfo(sidecar, id);
    return info === undefined ? undefined : { info, data: readFileSync(blobOf(dir, id)) };
  });

export const readArtifactInfo = (dir: string, id: string): ArtifactInfo | undefined =>
  confined(() => {
    if (!validId(id)) return undefined;
    const sidecar = sidecarOf(dir, id);
    if (!existsSync(sidecar)) return undefined;
    return sidecarInfo(sidecar, id);
  });

/** Copy one artifact (blob + sidecar) between stores — envelope grants. */
export const copyArtifact = (fromDir: string, toDir: string, id: string): boolean => {
  if (!validId(id) || confined(() => existsSync(sidecarOf(fromDir, id)) || undefined) !== true)
    return false;
  mkdirSync(toDir, { recursive: true });
  copyFileSync(blobOf(fromDir, id), blobOf(toDir, id));
  copyFileSync(sidecarOf(fromDir, id), sidecarOf(toDir, id));
  return true;
};

/** Delete one artifact (blob + sidecar); false when it was not there. */
export const deleteArtifact = (dir: string, id: string): boolean => {
  if (!validId(id) || confined(() => existsSync(sidecarOf(dir, id)) || undefined) !== true)
    return false;
  rmSync(sidecarOf(dir, id), { force: true });
  rmSync(blobOf(dir, id), { force: true });
  return true;
};

/** Delete every artifact; returns how many were removed. Owner-level, not a tool. */
export const clearArtifacts = (dir: string): number => {
  if (!existsSync(dir)) return 0;
  const sidecars = readdirSync(dir).filter((file) => file.endsWith(".json"));
  for (const file of sidecars) {
    // rm on a symlink removes the link, never its target; still, only names
    // that resolve inside the store are touched.
    const id = file.slice(0, -".json".length);
    const sidecar = tryResolveInside(dir, `${id}.json`);
    const blob = tryResolveInside(dir, `${id}.bin`);
    if (sidecar !== undefined) rmSync(sidecar, { force: true });
    if (blob !== undefined) rmSync(blob, { force: true });
  }
  return sidecars.length;
};

/** Every sidecar in the store, earlier versions included (the reserved index never). */
export const allSidecars = (dir: string): readonly ArtifactInfo[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== `${VFS_INDEX_ID}.json`)
    .flatMap((file) => {
      try {
        const sidecar = tryResolveInside(dir, file);
        // Other JSON beside the files (configs, caches, version lists) is never a file.
        const info = sidecar === undefined ? undefined : sidecarInfo(sidecar, file.slice(0, -5));
        return info === undefined ? [] : [info];
      } catch {
        return [];
      }
    });
};

/** When a file last changed: its last write, else its creation. */
export const touchedAt = (info: ArtifactInfo): number => info.updatedAt ?? info.createdAt;

/** All files, most recently written first; earlier versions never list. */
export const listArtifacts = (dir: string): readonly ArtifactInfo[] =>
  allSidecars(dir)
    .filter((info) => info.versionOf === undefined)
    .sort((a, b) => touchedAt(b) - touchedAt(a));

export interface ArtifactFilter {
  /** Only artifacts written by this conversation. */
  readonly conversationId?: string | null;
  /** Substring match on the name and the (capped) text content, case-insensitive. */
  readonly query?: string;
}

/** List + filter: the search half of the workspace. */
export const searchArtifacts = (
  dir: string,
  filter: ArtifactFilter = {},
): readonly ArtifactInfo[] => {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return listArtifacts(dir).filter((info) => {
    if (
      filter.conversationId !== undefined &&
      filter.conversationId !== null &&
      info.conversationId !== filter.conversationId
    ) {
      return false;
    }
    if (query === "") return true;
    if (info.name.toLowerCase().includes(query)) return true;
    const found = readArtifact(dir, info.id);
    return found !== undefined && found.text.toLowerCase().includes(query);
  });
};
