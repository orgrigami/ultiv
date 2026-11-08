/**
 * DurableFs: the durable workspace tree whose files ARE artifacts. One virtual
 * tree per profile workspace, persisted write-through into the artifact store
 * (blob + sidecar per file, path→entry map in a reserved "vfs-index" pair) —
 * so bash-written files show up in `artifact_list`, the web UI, and survive
 * restarts. Idempotent under replay: every mutation is a last-write-wins
 * upsert, never a journal. Durability is per syscall; the exec boundary is
 * where the model sees it.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import { VFS_INDEX_ID } from "../plugins/artifacts.ts";
import {
  blobPath,
  restamp,
  sidecarPath,
  writeFileBlob,
  writeIndexPair,
  type StoreScope,
} from "./durable-store.ts";
import { dropVersions, keepVersion } from "./versions.ts";
import {
  DEFAULT_MODE_DIR,
  DEFAULT_MODE_FILE,
  eexists,
  eisdir,
  enoent,
  enotdir,
  enotempty,
  normalize,
  parentOf,
} from "./durable-fs-shapes.ts";
import type {
  BufferEncoding,
  CpOptions,
  CreateExclusiveOptions,
  DirentEntry,
  FileContent,
  FsStat,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  VfsEntry,
  VfsIndex,
  WriteFileOptions,
} from "./durable-fs-shapes.ts";

/** The index is stored as a reserved artifact pair in the same directory. */

export interface DurableFsOptions {
  /** Artifact-store scope directory this tree persists into. */
  readonly dir: string;
  /** Stamped on sidecars of files written through this tree. */
  readonly conversationId?: string | null;
  readonly owner?: string | null;
  readonly profile?: string | null;
}

export class DurableFs {
  private readonly dir: string;
  private readonly conversationId: string | null;
  private readonly owner: string | null;
  private readonly profile: string | null;
  private index: VfsIndex;

  constructor(options: DurableFsOptions) {
    this.dir = options.dir;
    this.conversationId = options.conversationId ?? null;
    this.owner = options.owner ?? null;
    this.profile = options.profile ?? null;
    this.index = { paths: {} };
    this.load();
  }

  // ---- persistence -------------------------------------------------------

  private sidecarOf(id: string): string {
    return sidecarPath(this.dir, id);
  }
  private blobOf(id: string): string {
    return blobPath(this.dir, id);
  }
  private scope(): StoreScope {
    return { conversationId: this.conversationId, owner: this.owner, profile: this.profile };
  }

  /**
   * (Re-)read the index; every change calls it first: several trees open the
   * same folder (a bash session, file_edit, artifact_write, an upload), and a
   * change must land on the newest map, never write an older one over it.
   */
  private load(): void {
    if (!existsSync(this.sidecarOf(VFS_INDEX_ID))) {
      this.index = { paths: { "/": { kind: "dir", mode: DEFAULT_MODE_DIR, mtime: Date.now() } } };
      this.persist();
      return;
    }
    try {
      this.index = JSON.parse(readFileSync(this.blobOf(VFS_INDEX_ID), "utf8")) as VfsIndex;
    } catch {
      this.index = { paths: { "/": { kind: "dir", mode: DEFAULT_MODE_DIR, mtime: Date.now() } } };
      this.persist();
    }
  }

  private persist(): void {
    writeIndexPair(this.dir, this.index, this.scope());
  }

  // ---- entry helpers -----------------------------------------------------

  private entry(value: string): VfsEntry | undefined {
    return this.index.paths[normalize(value)];
  }

  /** Write (or overwrite) one file's bytes; the artifact id is stable per path. */
  private writeBlob(id: string, bytes: Uint8Array, path: string): void {
    writeFileBlob(this.dir, id, bytes, path, this.scope());
  }

  private newId(): string {
    return randomUUID();
  }

  private refCount(id: string): number {
    return Object.values(this.index.paths).filter((entry) => entry.id === id).length;
  }

