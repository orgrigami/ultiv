/**
 * The MCP connector runtime: owner-owned servers, live connections, and the
 * change feed the mind installs tools from. Add, edit, disable, remove and
 * reconnect all happen in place — no restart. Saved servers reconnect at
 * boot; each keeps a plain-words status.
 */
import { randomUUID } from "node:crypto";
import { InvalidInput, NotFound } from "@spreissen/core";
import type { McpServerInfo, McpServerInput } from "@spreissen/contracts";
import type {
  CallToolResult,
  ListResourcesResult,
  ReadResourceResult,
} from "@modelcontextprotocol/client";
import type { VaultStore } from "../vault.ts";
import {
  makeMcpConfigStore,
  validateServerInput,
  type McpConfigStore,
  type McpServerRecord,
} from "./config.ts";
import {
  DEFAULT_TUNING,
  makeConnection,
  type CallOptions,
  type ConnectionTuning,
  type McpConnection,
} from "./connection.ts";
import { uniqueSlug } from "./names.ts";
import { makeOAuthPending, makeOAuthStore, type OAuthStore } from "./oauth.ts";
import { beginSignIn, completeSignIn, providerFor, type OAuthWiring } from "./oauth-flow.ts";
import {
  clientIdOf,
  clientSecretOf,
  makeScrubber,
  resolveSecrets,
  type Scrubber,
} from "./secrets.ts";
import { infoOf, viewOf, type McpServerView } from "./views.ts";

export interface McpManagerOptions {
  readonly config?: McpConfigStore;
  readonly vault: VaultStore | null;
  /** The vault root for sealed OAuth state; null disables OAuth. */
  readonly vaultRoot: string | null;
  /** Names already taken by built-in tools (MCP tools never shadow them). */
  readonly reservedNames?: () => ReadonlySet<string>;
  readonly tuning?: Partial<ConnectionTuning>;
}

export interface McpManager {
  readonly boot: () => void;
  readonly list: (owner: string) => McpServerInfo[];
  readonly info: (owner: string, id: string) => McpServerInfo | undefined;
  /** Every enabled server of every owner, with named tools. */
  readonly views: () => McpServerView[];
  readonly view: (owner: string, id: string) => McpServerView | undefined;
  readonly add: (owner: string, input: McpServerInput) => McpServerInfo;
  readonly update: (owner: string, id: string, input: McpServerInput) => Promise<McpServerInfo>;
  readonly remove: (owner: string, id: string) => Promise<boolean>;
  readonly reconnect: (owner: string, id: string) => Promise<McpServerInfo>;
  /** OAuth: the URL to open, or null when tokens already work. */
  readonly signIn: (owner: string, id: string, redirectUrl: string) => Promise<string | null>;
  /** OAuth callback: state must match a pending sign-in (single use). */
  readonly finishSignIn: (state: string, code: string, iss?: string) => Promise<McpServerInfo>;
  readonly signOut: (owner: string, id: string) => Promise<McpServerInfo>;
  readonly approveFirstUse: (owner: string, id: string) => void;
  readonly call: (
    owner: string,
    id: string,
    remote: string,
    args: Record<string, unknown>,
    options: CallOptions,
  ) => Promise<CallToolResult>;
  readonly listResources: (
    owner: string,
    id: string,
    cursor: string | undefined,
    options: CallOptions,
  ) => Promise<ListResourcesResult>;
  readonly readResource: (
    owner: string,
    id: string,
    uri: string,
    options: CallOptions,
  ) => Promise<ReadResourceResult>;
  /** Remove this server's secrets (header/env values, OAuth tokens) from text. */
  readonly scrub: (owner: string, id: string, text: string) => string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly close: () => Promise<void>;
}

interface Entry {
  connection: McpConnection | null;
  readonly scrubber: Scrubber;
}

const keyOf = (owner: string, id: string): string => `${owner}\u0000${id}`;

export const defaultRedirectUrl = (): string =>
  process.env.MCP_OAUTH_CALLBACK_URL?.trim() || "http://localhost:8787/api/mcp/oauth/callback";

interface Core {
  readonly config: McpConfigStore;
  readonly options: McpManagerOptions;
  readonly tuning: ConnectionTuning;
  readonly entries: Map<string, Entry>;
  readonly listeners: Set<() => void>;
  readonly oauthStore: OAuthStore | null;
  readonly wiring: OAuthWiring | null;
  readonly redirects: Map<string, string>;
}

