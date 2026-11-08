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

export interface BrowserBackends {
  /** The artifact-scoped dir of a conversation (where screenshots land). */
  readonly dirOf: (conversationId: string) => string;
  /** The home VM's backend for a conversation, re-resolved on every call. */
  readonly resolveOf: (conversationId: string) => Promise<{ backend: ShellBackend }>;
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
    const existing = backends.get(key);
    if (existing !== undefined) return existing;
    const staging = join(root, "..", "bash-home", scopeHash(dir));
    const backend =
      options.backend !== undefined
        ? options.backend(dir, staging, world.guestRoot)
        : sandboxShellBackend(sandboxOptionsOf(world))(staging);
    const entry = { backend, guestRoot: world.guestRoot };
    backends.set(key, entry);
    return entry;
  };
  return { dirOf, resolveOf };
};
