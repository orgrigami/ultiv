/**
 * Pure planning for bot-managed connectors: turn a bot's request into the
 * exact server input and the card the owner approves. The card names every
 * field that will change, in plain words; secrets are never arguments - a
 * key is either an existing vault item or asked for in a secure field.
 */
import type { McpServerInput, McpTransport } from "@spreissen/contracts";
import { presetById } from "./presets.ts";

export const CONNECTOR_CHANGES = [
  "connector_add",
  "connector_update",
  "connector_disable",
  "connector_enable",
  "connector_remove",
] as const;

/** Connector changes and secure inputs: never covered by "Always allow". */
export const isNeverAutoApproved = (name: string): boolean =>
  (CONNECTOR_CHANGES as readonly string[]).includes(name) || name === "secret_request";

export type ChangeKind = "add" | "update" | "disable" | "enable" | "remove";

/** What the approval card shows. Display-ready; never holds a secret. */
export interface ChangeCard {
  readonly change: ChangeKind;
  readonly server: string;
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: readonly string[];
  readonly transport: string;
  readonly auth: string;
  readonly bots: string;
  readonly runsOnMac: boolean;
  readonly changes?: readonly string[];
  readonly caution?: string;
}

export interface AddArgs {
  readonly preset?: string;
  readonly name?: string;
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: readonly { readonly name: string; readonly vaultItem?: string }[];
  readonly transport?: McpTransport;
  readonly auth?: "none" | "api_key" | "oauth";
  readonly header?: string;
  readonly prefix?: string;
  readonly vaultItem?: string;
  /** OAuth: a pre-registered client id (plain value, not a secret). */
  readonly clientId?: string;
  /** OAuth: vault item holding the client id (bots collect it securely). */
  readonly clientIdItem?: string;
  /** OAuth: requested scopes. */
  readonly oauthScope?: string;
  /** OAuth: extra authorization-redirect parameters (provider quirks). */
  readonly authParams?: readonly { readonly name: string; readonly value: string }[];
  /** OAuth only: the connector's current oauth auth, when updating one. */
  readonly previousOAuth?: Extract<import("@spreissen/contracts").McpAuth, { kind: "oauth" }>;
  readonly bots?: readonly string[];
}

/** A slot the owner fills in a secure field before the server is saved. */
export interface SecretSlot {
  readonly target: "header" | "env" | "oauthSecret";
  readonly index: number;
  readonly label: string;
}

export interface Plan {
  readonly input: McpServerInput;
  readonly card: ChangeCard;
  readonly slots: readonly SecretSlot[];
}

export interface Named {
  readonly id: string;
  readonly name: string;
}

export const TRANSPORT_WORDS: Record<McpTransport, string> = {
  auto: "Automatic (Streamable HTTP, then SSE)",
  http: "Streamable HTTP",
  sse: "SSE",
  stdio: "Local command (stdio)",
};

const findNamed = (list: readonly Named[], wanted: string): Named | undefined => {
  const key = wanted.trim().toLowerCase();
  return list.find((entry) => entry.id === wanted.trim() || entry.name.toLowerCase() === key);
};

/** Which bots get it: omitted = the asking bot; "*" or "all" = every bot. */
export const resolveBots = (
  wanted: readonly string[] | undefined,
  bots: readonly Named[],
  self: string,
): { readonly ids: string[] | null; readonly words: string } | string => {
  if (
    wanted !== undefined &&
    wanted.some((name) => ["*", "all", "every bot"].includes(name.trim().toLowerCase()))
  )
    return { ids: null, words: "Every bot" };
  const picked: Named[] = [];
  for (const name of wanted ?? [self]) {
    const bot = findNamed(bots, name);
    if (bot === undefined)
      return `no bot named "${name}" (yours: ${bots.map((entry) => entry.name).join(", ")})`;
    if (!picked.includes(bot)) picked.push(bot);
  }
  if (picked.length === 0) return "name at least one bot";
  return { ids: picked.map((bot) => bot.id), words: picked.map((bot) => bot.name).join(", ") };
};

export const botsWords = (ids: readonly string[] | null, bots: readonly Named[]): string =>
  ids === null
    ? "Every bot"
    : ids.map((id) => bots.find((bot) => bot.id === id)?.name ?? id).join(", ");

