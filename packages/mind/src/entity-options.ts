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
}

/** Everything that can fail while booting the mind. */
export type MindError = External | ConfigError | Unavailable | Duplicate;

/** Wiring built in `mindLayer` that the entity composition consumes. */
export interface MindWiring {
  readonly holder: ScopeHolder;
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
}
