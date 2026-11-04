/**
 * The mind's boot options and the internal wiring they compile into,
 * split out of entity.ts (which was at the LoC ceiling). `MindOptions` is
 * the embedder-facing surface (`openMind`, `mindLayer`); `MindWiring` is
 * what `mindLayer` builds for the entity composition.
 */
import type { Storage } from "@earendil-works/pi-durable";
import { ConfigError } from "effect/Config";
import { External, Unavailable, Duplicate } from "@spriessen/core";
import type { HomeRef } from "@spriessen/contracts";
import type { Plugin, ScopeHolder, BindingStore, VaultStore } from "@spriessen/ext";
import type { GenerateOptions } from "./generate/generate.ts";
import type { McpOptions } from "./mcp/index.ts";
import type { MindAdmin, MindAuthz } from "./admin/index.ts";
import type { ConverseService } from "./converse/converse.ts";

export interface MindOptions {
  /** Durable storage override; default is SQLite at HARNESS_DB (tests pass MemoryStorage). */
  readonly storage?: Storage;
  /** Extra extension plugins beyond the mind's own. */
  readonly plugins?: readonly Plugin[];
  /** Options for the generate faculty (token cap). */
  readonly generate?: GenerateOptions;
  /** Options for the vault (directory override). */
  readonly vault?: { readonly dir?: string };
  /** Mailbox wiring; `grantArtifacts` materializes envelope artifact grants. */
  readonly mailbox?: {
    readonly grantArtifacts?: (
      owner: string,
      from: string,
      to: string,
      ids: readonly string[],
    ) => Promise<void>;
  };
  /** Schedule-registry wiring: `onChanged` re-arms the server's cron scheduler. */
  readonly schedules?: { readonly onChanged?: () => Promise<void> };
  /** MCP connector options (config dir, timeouts, boot). */
  readonly mcp?: McpOptions;
  /** Authorization seam from the host app: host access and the admin tools (admin/index.ts). */
  readonly authz?: MindAuthz;
  /**
   * Tears a home's microVM down (phase 4): a department removal destroys the
   * department's VM. Defaults to the real `destroySandbox` on the home's
   * scope dir; tests inject a recorder so no VM runtime is touched.
   */
  readonly destroyHomeVm?: (owner: string, home: HomeRef) => Promise<void>;
  /**
   * Retires a removed bot's Linux user from its home's VM (slice 2b).
   * Defaults to the real `retireSandboxUser` path (immediate when the VM
   * runs, marked for its next boot otherwise); tests inject a recorder.
   */
  readonly retireBotUser?: (owner: string, home: HomeRef, profileId: string) => Promise<void>;
  /**
   * Reconciles the org VM's department groups on a department create or
   * delete (slice 2d). Defaults to running ext's script in the running org
   * VM; tests inject a recorder.
   */
  readonly reconcileDeptGroups?: (owner: string, script: string) => Promise<void>;
  /**
   * Deletes a department's durable shared store with its purge (slice 2d,
   * F-D9 default: delete). Defaults to removing the store directory.
   */
  readonly deleteDeptStore?: (owner: string, departmentId: string) => Promise<void>;
  /**
   * The node agents' exec transport (phase 6 slice 4): the server injects
   * the /agent dial here. The mind builds the bash tool's `node` facade
   * from it plus its own node registry; without it every node call answers
   * the owner-actionable "no node" error.
   */
  readonly nodeExec?: (
    nodeId: string,
    request: { readonly script: string; readonly cwd?: string; readonly timeoutMs: number },
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
}

/** Everything that can fail while booting the mind. */
export type MindError = External | ConfigError | Unavailable | Duplicate;

/** Wiring built in `mindLayer` that the entity composition consumes. */
export interface MindWiring {
  readonly holder: ScopeHolder;
  /** The search sidecar's file (search/db.ts): `SEARCH_DB`, or memory on test storage. */
  readonly searchDbPath: string;
  readonly vaultStore: VaultStore | null;
  readonly vaultRoot: string | null;
  readonly bindings: BindingStore | null;
  /** Late-bound converse: the registry builds before the converse layer. */
  readonly converseRef: { current?: ConverseService };
  readonly mcp?: McpOptions;
  /** Materializes mailbox envelope artifact grants (server copies files). */
  readonly grantArtifacts?: (
    owner: string,
    from: string,
    to: string,
    ids: readonly string[],
  ) => Promise<void>;
  /** Re-arms the server's cron scheduler after a schedule-registry change. */
  readonly onSchedulesChanged?: () => Promise<void>;
  /** The host-access decision, resolved per conversation (undefined = allow). */
  readonly hostAccess?: (conversationId: string) => boolean | Promise<boolean>;
  /** Who may manage bots and departments, and the full bot purge (the admin tools). */
  readonly admin?: MindAdmin;
  /** Home-VM teardown for a department removal; the entity supplies the default. */
  readonly destroyHomeVm?: (owner: string, home: HomeRef) => Promise<void>;
  /** Bot-user teardown for a bot purge; the entity supplies the default. */
  readonly retireBotUser?: (owner: string, home: HomeRef, profileId: string) => Promise<void>;
  /** Department-group reconcile for create/delete; the entity supplies the default. */
  readonly reconcileDeptGroups?: (owner: string, script: string) => Promise<void>;
  /** Department-store deletion with the purge; the entity supplies the default. */
  readonly deleteDeptStore?: (owner: string, departmentId: string) => Promise<void>;
  /** The /agent exec dial injected by the server (the `node` target's transport). */
  readonly nodeExec?: (
    nodeId: string,
    request: { readonly script: string; readonly cwd?: string; readonly timeoutMs: number },
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
}