const authWords = (input: McpServerInput, items: readonly Named[], asked: boolean): string => {
  const auth = input.auth;
  if (auth.kind === "oauth") {
    const client = auth.clientId !== undefined ? ` as client ${auth.clientId.slice(0, 24)}…` : "";
    const secret =
      auth.clientSecretItem !== undefined
        ? items.find((entry) => entry.id === auth.clientSecretItem) !== undefined
          ? " with its client secret from the vault"
          : asked
            ? " - you type its client secret in a secure field next"
            : " with its client secret"
        : "";
    return `Sign in (OAuth)${client}${secret} - you press Connect on the Connectors screen`;
  }
  if (auth.kind === "none")
    return input.command !== null && input.command.env.length > 0
      ? "Keys as environment variables"
      : "No key";
  const header = auth.headers[0];
  const item = items.find((entry) => entry.id === header?.item);
  const where = `${header?.name ?? "Authorization"} header`;
  return item !== undefined
    ? `API key from vault item "${item.name}" in the ${where}`
    : asked
      ? `API key in the ${where} - you type it in a secure field next`
      : `API key in the ${where}`;
};

/** The full card for an input (add, or the after-state of other changes). */
export const cardOf = (
  change: ChangeKind,
  input: McpServerInput,
  context: { bots: string; items: readonly Named[]; asked: boolean; caution?: string | undefined },
): ChangeCard => ({
  change,
  server: input.name,
  ...(input.url !== null ? { url: input.url } : {}),
  ...(input.command !== null
    ? {
        command: input.command.command,
        args: input.command.args,
        env: input.command.env.map((entry) => entry.name),
      }
    : {}),
  transport: TRANSPORT_WORDS[input.transport],
  auth: authWords(input, context.items, context.asked),
  bots: context.bots,
  runsOnMac: input.transport === "stdio",
  ...(context.caution !== undefined ? { caution: context.caution } : {}),
});

export const addAuth = (
  args: AddArgs,
  items: readonly Named[],
  name: string,
): { auth: McpServerInput["auth"]; slots: SecretSlot[] } | string => {
  const preset = args.preset !== undefined ? presetById(args.preset) : undefined;
  const kind =
    args.auth ??
    (args.vaultItem !== undefined ? "api_key" : preset?.key === "oauth" ? "oauth" : "none");
  if (kind === "oauth") {
    const previous = args.previousOAuth;
    const scope = args.oauthScope ?? previous?.scope ?? preset?.oauth?.scope;
    const params = args.authParams ?? previous?.authParams ?? preset?.oauth?.authParams;
    const clientId = args.clientId ?? previous?.clientId;
    let clientIdItem = previous?.clientIdItem;
    if (args.clientIdItem !== undefined) {
      const found = findNamed(items, args.clientIdItem);
      if (found === undefined) return `no vault item "${args.clientIdItem}"`;
      clientIdItem = found.id;
    }
    const base = {
      kind: "oauth" as const,
      ...(scope !== undefined && scope !== "" ? { scope } : {}),
      ...(clientId !== undefined && clientId !== "" ? { clientId } : {}),
      ...(clientIdItem !== undefined ? { clientIdItem } : {}),
      ...(params !== undefined && params.length > 0 ? { authParams: [...params] } : {}),
    };
    // A vault item named for the secret pins it; a client id without a
    // secret yet queues a secure field so the owner types the secret next.
    if (args.vaultItem !== undefined) {
      const found = findNamed(items, args.vaultItem);
      if (found === undefined) return `no vault item "${args.vaultItem}"`;
      return { auth: { ...base, clientSecretItem: found.id }, slots: [] };
    }
    const kept = previous?.clientSecretItem;
    if (kept !== undefined) return { auth: { ...base, clientSecretItem: kept }, slots: [] };
    if (base.clientId !== undefined || base.clientIdItem !== undefined) {
      return {
        auth: { ...base, clientSecretItem: "" },
        slots: [{ target: "oauthSecret", index: 0, label: `OAuth client secret for ${name}` }],
      };
    }
    return { auth: base, slots: [] };
  }
  if (kind === "none") return { auth: { kind: "none" }, slots: [] };
  const header = args.header ?? preset?.header?.name ?? "Authorization";
  const prefix =
    args.prefix ??
    (header.toLowerCase() === "authorization" ? (preset?.header?.prefix ?? "Bearer ") : "");
  let item = "";
  if (args.vaultItem !== undefined) {
    const found = findNamed(items, args.vaultItem);
    if (found === undefined) return `no vault item "${args.vaultItem}"`;
    item = found.id;
  }
  const ref = { name: header, item, ...(prefix !== "" ? { prefix } : {}) };
  const slots: SecretSlot[] =
    item === "" ? [{ target: "header", index: 0, label: `API key for ${name}` }] : [];
  return { auth: { kind: "headers", headers: [ref] }, slots };
};

