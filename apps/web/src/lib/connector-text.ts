/**
 * Plain words for the Connectors screen, and the form ↔ request mapping.
 * Pure (no React), so the wording and the shapes are unit-tested.
 */
import type { McpServerInfo, McpServerInput, McpState, McpTransport } from "@spreissen/contracts";

export type ConnectorKind = "web" | "command";
export type AuthChoice = "none" | "headers" | "oauth";

export interface SecretRow {
  /** Header or environment variable name. */
  name: string;
  /** Vault item id ("" = not chosen yet). */
  item: string;
  /** Header value prefix, e.g. "Bearer ". */
  prefix: string;
}

export interface ConnectorForm {
  name: string;
  kind: ConnectorKind;
  url: string;
  transport: McpTransport;
  /** The command line, e.g. `npx -y @modelcontextprotocol/server-everything`. */
  commandLine: string;
  auth: AuthChoice;
  headers: SecretRow[];
  env: SecretRow[];
  /** OAuth extras: requested scopes and a pre-registered client id (both optional). */
  oauthScope: string;
  oauthClientId: string;
  /** The client secret's vault item — zero or one row (confidential clients). */
  oauthSecret: SecretRow[];
  /** Extra authorization-redirect parameters (e.g. Google: access_type=offline). */
  oauthAuthParams: { name: string; value: string }[];
  /** null = every bot; else the chosen bot ids. */
  profiles: string[] | null;
  enabled: boolean;
  autoAllowReadOnly: boolean;
  disabledTools: string[];
}

export const emptyConnectorForm = (): ConnectorForm => ({
  name: "",
  kind: "web",
  url: "",
  transport: "auto",
  commandLine: "",
  auth: "none",
  headers: [],
  env: [],
  oauthScope: "",
  oauthClientId: "",
  oauthSecret: [],
  oauthAuthParams: [],
  profiles: null,
  enabled: true,
  autoAllowReadOnly: false,
  disabledTools: [],
});

export const TRANSPORT_LABEL: Record<Exclude<McpTransport, "stdio">, string> = {
  auto: "Automatic",
  http: "Streamable HTTP",
  sse: "SSE (older servers)",
};

export const STATE_LABEL: Record<McpState, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  needs_sign_in: "Needs sign-in",
  failed: "Not working",
  disabled: "Off",
};

/** One status line: the label, plus the reason when there is one. */
export const statusLine = (info: Pick<McpServerInfo, "state" | "reason">): string =>
  info.reason === null ||
  info.state === "connected" ||
  info.state === "disabled" ||
  // The Connect button beside it already says this.
  /^press Connect/i.test(info.reason)
    ? STATE_LABEL[info.state]
    : `${STATE_LABEL[info.state]} — ${info.reason}`;

/** Badge tone per state. */
export const stateTone = (state: McpState): "good" | "busy" | "warn" | "bad" | "off" =>
  ({
    connected: "good",
    connecting: "busy",
    needs_sign_in: "warn",
    failed: "bad",
    disabled: "off",
  })[state] as "good" | "busy" | "warn" | "bad" | "off";

/** Split a command line like a shell would for simple quoting ("…", '…', \ escapes). */
export const splitCommandLine = (line: string): string[] => {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) {
        index += 1;
        current += line.charAt(index);
      } else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      index += 1;
      current += line.charAt(index);
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current !== "") words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started || current !== "") words.push(current);
  return words;
};

/** Quote words back into one editable line. */
export const joinCommandLine = (words: readonly string[]): string =>
  words.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word))).join(" ");

const filled = (rows: readonly SecretRow[]): SecretRow[] =>
  rows.filter((row) => row.name.trim() !== "" && row.item !== "");

