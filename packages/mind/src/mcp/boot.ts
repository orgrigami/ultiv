/**
 * Connector start-up inside the mind: the manager (saved servers reconnect
 * now, in the background), the registry wiring, and the names MCP tools must
 * never shadow (every tool installed before connectors).
 */
import type { Registry } from "@earendil-works/pi-durable";
import type { ProfileInfo } from "@spriessen/contracts";
import type { HostSwitchWatch } from "../org/host-switch.ts";
import {
  makeMcpConfigStore,
  makeMcpManager,
  mcpDir,
  type BindingStore,
  type ConnectionTuning,
  type McpManager,
  type VaultStore,
} from "@spriessen/ext";
import type { ApprovalsService } from "../approvals.ts";
import type { AuditService } from "../audit/audit.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import {
  makeSecretRequests,
  SECRET_REQUEST,
  type SecretRequestsService,
} from "../secrets/requests.ts";
import { makeUntrustedNotes } from "./access.ts";
import { CONNECTOR_LOAD, CONNECTOR_RESOURCES } from "./connector-tools.ts";
import { wireMcp, type McpWiring } from "./install.ts";
import { MANAGE_TOOLS } from "./manage-tools.ts";

export interface McpOptions {
  /** Server config root (default MCP_DIR or var/mcp). */
  readonly dir?: string;
  readonly tuning?: Partial<ConnectionTuning>;
  /** Per-call timeout (default 120 s). */
  readonly callTimeoutMs?: number;
  /** Connect saved servers at start (default true). */
  readonly boot?: boolean;
  /** How long bot-added connectors wait to settle (default 15 s). */
  readonly settleMs?: number;
  /** Secure-input wait (default 10 min). */
  readonly secretTimeoutMs?: number;
  /**
   * The host-access switch for the HOST-DIRECT (stdio) connectors (slice
   * 10): per-call refusal before any approval, and the synchronous answer
   * for the prompt section. Absent in bare tests — connectors behave as before.
   */
  readonly hostAccess?: (conversationId: string) => boolean | Promise<boolean>;
  readonly hostAllowed?: (profile: ProfileInfo) => boolean;
}

/**
 * Merge the app's MCP options with the mind's host-access seam (slice 10):
 * the switch derived from `authz.hostAccess` decides; the section reads the
 * watch's snapshot lazily (the watch boots after the connectors).
 */
export const mcpOptionsWithHostSwitch = (
  options: McpOptions | undefined,
  host:
    | {
        readonly hostAccess: (conversationId: string) => boolean | Promise<boolean>;
        readonly watch: () => HostSwitchWatch | undefined;
      }
    | undefined,
): McpOptions => ({
  ...options,
  ...(host === undefined
    ? {}
    : {
        hostAccess: host.hostAccess,
        hostAllowed: (profile: ProfileInfo) => host.watch()?.allows(profile) ?? true,
      }),
});

export interface McpRuntime {
  readonly manager: McpManager;
  readonly wiring: McpWiring;
  /** Secure inputs waiting for the owner's browser. */
  readonly secrets: SecretRequestsService;
  readonly close: () => Promise<void>;
}

export const startMcp = (
  registry: Registry,
  services: {
    readonly approvals: ApprovalsService;
    readonly audit: AuditService;
    readonly profiles: ProfilesService;
  },
  vault: {
    readonly store: VaultStore | null;
    readonly root: string | null;
    readonly bindings: BindingStore | null;
  },
  options: McpOptions = {},
): McpRuntime => {
  const reserved = new Set(
    registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name),
  );
  reserved.add(CONNECTOR_LOAD);
  reserved.add(CONNECTOR_RESOURCES);
  for (const name of [...MANAGE_TOOLS, SECRET_REQUEST]) reserved.add(name);
  const manager = makeMcpManager({
    config: makeMcpConfigStore(options.dir ?? mcpDir()),
    vault: vault.store,
    vaultRoot: vault.root,
    reservedNames: () => reserved,
    ...(options.tuning !== undefined ? { tuning: options.tuning } : {}),
  });
  const secrets = makeSecretRequests({
    approvals: services.approvals,
    vault: vault.store,
    ownerOf: (conversationId) => services.profiles.scopeOf(conversationId)?.owner,
    ...(options.secretTimeoutMs !== undefined ? { timeoutMs: options.secretTimeoutMs } : {}),
  });
  const wiring = wireMcp(registry, {
    manager,
    ...services,
    notes: makeUntrustedNotes(),
    callTimeoutMs: options.callTimeoutMs ?? 120_000,
    secrets,
    vault: vault.store,
    bindings: vault.bindings,
    ...(options.hostAccess !== undefined ? { hostAccess: options.hostAccess } : {}),
    ...(options.hostAllowed !== undefined ? { hostAllowed: options.hostAllowed } : {}),
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
  });
  if (options.boot !== false) manager.boot();
  return {
    manager,
    wiring,
    secrets,
    close: async () => {
      wiring.close();
      await manager.close();
    },
  };
};
