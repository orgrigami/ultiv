/**
 * Shared steps for the connector-management tools: scope, lookups, the
 * owner's card, the secure-field ask, and waiting for a live connection.
 */
import { Effect } from "effect";
import { Value } from "typebox/value";
import {
  McpServerInputSchema,
  type McpServerInfo,
  type McpServerInput,
} from "@spreissen/contracts";
import { validateServerInput, type VaultStore } from "@spreissen/ext";
import type { SecretRequestsService } from "../secrets/requests.ts";
import type { McpMindDeps } from "./access.ts";
import type { ChangeCard, Named, SecretSlot } from "./manage.ts";

export interface ManageDeps extends McpMindDeps {
  readonly secrets: SecretRequestsService;
  readonly vault: VaultStore | null;
  /** How long a tool waits for a new connection to settle (default 15 s). */
  readonly settleMs?: number;
}

export interface Scope {
  readonly conversationId: string;
  readonly owner: string;
  readonly profileId: string;
}

export const scopeOf = (deps: ManageDeps, conversationId: string): Scope | string => {
  const scope = deps.profiles.scopeOf(conversationId);
  return scope === undefined
    ? "this conversation belongs to no bot"
    : { conversationId, owner: scope.owner, profileId: scope.profileId };
};

export const itemsOf = (deps: ManageDeps, owner: string): Named[] =>
  (deps.vault?.list(owner) ?? []).map(({ id, name }) => ({ id, name }));

export const botsOf = async (deps: ManageDeps, owner: string): Promise<Named[]> =>
  (await deps.profiles.list(owner)).map(({ id, name }) => ({ id, name }));

/** Best effort: the card warns when the ask may not come from the owner. */
export const cautionOf = (deps: ManageDeps, conversationId: string): string | undefined => {
  const kind = deps.profiles.scopeOf(conversationId)?.kind;
  if (deps.notes.has(conversationId))
    return "This chat has read connector output. Approve only if you asked for this yourself.";
  if (kind === "dm" || kind === "room" || kind === "task")
    return "This came from a background task or another bot, not your own chat. Approve only if you asked for it.";
  return undefined;
};

/** Schema and shape rules, with secret slots filled by placeholders. */
export const checkInput = (input: McpServerInput, slots: readonly SecretSlot[]): string | null => {
  const filled = JSON.parse(JSON.stringify(input)) as McpServerInput;
  if (slots.length > 0 && filled.auth.kind === "headers")
    filled.auth.headers.forEach((ref) => Object.assign(ref, { item: ref.item || "pending" }));
  filled.command?.env.forEach((ref) => Object.assign(ref, { item: ref.item || "pending" }));
  if (slots.some((slot) => slot.target === "oauthSecret") && filled.auth.kind === "oauth")
    filled.auth.clientSecretItem = "pending";
  if (!Value.Check(McpServerInputSchema, filled)) {
    const first = [...Value.Errors(McpServerInputSchema, filled)][0];
    return `invalid connector: ${first?.instancePath || "input"} ${first?.message ?? ""}`.trim();
  }
  try {
    validateServerInput(filled);
    return null;
  } catch (cause) {
    return String((cause as { reason?: unknown }).reason ?? "invalid connector");
  }
};

export const DENIED =
  "the owner did not approve this connector change; nothing changed - do not retry";

/** Show the owner the exact change; true only on approve. */
export const askOwner = async (
  deps: ManageDeps,
  scope: Scope,
  callId: string,
  name: string,
  card: ChangeCard,
): Promise<boolean> =>
  Effect.runPromise(
    deps.approvals.request(scope.conversationId, callId, { callId, name, input: card }),
  );

/** Ask for every slot in one secure card; vault ids in slot order, or the reason. */
export const askSecrets = async (
  deps: ManageDeps,
  scope: Scope,
  callId: string,
  server: string,
  slots: readonly SecretSlot[],
  usedFor: string,
): Promise<string[] | string> => {
  if (slots.length === 0) return [];
  const outcome = await deps.secrets.ask(scope.conversationId, `${callId}:key`, {
    label: slots.length === 1 ? (slots[0]?.label ?? server) : `Keys for ${server}`,
    purpose: `So ${server} can connect. Stored encrypted in your vault; the bot never sees it.`,
    usedFor,
    fields: slots.map((slot, index) => ({ key: `f${index}`, label: slot.label })),
  });
  if (!outcome.ok) return `${outcome.reason}; the connector was not added`;
  return slots.map(
    (_, index) => outcome.stored.find((entry) => entry.key === `f${index}`)?.itemId ?? "",
  );
};

/** Wait (bounded) for a connection to leave "connecting". */
export const settle = (
  deps: ManageDeps,
  owner: string,
  id: string,
): Promise<McpServerInfo | undefined> =>
  new Promise((resolve) => {
    const done = (): boolean => {
      const info = deps.manager.info(owner, id);
      if (info !== undefined && info.state === "connecting") return false;
      clearTimeout(timer);
      unsubscribe();
      resolve(info);
      return true;
    };
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(deps.manager.info(owner, id));
    }, deps.settleMs ?? 15_000);
    const unsubscribe = deps.manager.subscribe(() => void done());
    done();
  });

/** What the bot learns after a change: state and tool names, never secrets. */
export const reportOf = (info: McpServerInfo | undefined, verb: string): string => {
  if (info === undefined) return `${verb}, but the connector is gone now`;
  const tools = info.tools.filter((tool) => tool.enabled).map((tool) => tool.name);
  const head = `${verb} "${info.name}" (id ${info.id}).`;
  if (info.state === "connected")
    return `${head} Connected with ${tools.length} tool(s): ${tools.join(", ") || "none"}. Load them with connector_load.`;
  if (info.state === "needs_sign_in")
    return `${head} It needs sign-in: ask your owner to press Connect on the Connectors screen.`;
  if (info.state === "disabled") return `${head} It is switched off.`;
  if (info.state === "connecting")
    return `${head} Still connecting; check again with connector_list.`;
  return `${head} It failed to connect: ${info.reason ?? "unknown reason"}.`;
};

/** An owner's server by id, name or short name. */
export const findOwned = (
  deps: ManageDeps,
  owner: string,
  wanted: string,
): McpServerInfo | string => {
  const key = wanted.trim().toLowerCase();
  const servers = deps.manager.list(owner);
  const found = servers.find(
    (info) =>
      info.id === wanted.trim() ||
      info.name.toLowerCase() === key ||
      deps.manager.view(owner, info.id)?.record.slug === key,
  );
  if (found !== undefined) return found;
  return `no connector "${wanted}" (yours: ${servers.map((info) => info.name).join(", ") || "none"})`;
};

export const inputOf = (info: McpServerInfo): McpServerInput => ({
  name: info.name,
  transport: info.transport,
  url: info.url,
  command: info.command,
  auth: info.auth,
  profiles: info.profiles,
  enabled: info.enabled,
  autoAllowReadOnly: info.autoAllowReadOnly,
  disabledTools: info.disabledTools,
});

export const hostOf = (input: McpServerInput): string => {
  if (input.url === null) return "the local command's environment";
  try {
    return `only to ${new URL(input.url).host}`;
  } catch {
    return input.url;
  }
};
