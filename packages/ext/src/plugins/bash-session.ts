/**
 * The bash tool's sandbox side: which folder a bot's VM sees (its home
 * world), and one sandbox session per conversation — opened on first use,
 * loaded from the durable tree, and reconciled back into it after each run.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { DurableFs } from "../fs/durable-fs.ts";
import { workspaceEpoch } from "../fs/workspace-epoch.ts";
import type { HomeScope, SandboxUser } from "./vault.ts";
import type { ShellBackend } from "../shell/backend.ts";
import { scopeHash } from "../shell/sandbox-backend.ts";

/** Where the bot's folder is mounted inside its VM. */
export const HOME = "/home";

/**
 * The guest world one conversation's `bash` maps to: which VM (its sandbox
 * name is `sandboxNameOf(vmDir)`), where the bot's workspace sits inside it,
 * and the home's shared-folder gid when the home provisions one. Without a
 * home scope this is the per-bot VM of older embedders: the bot's whole dir
 * is the scope and the workspace is all of `/home`.
 */
export interface HomeWorld {
  readonly vmDir: string;
  readonly guestRoot: string;
  readonly sharedGid?: number;
  /**
   * The org-wide folder (slice 2c): mounted at `/home/org-shared` in every
   * VM, read-write for an org bot, read-only for a department bot.
   */
  readonly orgShared?: HomeScope["orgShared"];
  /** The department's durable store backing `/home/shared` (slice 2d). */
  readonly sharedStore?: string;
  /** The org VM's department folders (slice 2d), org bots only. */
  readonly deptShared?: HomeScope["deptShared"];
  /** The bot's own Linux user in the VM (slice 2b), when the home gives one. */
  readonly user?: SandboxUser;
  /** The home's network allowlist (slice 3): named hosts, everything else denied. */
  readonly netAllowlist?: readonly string[];
  /** Full network access (owner opt-in): the allowlist is ignored. */
  readonly netOpen?: boolean;
  /** The writable shared folders' size caps (fix 2). */
  readonly caps?: HomeScope["caps"];
  /** The home's stored VM size (slice 4): cpus and memory at creation. */
  readonly vm?: HomeScope["vm"];
}

/** Safe folder name for the bot inside the shared VM; an opaque hash otherwise. */
export const botFolderName = (dir: string): string => {
  const base = basename(dir);
  // "shared" is reserved: it is every VM's /home/shared.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(base) && base !== "shared"
    ? base
    : scopeHash(dir);
};

/** The pure mapping from a conversation's bot dir and home scope to its VM world. */
export const homeWorldOf = (botDir: string, home: HomeScope | undefined): HomeWorld => {
  if (home === undefined) return { vmDir: botDir, guestRoot: HOME };
  return {
    vmDir: home.dir,
    guestRoot: `${HOME}/${botFolderName(botDir)}`,
    ...(home.sharedGid === undefined ? {} : { sharedGid: home.sharedGid }),
    ...(home.orgShared === undefined ? {} : { orgShared: home.orgShared }),
    ...(home.sharedStore === undefined ? {} : { sharedStore: home.sharedStore }),
    ...(home.deptShared === undefined ? {} : { deptShared: home.deptShared }),
    ...(home.user === undefined ? {} : { user: home.user }),
    ...(home.netAllowlist === undefined ? {} : { netAllowlist: home.netAllowlist }),
    ...(home.netOpen === undefined ? {} : { netOpen: home.netOpen }),
    ...(home.caps === undefined ? {} : { caps: home.caps }),
    ...(home.vm === undefined ? {} : { vm: home.vm }),
  };
};

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** One call's resolved home world: its identity, and how to build its backend. */
export interface ResolvedWorld {
  readonly key: string;
  readonly make: () => { readonly backend: ShellBackend; readonly guestRoot: string };
}

export interface SandboxSession {
  durable: DurableFs;
  readonly backend: ShellBackend;
  /** The resolved home world this backend was built for (re-checked every call). */
  readonly worldKey: string;
  /** workspaceEpoch(dir) when the VM was last loaded; file_edit/file_delete bump it. */
  epoch: number;
  /** sha256 per workspace-relative path, the sync loop's diff basis. */
  hashes: Map<string, string>;
  cwd: string;
}

/**
 * Boots the session: load the artifact tree, reset the VM workspace to it,
 * seed the hash map. The artifact store mirrors the VM after every sync, so
 * re-pushing is idempotent (and heals a crashed VM's lost disk).
 */
export const openSession = async (
  dir: string,
  conversationId: string,
  backend: ShellBackend,
  guestRoot: string,
  worldKey: string,
): Promise<SandboxSession> => {
  const session: SandboxSession = {
    durable: new DurableFs({ dir, conversationId }),
    backend,
    worldKey,
    epoch: workspaceEpoch(dir),
    hashes: new Map(),
    cwd: guestRoot,
  };
  await load(session, dir, conversationId);
  return session;
};

/** Re-read the tree from disk and reset the VM to it (also after another tool changed it). */
export const load = async (
  session: SandboxSession,
  dir: string,
  conversationId: string,
): Promise<void> => {
  session.epoch = workspaceEpoch(dir);
  session.durable = new DurableFs({ dir, conversationId });
  const files = [];
  const hashes = new Map<string, string>();
  for (const path of session.durable.allFilePaths()) {
    const bytes = await session.durable.readFileBuffer(path);
    const rel = path.slice(1); // "/a/b" -> "a/b"
    files.push({ path: rel, bytes });
    hashes.set(rel, sha256(bytes));
  }
  await session.backend.prepare(files);
  session.hashes = hashes;
};

/**
 * VM → artifact store: upsert changed files, delete removed ones. Deletion
 * needs a TRUSTED listing: a failed listing throws before anything is
 * deleted, and a lost workspace (recreated VM — `WorkspaceLostError`) is
 * never read as "the bot deleted everything"; the next call re-prepares.
 */
export const reconcile = async (session: SandboxSession): Promise<void> => {
  const seen = new Set<string>(await session.backend.listFiles());
  for (const rel of seen) {
    const bytes = await session.backend.readFile(rel);
    const hash = sha256(bytes);
    if (session.hashes.get(rel) !== hash) {
      await session.durable.writeFile(`/${rel}`, bytes);
      session.hashes.set(rel, hash);
    }
  }
  for (const rel of session.hashes.keys()) {
    if (!seen.has(rel)) {
      await session.durable.rm(`/${rel}`);
      session.hashes.delete(rel);
    }
  }
};