/** The input a bot's `connector_add` call means, or a plain error. */
export const planAdd = (
  args: AddArgs,
  context: {
    items: readonly Named[];
    bots: string;
    profiles: string[] | null;
    caution?: string | undefined;
  },
): Plan | string => {
  const preset = args.preset !== undefined ? presetById(args.preset) : undefined;
  if (args.preset !== undefined && preset === undefined) return `no preset "${args.preset}"`;
  const name = (args.name ?? preset?.name ?? "").trim();
  if (name === "") return "give the connector a name";
  const url = args.url ?? preset?.url ?? null;
  const stdio = args.command !== undefined;
  if (stdio === (url !== null)) return "give either a url or a command, not both";
  const auth = stdio
    ? { auth: { kind: "none" as const }, slots: [] }
    : addAuth(args, context.items, name);
  if (typeof auth === "string") return auth;
  const slots = [...auth.slots];
  const env: { name: string; item: string }[] = [];
  for (const entry of stdio ? (args.env ?? []) : []) {
    const found =
      entry.vaultItem !== undefined ? findNamed(context.items, entry.vaultItem) : undefined;
    if (entry.vaultItem !== undefined && found === undefined)
      return `no vault item "${entry.vaultItem}"`;
    if (found === undefined)
      slots.push({ target: "env", index: env.length, label: `${entry.name} for ${name}` });
    env.push({ name: entry.name, item: found?.id ?? "" });
  }
  const input: McpServerInput = {
    name,
    transport: stdio ? "stdio" : (args.transport ?? "auto"),
    url: stdio ? null : url,
    command: stdio ? { command: args.command ?? "", args: [...(args.args ?? [])], env } : null,
    auth: auth.auth,
    profiles: context.profiles,
    enabled: true,
    autoAllowReadOnly: false,
    disabledTools: [],
  };
  const card = cardOf("add", input, { ...context, asked: slots.length > 0 });
  return { input, card, slots };
};

/** Write the vault ids the secure fields produced into the input. */
export const fillSlots = (
  input: McpServerInput,
  slots: readonly SecretSlot[],
  ids: readonly string[],
): McpServerInput => {
  let next = input;
  slots.forEach((slot, at) => {
    const item = ids[at] ?? "";
    if (slot.target === "header" && next.auth.kind === "headers") {
      const headers = next.auth.headers.map((ref, index) =>
        index === slot.index ? { ...ref, item } : ref,
      );
      next = { ...next, auth: { kind: "headers", headers } };
    }
    if (slot.target === "oauthSecret" && next.auth.kind === "oauth") {
      next = { ...next, auth: { ...next.auth, clientSecretItem: item } };
    }
    if (slot.target === "env" && next.command !== null) {
      const env = next.command.env.map((ref, index) =>
        index === slot.index ? { ...ref, item } : ref,
      );
      next = { ...next, command: { ...next.command, env } };
    }
  });
  return next;
};

const LABELS: Partial<Record<keyof ChangeCard, string>> = {
  server: "Name",
  url: "Address",
  command: "Command",
  args: "Arguments",
  transport: "Transport",
  auth: "Key",
  bots: "Bots",
};

/** "Address: a → b" lines between two cards. */
export const diffCards = (before: ChangeCard, after: ChangeCard): string[] =>
  (Object.keys(LABELS) as (keyof ChangeCard)[]).flatMap((key) => {
    const words = (card: ChangeCard): string => {
      const value = card[key];
      return Array.isArray(value) ? value.join(" ") : String(value ?? "");
    };
    return words(before) === words(after)
      ? []
      : [`${LABELS[key]}: ${words(before) || "-"} → ${words(after) || "-"}`];
  });
