/**
 * The shell backends the browser faculties share: ONE cache keyed by the
 * RESOLVED WORLD (re-resolved every call), so the browser_session tool and
 * the owner's cast drive the SAME home VM. A dir-keyed cache pinned the
 * first resolution for the process lifetime, and the browser path once
 * carried a world without netOpen (or a transiently degraded home scope),
 * drift-recreated the home's VM CLOSED, and then kept serving that broken
 * VM forever (8 Nov 2026). A recovered resolution now builds a fresh
 * backend and the drift check recreates the VM with the home's real spec.
 */
import { join } from "node:path";
import type { ShellBackend } from "../shell/backend.ts";
import { scopeDir, type ScopeHolder } from "../plugins/vault.ts";
import { artifactsDir } from "../plugins/artifacts.ts";
import { homeWorldOf, sandboxOptionsOf } from "../plugins/bash.ts";
import { sandboxShellBackend, scopeHash } from "../shell/sandbox-backend.ts";

export interface BrowserBackendOptions {
  /** Artifact root; default ARTIFACTS_DIR. */
  readonly root?: string;
  /** Profile-scope resolver; when set, the run uses the conversation's home VM. */
  readonly holder?: ScopeHolder | undefined;
  /** Backend factory override for tests (a fake exec answering driver JSON). */
  readonly backend?:
    | ((dir: string, homeDir: string, guestRoot: string) => ShellBackend)
    | undefined;
}

/** A conversation's browser seat: its home VM, and which bot's session it means. */
export interface BrowserSeat {
  readonly backend: ShellBackend;
  /**
   * The broker's key for the bot's session: its Linux user in the home VM
   * (the same in every VM). A per-bot VM (no home scope: older embedders,
   * tests) holds one bot, keyed "default". Undefined for a shared home with
   * no per-bot users: the broker could not keep its bots apart there, so the
   * browser refuses.
   */
  readonly bot: string | undefined;
}

export interface BrowserBackends {
  /** The artifact-scoped dir of a conversation (where screenshots land). */
  readonly dirOf: (conversationId: string) => string;
  /** The home VM's backend for a conversation, re-resolved on every call. */
  readonly resolveOf: (conversationId: string) => Promise<BrowserSeat>;
}

export const browserBackends = (options: BrowserBackendOptions): BrowserBackends => {
  const root = options.root ?? artifactsDir();
  const holder = options.holder;
  const dirOf = (conversationId: string): string =>
    holder === undefined ? root : scopeDir(holder, conversationId, root);
  const backends = new Map<string, { backend: ShellBackend; guestRoot: string }>();
  const resolveOf = async (conversationId: string) => {
    const dir = dirOf(conversationId);
    const home = await holder?.get()?.homeScopeOf?.(conversationId);
    const world = homeWorldOf(dir, home);
    const key = JSON.stringify([
      world.vmDir,
      world.guestRoot,
      world.sharedGid ?? null,
      world.orgShared ?? null,
      world.sharedStore ?? null,
      world.teamShared ?? null,
      world.user ?? null,
      world.netAllowlist ?? null,
      world.netOpen ?? null,
      world.vm ?? null,
    ]);
    // A per-bot VM (no home scope) holds one bot: its session is "default".
    // A SHARED home VM keeps bots apart only by their Linux users.
    const bot = world.user?.name ?? (home === undefined ? "default" : undefined);
    const existing = backends.get(key);
    if (existing !== undefined) return { backend: existing.backend, bot };
    const staging = join(root, "..", "bash-home", scopeHash(dir));
    const backend =
      options.backend !== undefined
        ? options.backend(dir, staging, world.guestRoot)
        : sandboxShellBackend(sandboxOptionsOf(world))(staging);
    backends.set(key, { backend, guestRoot: world.guestRoot });
    return { backend, bot };
  };
  return { dirOf, resolveOf };
};