  private dropBlobIfUnreferenced(id: string): void {
    if (id === VFS_INDEX_ID || this.refCount(id) > 0) return;
    dropVersions(this.dir, id);
    rmSync(this.blobOf(id), { force: true });
    rmSync(this.sidecarOf(id), { force: true });
  }

  private put(value: string, entry: VfsEntry): void {
    this.index.paths[normalize(value)] = entry;
    this.persist();
  }

  /** The bytes of a file entry, following symlinks one hop. */
  private fileBytes(value: string): Buffer {
    const entry = this.entry(value);
    if (entry === undefined) throw enoent("open", value);
    if (entry.kind === "dir") throw eisdir(value);
    const id =
      entry.kind === "symlink"
        ? (this.entry(entry.target ?? "/")?.id ??
          (() => {
            throw enoent("open", entry.target ?? "/");
          })())
        : entry.id;
    if (id === undefined) throw enoent("open", value);
    return readFileSync(this.blobOf(id));
  }

  private statOf(value: string, follow: boolean): FsStat {
    let entry = this.entry(value);
    if (entry === undefined) throw enoent("stat", value);
    if (follow && entry.kind === "symlink") {
      const target = this.entry(entry.target ?? "/");
      if (target === undefined) throw enoent("stat", entry.target ?? "/");
      entry = target;
    }
    const size =
      entry.kind === "file" && entry.id !== undefined && existsSync(this.blobOf(entry.id))
        ? readFileSync(this.blobOf(entry.id)).byteLength
        : 0;
    return {
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "dir",
      isSymbolicLink: entry.kind === "symlink",
      mode: entry.mode,
      size,
      mtime: new Date(entry.mtime),
    };
  }

  // ---- IFileSystem -------------------------------------------------------

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const bytes = this.fileBytes(path);
    const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
    return encoding === "utf8" || encoding === "utf-8"
      ? bytes.toString("utf8")
      : bytes.toString(encoding === "binary" || encoding === "latin1" ? "latin1" : "utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new Uint8Array(this.fileBytes(path));
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.load();
    const value = normalize(path);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const existing = this.entry(value);
    if (existing?.kind === "dir") throw eisdir(value);
    const id = existing?.kind === "file" ? existing.id : this.newId();
    if (id === undefined) throw enoent("open", value);
    if (existing?.kind === "file") keepVersion(this.dir, id, bytes, value);
    this.writeBlob(id, bytes, value);
    this.put(value, {
      kind: "file",
      id,
      mode: existing?.mode ?? DEFAULT_MODE_FILE,
      mtime: Date.now(),
    });
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.load();
    const addition =
      typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const existing: Uint8Array =
      this.entry(path) !== undefined ? this.fileBytes(path) : new Uint8Array(0);
    const merged = Buffer.concat([existing, addition]);
    await this.writeFile(path, new Uint8Array(merged), options);
  }

  async exists(path: string): Promise<boolean> {
    return this.entry(path) !== undefined;
  }

  async stat(path: string): Promise<FsStat> {
    return this.statOf(path, true);
  }
  async lstat(path: string): Promise<FsStat> {
    return this.statOf(path, false);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.load();
    const value = normalize(path);
    if (options?.recursive === true) {
      const parts = value.split("/").filter((part) => part !== "");
      let current = "";
      for (const part of parts) {
        current = `${current}/${part}`;
        if (this.entry(current) === undefined) {
          this.put(current, { kind: "dir", mode: DEFAULT_MODE_DIR, mtime: Date.now() });
        }
      }
      return;
    }
    if (this.entry(value) !== undefined) throw eexists(value);
    if (this.entry(parentOf(value))?.kind !== "dir") throw enoent("mkdir", value);
    this.put(value, { kind: "dir", mode: DEFAULT_MODE_DIR, mtime: Date.now() });
  }

