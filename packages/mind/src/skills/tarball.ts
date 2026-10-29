/**
 * A minimal tar reader for skill installs: just enough ustar to walk a
 * code-style tarball (cload archives, `tar czf` output) and hand back the
 * text files of ONE skill folder. Handles the two long-name forms real
 * tarballs use (pax 'x' headers and GNU 'L'), skips directories, pax
 * globals and anything binary, and refuses to balloon: bounded entries,
 * bounded decompressed size. No dependencies; gzip comes from node:zlib.
 */
import { gunzipSync } from "node:zlib";

export interface TarballFile {
  readonly path: string;
  readonly content: string;
}

export interface ExtractedSkill {
  /** The SKILL.md text of the chosen folder (frontmatter included). */
  readonly skillMd: string;
  /** The folder's other text files, relative to the skill root. */
  readonly files: readonly TarballFile[];
  /** Names skipped because they were binary or oversized. */
  readonly skipped: readonly string[];
}

const BLOCK = 512;
const MAX_ENTRIES = 500;
const MAX_DECOMPRESSED = 4_000_000;
const MAX_FILE_CHARS = 512_000;

const isGzip = (bytes: Buffer): boolean =>
  bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** A header field's octal value (NUL/space padded); 0 when absent. */
const octal = (block: Buffer, at: number, size: number): number => {
  const text = block
    .toString("utf8", at, at + size)
    .replace(/[\0 ]+$/g, "")
    .trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
};

interface RawEntry {
  readonly path: string;
  readonly typeflag: string;
  readonly data: Buffer;
}

/** Walk the uncompressed tar stream; applies pax/GNU long-name overrides. */
const walkTar = (bytes: Buffer): readonly RawEntry[] => {
  const entries: RawEntry[] = [];
  let at = 0;
  let pendingPath: string | undefined;
  while (at + BLOCK <= bytes.length && entries.length < MAX_ENTRIES) {
    const header = bytes.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    const size = octal(header, 124, 12);
    const typeflag = header.toString("utf8", 156, 157).replace(/\0/g, "");
    at += BLOCK;
    const data = bytes.subarray(at, at + size);
    at += Math.ceil(size / BLOCK) * BLOCK;
    const fullPath = `${prefix}${prefix !== "" ? "/" : ""}${name}`;
    if (typeflag === "x") {
      // pax extended header: "NN path=<value>\n" records override the next name.
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (match !== null) pendingPath = match[1];
      continue;
    }
    if (typeflag === "L") {
      pendingPath = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const path = pendingPath ?? fullPath;
    pendingPath = undefined;
    entries.push({ path, typeflag, data });
  }
  return entries;
};

/**
 * Extract one skill folder from a gzipped tarball: the shallowest directory
 * containing SKILL.md, or `inside` when given (e.g. "my-skill" or
 * "skills/one"). Text files come back relative to the skill root.
 */
export const extractSkill = (gzip: Buffer, inside?: string): ExtractedSkill => {
  const bytes = isGzip(gzip) ? gunzipSync(gzip) : gzip;
  if (bytes.length > MAX_DECOMPRESSED) {
    throw new Error(`archive decompresses past ${MAX_DECOMPRESSED} bytes; refused`);
  }
  const files = new Map<string, Buffer>();
  for (const entry of walkTar(bytes)) {
    const regular = entry.typeflag === "0" || entry.typeflag === "\0" || entry.typeflag === "";
    if (regular) files.set(entry.path.replace(/^\.\//, ""), entry.data);
  }
  const roots = [...files.keys()]
    .filter((path) => path.endsWith("/SKILL.md"))
    .map((path) => path.slice(0, -"/SKILL.md".length))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  let root = "";
  if (inside !== undefined && inside !== "") {
    const wanted = inside.replace(/^\.?\//, "").replace(/\/+$/g, "");
    root = roots.find((candidate) => candidate === wanted) ?? "";
    if (root === "") {
      throw new Error(
        `no SKILL.md under "${wanted}" in the archive (folders with one: ${roots.slice(0, 5).join(", ") || "none"})`,
      );
    }
  } else {
    root = roots[0] ?? "";
    if (root === "") throw new Error("the archive holds no SKILL.md");
  }
  const prefix = root === "" ? "" : `${root}/`;
  const skillMd = files.get(`${prefix}SKILL.md`);
  if (skillMd === undefined) throw new Error("the archive holds no SKILL.md");
  const outFiles: TarballFile[] = [];
  const skipped: string[] = [];
  for (const [path, data] of files) {
    if (!path.startsWith(prefix) || path === `${prefix}SKILL.md`) continue;
    const rel = path.slice(prefix.length);
    if (data.includes(0)) {
      skipped.push(rel);
      continue;
    }
    const text = data.toString("utf8");
    if (text.length > MAX_FILE_CHARS) {
      skipped.push(rel);
      continue;
    }
    outFiles.push({ path: rel, content: text });
  }
  return { skillMd: skillMd.toString("utf8"), files: outFiles, skipped };
};