const notify = (core: Core): void => {
  for (const listener of core.listeners) {
    try {
      listener();
    } catch (cause) {
      console.error("mcp listener failed:", cause);
    }
  }
};

const entryOf = (core: Core, owner: string, id: string): Entry => {
  const key = keyOf(owner, id);
  let entry = core.entries.get(key);
  if (entry === undefined) {
    entry = { connection: null, scrubber: makeScrubber("connector secret") };
    core.entries.set(key, entry);
  }
  return entry;
};

const recordOf = (core: Core, owner: string, id: string): McpServerRecord => {
  const record = core.config.get(owner, id);
  if (record === undefined) throw new NotFound({ what: `connector ${id}` });
  return record;
};

const startConnection = (core: Core, record: McpServerRecord): void => {
  const entry = entryOf(core, record.owner, record.id);
  if (entry.connection !== null || !record.enabled) return;
  const { owner, id } = record;
  entry.connection = makeConnection({
    record: () => recordOf(core, owner, id),
    secrets: (current) => resolveSecrets(core.options.vault, current),
    workDir: () => core.config.workDir(owner, id),
    oauth: () =>
      core.wiring === null ? null : providerFor(core.wiring, recordOf(core, owner, id)),
    scrubber: entry.scrubber,
    onChange: () => notify(core),
    tuning: core.tuning,
  });
  entry.connection.start();
};

const stopConnection = async (core: Core, owner: string, id: string): Promise<void> => {
  const entry = core.entries.get(keyOf(owner, id));
  const connection = entry?.connection ?? null;
  if (entry !== undefined) entry.connection = null;
  if (connection !== null) await connection.close();
};

const viewFor = (core: Core, record: McpServerRecord): McpServerView =>
  viewOf(
    record,
    core.entries.get(keyOf(record.owner, record.id))?.connection?.status(),
    core.oauthStore?.hasTokens(record.owner, record.id) ?? false,
    core.options.reservedNames?.() ?? new Set(),
  );

const liveConnection = (core: Core, owner: string, id: string): McpConnection => {
  const record = recordOf(core, owner, id);
  const connection = core.entries.get(keyOf(owner, id))?.connection ?? null;
  if (!record.enabled || connection === null)
    throw new InvalidInput({ reason: "this connector is switched off" });
  return connection;
};

const makeCore = (options: McpManagerOptions): Core => {
  const oauthStore = options.vaultRoot === null ? null : makeOAuthStore(options.vaultRoot);
  const entries = new Map<string, Entry>();
  const redirects = new Map<string, string>();
  const core: Core = {
    config: options.config ?? makeMcpConfigStore(),
    options,
    tuning: { ...DEFAULT_TUNING, ...options.tuning },
    entries,
    listeners: new Set(),
    oauthStore,
    redirects,
    wiring:
      oauthStore === null
        ? null
        : {
            store: oauthStore,
            pending: makeOAuthPending(),
            // The last sign-in's redirect wins, so a restart keeps the registered client.
            redirectFor: (owner, id) =>
              redirects.get(keyOf(owner, id)) ??
              oauthStore.read(owner, id).clientRedirect ??
              defaultRedirectUrl(),
            onSecretForms: (owner, id, forms) => {
              const entry = entries.get(keyOf(owner, id));
              entry?.scrubber.add(forms);
            },
            clientSecretFor: (record) => clientSecretOf(options.vault, record),
            clientIdFor: (record) => clientIdOf(options.vault, record),
          },
  };
  return core;
};

const saveInput = async (
  core: Core,
  owner: string,
  id: string,
  input: McpServerInput,
): Promise<McpServerInfo> => {
  validateServerInput(input);
  const before = recordOf(core, owner, id);
  const record: McpServerRecord = { ...before, ...input };
  core.config.put(record);
  const reconnectNeeded =
    JSON.stringify([before.transport, before.url, before.command, before.auth, before.enabled]) !==
    JSON.stringify([record.transport, record.url, record.command, record.auth, record.enabled]);
  if (reconnectNeeded) {
    await stopConnection(core, owner, id);
    startConnection(core, record);
  }
  notify(core);
  return infoOf(viewFor(core, record));
};

