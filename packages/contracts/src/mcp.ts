import {
  arr,
  bool,
  lit,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";

/**
 * MCP connectors: remote or local MCP servers whose tools a bot may call.
 * Config holds no secret bytes: header values and stdio env vars point at
 * vault items by id, and OAuth tokens live sealed under the vault dir.
 */

/** `auto` tries Streamable HTTP, then falls back to legacy HTTP+SSE. */
export const McpTransportSchema = oneOf(["auto", "http", "sse", "stdio"]);

export type McpTransport = Static<typeof McpTransportSchema>;

const ItemId = str({ minLength: 1, maxLength: 200 });
const HeaderName = str({
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$",
});
const EnvName = str({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });

/** One header whose value is a vault item, e.g. `Authorization` + `Bearer `. */
export const McpHeaderRefSchema = obj(
  {
    name: HeaderName,
    item: ItemId,
    prefix: opt(str({ maxLength: 40 })),
  },
  { open: true },
);

export type McpHeaderRef = Static<typeof McpHeaderRefSchema>;

/** One stdio env var whose value is a vault item. */
export const McpEnvRefSchema = obj({ name: EnvName, item: ItemId }, { open: true });

export type McpEnvRef = Static<typeof McpEnvRefSchema>;

export const McpAuthSchema = union([
  obj({ kind: lit("none") }, { open: true }),
  /** Bearer token, API key or any custom header, all from the vault. */
  obj(
    {
      kind: lit("headers"),
      headers: arr(McpHeaderRefSchema, { minItems: 1, maxItems: 10 }),
    },
    { open: true },
  ),
  /** OAuth 2.1 per the MCP authorization spec (PKCE, resource, DCR). */
  obj(
    {
      kind: lit("oauth"),
      scope: opt(str({ maxLength: 500 })),
      /** A pre-registered client id, for servers without dynamic registration. */
      clientId: opt(str({ maxLength: 300 })),
      /**
       * Vault item holding the client id (bots collect it through a secure
       * field, same as the secret). A plain `clientId` wins when both are set.
       * The item must belong to the connector's own home (phase 4 slice 8):
       * anything else reads as absent, and the flow falls back to the
       * server's dynamic registration.
       */
      clientIdItem: opt(ItemId),
      /**
       * Vault item holding the client secret, for confidential clients
       * (e.g. Google "web application" keys). Never stored in clear here.
       * The item must belong to the connector's own home (slice 8): a
       * cross-home or profile-scoped item reads as absent (fallback).
       */
      clientSecretItem: opt(ItemId),
      /**
       * Extra query parameters on the authorization redirect, for providers
       * that need them (Google: access_type=offline for a refresh token).
       * Values are plain settings, never secrets.
       */
      authParams: opt(
        arr(
          obj(
            {
              name: str({ minLength: 1, maxLength: 100 }),
              value: str({ minLength: 1, maxLength: 200 }),
            },
            { open: true },
          ),
          { maxItems: 8 },
        ),
      ),
    },
    { open: true },
  ),
]);

export type McpAuth = Static<typeof McpAuthSchema>;

/** A local stdio server: a command run without a shell. */
export const McpCommandSchema = obj(
  {
    command: str({ minLength: 1, maxLength: 500 }),
    args: arr(str({ maxLength: 2000 }), { maxItems: 50 }),
    env: arr(McpEnvRefSchema, { maxItems: 30 }),
  },
  { open: true },
);

export type McpCommand = Static<typeof McpCommandSchema>;

/** The editable part of a server (the Connectors screen's form). */
const McpServerInputProperties = {
  /** Short label; tools surface as `<name>_<tool>`. */
  name: str({ minLength: 1, maxLength: 40 }),
  transport: McpTransportSchema,
  /** http(s) URL for http/sse/auto; null for stdio. */
  url: union([str({ minLength: 1, maxLength: 2000 }), nul()]),
  /** The command for stdio; null otherwise. */
  command: union([McpCommandSchema, nul()]),
  auth: McpAuthSchema,
  /** Bots that may use it; null = every bot. */
  profiles: union([arr(str({ maxLength: 100 }), { maxItems: 100 }), nul()]),
  enabled: bool(),
  /** Run read-only tools without asking (after the first approved use). */
  autoAllowReadOnly: bool(),
  /** MCP tool names (as the server names them) switched off. */
  disabledTools: arr(str({ maxLength: 200 }), { maxItems: 500 }),
};

export const McpServerInputSchema = obj(McpServerInputProperties, { open: true });

export type McpServerInput = Static<typeof McpServerInputSchema>;

export const McpStateSchema = oneOf([
  "connected",
  "connecting",
  "needs_sign_in",
  "failed",
  "disabled",
]);

export type McpState = Static<typeof McpStateSchema>;

export const McpToolInfoSchema = obj(
  {
    /** The bot-facing name, `<server>_<tool>`. */
    name: str(),
    /** The server's own tool name. */
    remoteName: str(),
    title: union([str(), nul()]),
    description: str(),
    readOnly: bool(),
    destructive: bool(),
    enabled: bool(),
  },
  { open: true },
);

export type McpToolInfo = Static<typeof McpToolInfoSchema>;

export const McpServerInfoSchema = obj(
  {
    ...McpServerInputProperties,
    id: str(),
    createdAt: num(),
    state: McpStateSchema,
    /** Plain-words reason for `failed` / `needs_sign_in`; null otherwise. */
    reason: union([str(), nul()]),
    /** The transport actually in use once connected (auto resolves). */
    activeTransport: union([McpTransportSchema, nul()]),
    serverName: union([str(), nul()]),
    tools: arr(McpToolInfoSchema),
    hasResources: bool(),
    /** The owner approved a first call; later read-only calls may auto-run. */
    firstUseApproved: bool(),
    /** OAuth only: tokens are stored. */
    signedIn: bool(),
    /**
     * The home (phase 4 slice 7) the connector belongs to, as a home
     * segment: `org`, or `team-<team id>`. Absent on rows stored
     * before the field existed — they read as the org (the upgrade stamps
     * them, `upgradeMcpHomes`).
     */
    home: opt(str()),
  },
  { open: true },
);

export type McpServerInfo = Static<typeof McpServerInfoSchema>;

export const McpServerListSchema = obj(
  {
    servers: arr(McpServerInfoSchema),
    /** The OAuth redirect URL to register with providers that need one. */
    callbackUrl: str(),
  },
  { open: true },
);

export type McpServerList = Static<typeof McpServerListSchema>;

/** `POST /api/mcp/servers/:id/connect` reply: open `url` to sign in. */
export const McpConnectReplySchema = obj(
  {
    url: union([str(), nul()]),
    state: McpStateSchema,
  },
  { open: true },
);

export type McpConnectReply = Static<typeof McpConnectReplySchema>;