/** The request body for a form; throws a plain-words Error when something is missing. */
export const inputOfForm = (form: ConnectorForm): McpServerInput => {
  const name = form.name.trim();
  if (name === "") throw new Error("Give the connector a name.");
  const common = {
    name,
    profiles: form.profiles,
    enabled: form.enabled,
    autoAllowReadOnly: form.autoAllowReadOnly,
    disabledTools: form.disabledTools,
  };
  if (form.kind === "command") {
    const [command, ...args] = splitCommandLine(form.commandLine.trim());
    if (command === undefined || command === "") throw new Error("Enter the command to run.");
    const env = filled(form.env).map((row) => ({ name: row.name.trim(), item: row.item }));
    return {
      ...common,
      transport: "stdio",
      url: null,
      command: { command, args, env },
      auth: { kind: "none" },
    };
  }
  const url = form.url.trim();
  if (!/^https?:\/\/\S+$/i.test(url))
    throw new Error("Enter the server's web address (https://…).");
  const headers = filled(form.headers).map((row) => ({
    name: row.name.trim(),
    item: row.item,
    ...(row.prefix !== "" ? { prefix: row.prefix } : {}),
  }));
  if (form.auth === "headers" && headers.length === 0) {
    throw new Error("Pick a header name and the vault item that holds its value.");
  }
  const authParams = form.oauthAuthParams
    .map((row) => ({ name: row.name.trim(), value: row.value.trim() }))
    .filter((row) => row.name !== "" && row.value !== "");
  const secretItem = filled(form.oauthSecret)[0]?.item ?? "";
  return {
    ...common,
    transport: form.transport === "stdio" ? "auto" : form.transport,
    url,
    command: null,
    auth:
      form.auth === "oauth"
        ? {
            kind: "oauth",
            ...(form.oauthScope.trim() !== "" ? { scope: form.oauthScope.trim() } : {}),
            ...(form.oauthClientId.trim() !== "" ? { clientId: form.oauthClientId.trim() } : {}),
            ...(secretItem !== "" ? { clientSecretItem: secretItem } : {}),
            ...(authParams.length > 0 ? { authParams } : {}),
          }
        : form.auth === "headers"
          ? { kind: "headers", headers }
          : { kind: "none" },
  };
};

/** The form for editing a saved connector. */
export const formOfInfo = (info: McpServerInfo): ConnectorForm => ({
  ...emptyConnectorForm(),
  name: info.name,
  kind: info.transport === "stdio" ? "command" : "web",
  url: info.url ?? "",
  transport: info.transport,
  commandLine:
    info.command === null ? "" : joinCommandLine([info.command.command, ...info.command.args]),
  auth: info.auth.kind,
  headers:
    info.auth.kind === "headers"
      ? info.auth.headers.map((row) => ({
          name: row.name,
          item: row.item,
          prefix: row.prefix ?? "",
        }))
      : [],
  env: (info.command?.env ?? []).map((row) => ({ ...row, prefix: "" })),
  oauthScope: info.auth.kind === "oauth" ? (info.auth.scope ?? "") : "",
  oauthClientId: info.auth.kind === "oauth" ? (info.auth.clientId ?? "") : "",
  oauthSecret:
    info.auth.kind === "oauth" && info.auth.clientSecretItem !== undefined
      ? [{ name: "client_secret", item: info.auth.clientSecretItem, prefix: "" }]
      : [],
  oauthAuthParams: info.auth.kind === "oauth" ? [...(info.auth.authParams ?? [])] : [],
  profiles: info.profiles,
  enabled: info.enabled,
  autoAllowReadOnly: info.autoAllowReadOnly,
  disabledTools: [...info.disabledTools],
});

/** Where a connector points, for the row's second line. */
export const targetOf = (info: McpServerInfo): string => {
  if (info.command !== null) return joinCommandLine([info.command.command, ...info.command.args]);
  try {
    const url = new URL(info.url ?? "");
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return info.url ?? "";
  }
};

/** The tool's kind in plain words. */
export const toolKind = (tool: { readOnly: boolean; destructive: boolean }): string =>
  tool.destructive
    ? "can change or delete things"
    : tool.readOnly
      ? "read-only"
      : "can make changes";