  async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    this.load();
    const value = normalize(path);
    if (this.entry(value) !== undefined) throw eexists(value);
    const parent = this.entry(parentOf(value));
    if (parent?.kind !== "dir") throw enoent("open", value);
    if (options.directory === true) {
      this.put(value, { kind: "dir", mode: options.mode, mtime: Date.now() });
      return;
    }
    const id = this.newId();
    this.writeBlob(id, new Uint8Array(0), value);
    this.put(value, { kind: "file", id, mode: options.mode, mtime: Date.now() });
  }

  private children(value: string): readonly string[] {
    return Object.keys(this.index.paths)
      .filter((path) => path !== value && parentOf(path) === value)
      .sort();
  }

  async readdir(path: string): Promise<string[]> {
    const entry = this.entry(path);
    if (entry === undefined) throw enoent("scandir", path);
    if (entry.kind !== "dir") throw enotdir(path);
    return this.children(path).map((child) => posix.basename(child));
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const names = await this.readdir(path);
    return names.map((name) => {
      const child = this.entry(posix.join(path, name));
      return {
        name,
        isFile: child?.kind === "file",
        isDirectory: child?.kind === "dir",
        isSymbolicLink: child?.kind === "symlink",
      };
    });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.load();
    const value = normalize(path);
    const entry = this.entry(value);
    if (entry === undefined) {
      if (options?.force === true) return;
      throw enoent("rm", value);
    }
    if (entry.kind === "dir" && options?.recursive !== true) {
      if (this.children(value).length > 0) throw enotempty(value);
    }
    const subtree = Object.keys(this.index.paths).filter(
      (path) => path === value || path.startsWith(value === "/" ? "/" : `${value}/`),
    );
    for (const path of subtree) {
      const removed = this.index.paths[path];
      delete this.index.paths[path];
      if (removed?.kind === "file" && removed.id !== undefined) {
        this.dropBlobIfUnreferenced(removed.id);
      }
    }
    this.persist();
  }

  private copyInto(source: string, dest: string, recursive: boolean): void {
    const entry = this.entry(source);
    if (entry === undefined) throw enoent("copyfile", source);
    if (entry.kind === "dir") {
      if (!recursive) throw eisdir(source);
      this.put(dest, { kind: "dir", mode: entry.mode, mtime: Date.now() });
      for (const child of this.children(source)) {
        this.copyInto(child, posix.join(dest, posix.basename(child)), true);
      }
      return;
    }
    if (entry.kind === "symlink") {
      this.put(dest, {
        kind: "symlink",
        target: entry.target ?? "/",
        mode: entry.mode,
        mtime: Date.now(),
      });
      return;
    }
    const bytes = this.fileBytes(source);
    const id = this.newId();
    this.writeBlob(id, bytes, dest);
    this.put(dest, { kind: "file", id, mode: entry.mode, mtime: Date.now() });
  }

  private destPath(src: string, dest: string): string {
    const target = this.entry(dest);
    return target?.kind === "dir" ? posix.join(dest, posix.basename(src)) : dest;
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.load();
    const target = this.destPath(normalize(src), normalize(dest));
    this.copyInto(normalize(src), target, options?.recursive === true);
  }

  async mv(src: string, dest: string): Promise<void> {
    this.load();
    const from = normalize(src);
    const to = this.destPath(from, normalize(dest));
    const entry = this.entry(from);
    if (entry === undefined) throw enoent("rename", from);
    if (this.entry(to)?.kind === "dir" && entry.kind !== "dir") throw eisdir(to);
    const subtree = Object.keys(this.index.paths).filter(
      (path) => path === from || path.startsWith(`${from}/`),
    );
    for (const path of subtree) {
      const moved = this.index.paths[path];
      const next = path === from ? to : `${to}${path.slice(from.length)}`;
      delete this.index.paths[path];
      this.index.paths[next] = moved as VfsEntry;
      if (moved?.kind === "file" && moved.id !== undefined) restamp(this.dir, moved.id, next);
    }
    this.persist();
  }

  resolvePath(base: string, path: string): string {
    return normalize(posix.resolve(normalize(base), path));
  }

  getAllPaths(): string[] {
    return Object.keys(this.index.paths).sort();
  }

  /** Every FILE path in the tree (dirs and symlinks excluded), sorted. */
  allFilePaths(): readonly string[] {
    return Object.entries(this.index.paths)
      .filter(([, entry]) => entry.kind === "file")
      .map(([path]) => path)
      .sort();
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.load();
    const entry = this.entry(path);
    if (entry === undefined) throw enoent("chmod", path);
    this.put(path, { ...entry, mode });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.load();
    const value = normalize(linkPath);
    if (this.entry(value) !== undefined) throw eexists(value);
    this.put(value, {
      kind: "symlink",
      target: normalize(target),
      mode: DEFAULT_MODE_FILE,
      mtime: Date.now(),
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.load();
    const value = normalize(newPath);
    const entry = this.entry(existingPath);
    if (entry === undefined || entry.kind !== "file" || entry.id === undefined) {
      throw enoent("link", existingPath);
    }
    if (this.entry(value) !== undefined) throw eexists(value);
    this.put(value, { kind: "file", id: entry.id, mode: entry.mode, mtime: Date.now() });
  }

  async readlink(path: string): Promise<string> {
    const entry = this.entry(path);
    if (entry === undefined) throw enoent("readlink", path);
    if (entry.kind !== "symlink")
      throw Object.assign(new Error(`EINVAL: readlink '${path}'`), { code: "EINVAL" });
    return entry.target ?? "/";
  }

  async realpath(path: string): Promise<string> {
    let value = normalize(path);
    for (let hops = 0; this.entry(value)?.kind === "symlink"; hops += 1) {
      if (hops > 8) throw Object.assign(new Error(`ELOOP: realpath '${path}'`), { code: "ELOOP" });
      value = normalize(this.entry(value)?.target ?? "/");
    }
    if (this.entry(value) === undefined) throw enoent("realpath", path);
    return value;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    this.load();
    const entry = this.entry(path);
    if (entry === undefined) throw enoent("utimes", path);
    this.put(path, { ...entry, mtime: mtime.getTime() });
  }

  // ---- the store's view ----------------------------------------------------

  /** The artifact id of the file at a path (after a fresh read of the index). */
  idOf(path: string): string | undefined {
    this.load();
    const entry = this.entry(path);
    return entry?.kind === "file" ? entry.id : undefined;
  }

  /** Every path a file id sits at (hard links share one), sorted. */
  pathsOf(id: string): readonly string[] {
    this.load();
    return Object.entries(this.index.paths)
      .filter(([, entry]) => entry.kind === "file" && entry.id === id)
      .map(([path]) => path)
      .sort();
  }

  /** Put an artifact already in the store at a free path (parents made). */
  place(path: string, id: string): void {
    this.load();
    const value = normalize(path);
    if (this.entry(value) !== undefined) throw eexists(value);
    const parts = value.split("/").filter((part) => part !== "");
    for (let i = 1; i < parts.length; i += 1) {
      const dir = `/${parts.slice(0, i).join("/")}`;
      if (this.entry(dir) === undefined)
        this.index.paths[dir] = { kind: "dir", mode: DEFAULT_MODE_DIR, mtime: Date.now() };
    }
    this.put(value, { kind: "file", id, mode: DEFAULT_MODE_FILE, mtime: Date.now() });
    restamp(this.dir, id, value);
  }

  /** Diagnostic: files in the backing artifact store (index excluded). */
  artifactIds(): readonly string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((file) => file.endsWith(".json") && file !== `${VFS_INDEX_ID}.json`)
      .map((file) => file.slice(0, -".json".length));
  }
}