const addServer = (core: Core, owner: string, input: McpServerInput): McpServerInfo => {
  validateServerInput(input);
  const used = new Set(core.config.all().map((record) => record.slug));
  for (const name of core.options.reservedNames?.() ?? []) used.add(name.split("_")[0] ?? name);
  const record: McpServerRecord = {
    ...input,
    id: randomUUID(),
    owner,
    slug: uniqueSlug(input.name, used),
    createdAt: Date.now(),
    firstUseApproved: false,
  };
  core.config.put(record);
  startConnection(core, record);
  notify(core);
  return infoOf(viewFor(core, record));
};

const finish = async (
  core: Core,
  state: string,
  code: string,
  iss: string | undefined,
): Promise<McpServerInfo> => {
  const wiring = core.wiring;
  const bound = wiring?.pending.take(state);
  if (wiring === null || wiring === undefined || bound === undefined) {
    throw new InvalidInput({
      reason: "this sign-in link expired or was already used; press Connect again",
    });
  }
  const record = recordOf(core, bound.owner, bound.id);
  await completeSignIn(wiring, record, code, iss);
  await entryOf(core, record.owner, record.id).connection?.reconnect();
  return infoOf(viewFor(core, record));
};

export const makeMcpManager = (options: McpManagerOptions): McpManager => {
  const core = makeCore(options);
  return {
    boot: () => {
      for (const record of core.config.all()) startConnection(core, record);
    },
    list: (owner) => core.config.list(owner).map((record) => infoOf(viewFor(core, record))),
    info: (owner, id) => {
      const record = core.config.get(owner, id);
      return record === undefined ? undefined : infoOf(viewFor(core, record));
    },
    views: () =>
      core.config
        .all()
        .filter((record) => record.enabled)
        .map((record) => viewFor(core, record)),
    view: (owner, id) => {
      const record = core.config.get(owner, id);
      return record === undefined ? undefined : viewFor(core, record);
    },
    add: (owner, input) => addServer(core, owner, input),
    update: (owner, id, input) => saveInput(core, owner, id, input),
    remove: async (owner, id) => {
      await stopConnection(core, owner, id);
      core.entries.delete(keyOf(owner, id));
      core.oauthStore?.clear(owner, id);
      const removed = core.config.remove(owner, id);
      notify(core);
      return removed;
    },
    reconnect: async (owner, id) => {
      const record = recordOf(core, owner, id);
      const entry = entryOf(core, owner, id);
      if (entry.connection === null) startConnection(core, record);
      else await entry.connection.reconnect();
      return infoOf(viewFor(core, record));
    },
    signIn: async (owner, id, redirectUrl) => {
      const record = recordOf(core, owner, id);
      if (record.auth.kind !== "oauth")
        throw new InvalidInput({ reason: "this connector does not use sign-in" });
      if (core.wiring === null)
        throw new InvalidInput({ reason: "sign-in needs the vault (set VAULT_KEY)" });
      core.redirects.set(keyOf(owner, id), redirectUrl);
      const url = await beginSignIn(core.wiring, record);
      if (url === null) await entryOf(core, owner, id).connection?.reconnect();
      return url;
    },
    finishSignIn: (state, code, iss) => finish(core, state, code, iss),
    signOut: async (owner, id) => {
      core.oauthStore?.clear(owner, id);
      await entryOf(core, owner, id).connection?.reconnect();
      return infoOf(viewFor(core, recordOf(core, owner, id)));
    },
    approveFirstUse: (owner, id) => {
      const record = recordOf(core, owner, id);
      if (!record.firstUseApproved) core.config.put({ ...record, firstUseApproved: true });
    },
    call: (owner, id, remote, args, callOptions) =>
      liveConnection(core, owner, id).call(remote, args, callOptions),
    listResources: (owner, id, cursor, callOptions) =>
      liveConnection(core, owner, id).listResources(cursor, callOptions),
    readResource: (owner, id, uri, callOptions) =>
      liveConnection(core, owner, id).readResource(uri, callOptions),
    scrub: (owner, id, text) => entryOf(core, owner, id).scrubber.scrub(text),
    subscribe: (listener) => {
      core.listeners.add(listener);
      return () => core.listeners.delete(listener);
    },
    close: async () => {
      await Promise.all([...core.entries.values()].map((entry) => entry.connection?.close()));
      core.entries.clear();
    },
  };
};
