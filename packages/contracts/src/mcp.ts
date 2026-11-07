import { Type, type Static } from "typebox";

/**
 * MCP connectors: remote or local MCP servers whose tools a bot may call.
 * Config holds no secret bytes: header values and stdio env vars point at
 * vault items by id, and OAuth tokens live sealed under the vault dir.
 */

/** `auto` tries Streamable HTTP, then falls back to legacy HTTP+SSE. */
export const McpTransportSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("http"),
  Type.Literal("sse"),
  Type.Literal("stdio"),
]);

export type McpTransport = Static<typeof McpTransportSchema>;

const ItemId = Type.String({ minLength: 1, maxLength: 200 });
const HeaderName = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$",
});
const EnvName = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });

/** One header whose value is a vault item, e.g. `Authorization` + `Bearer `. */
export const McpHeaderRefSchema = Type.Object({
  name: HeaderName,
  item: ItemId,
  prefix: Type.Optional(Type.String({ maxLength: 40 })),
});

export type McpHeaderRef = Static<typeof McpHeaderRefSchema>;

/** One stdio env var whose value is a vault item. */
export const McpEnvRefSchema = Type.Object({ name: EnvName, item: ItemId });

export type McpEnvRef = Static<typeof McpEnvRefSchema>;

export const McpAuthSchema = Type.Union([
  Type.Object({ kind: Type.Literal("none") }),
  /** Bearer token, API key or any custom header, all from the vault. */
  Type.Object({
    kind: Type.Literal("headers"),
    headers: Type.Array(McpHeaderRefSchema, { minItems: 1, maxItems: 10 }),
  }),
  /** OAuth 2.1 per the MCP authorization spec (PKCE, resource, DCR). */
  Type.Object({
    kind: Type.Literal("oauth"),
    scope: Type.Optional(Type.String({ maxLength: 500 })),
    /** A pre-registered client id, for servers without dynamic registration. */
    clientId: Type.Optional(Type.String({ maxLength: 300 })),
    /**
     * Vault item holding the client id (bots collect it through a secure
     * field, same as the secret). A plain `clientId` wins when both are set.
     * The item must belong to the connector's own home (phase 4 slice 8):
     * anything else reads as absent, and the flow falls back to the
     * server's dynamic registration.
     */
    clientIdItem: Type.Optional(ItemId),
    /**
     * Vault item holding the client secret, for confidential clients
     * (e.g. Google "web application" keys). Never stored in clear here.
     * The item must belong to the connector's own home (slice 8): a
     * cross-home or profile-scoped item reads as absent (fallback).
     */
    clientSecretItem: Type.Optional(ItemId),
    /**
     * Extra query parameters on the authorization redirect, for providers
     * that need them (Google: access_type=offline for a refresh token).
     * Values are plain settings, never secrets.
     */
    authParams: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 100 }),
          value: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        { maxItems: 8 },
      ),
    ),
  }),
]);

export type McpAuth = Static<typeof McpAuthSchema>;

/** A local stdio server: a command run without a shell. */
export const McpCommandSchema = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 500 }),
  args: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 50 }),
  env: Type.Array(McpEnvRefSchema, { maxItems: 30 }),
});

export type McpCommand = Static<typeof McpCommandSchema>;

/** The editable part of a server (the Connectors screen's form). */
export const McpServerInputSchema = Type.Object({
  /** Short label; tools surface as `<name>_<tool>`. */
  name: Type.String({ minLength: 1, maxLength: 40 }),
  transport: McpTransportSchema,
  /** http(s) URL for http/sse/auto; null for stdio. */
  url: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
  /** The command for stdio; null otherwise. */
  command: Type.Union([McpCommandSchema, Type.Null()]),
  auth: McpAuthSchema,
  /** Bots that may use it; null = every bot. */
  profiles: Type.Union([
    Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 }),
    Type.Null(),
  ]),
  enabled: Type.Boolean(),
  /** Run read-only tools without asking (after the first approved use). */
  autoAllowReadOnly: Type.Boolean(),
  /** MCP tool names (as the server names them) switched off. */
  disabledTools: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 500 }),
});

export type McpServerInput = Static<typeof McpServerInputSchema>;

export const McpStateSchema = Type.Union([
  Type.Literal("connected"),
  Type.Literal("connecting"),
  Type.Literal("needs_sign_in"),
  Type.Literal("failed"),
  Type.Literal("disabled"),
]);

export type McpState = Static<typeof McpStateSchema>;

export const McpToolInfoSchema = Type.Object({
  /** The bot-facing name, `<server>_<tool>`. */
  name: Type.String(),
  /** The server's own tool name. */
  remoteName: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  description: Type.String(),
  readOnly: Type.Boolean(),
  destructive: Type.Boolean(),
  enabled: Type.Boolean(),
});

export type McpToolInfo = Static<typeof McpToolInfoSchema>;

export const McpServerInfoSchema = Type.Intersect([
  McpServerInputSchema,
  Type.Object({
    id: Type.String(),
    createdAt: Type.Number(),
    state: McpStateSchema,
    /** Plain-words reason for `failed` / `needs_sign_in`; null otherwise. */
    reason: Type.Union([Type.String(), Type.Null()]),
    /** The transport actually in use once connected (auto resolves). */
    activeTransport: Type.Union([McpTransportSchema, Type.Null()]),
    serverName: Type.Union([Type.String(), Type.Null()]),
    tools: Type.Array(McpToolInfoSchema),
    hasResources: Type.Boolean(),
    /** The owner approved a first call; later read-only calls may auto-run. */
    firstUseApproved: Type.Boolean(),
    /** OAuth only: tokens are stored. */
    signedIn: Type.Boolean(),
    /**
     * The home (phase 4 slice 7) the connector belongs to, as a home
     * segment: `org`, or `team-<team id>`. Absent on rows stored
     * before the field existed — they read as the org (the upgrade stamps
     * them, `upgradeMcpHomes`).
     */
    home: Type.Optional(Type.String()),
  }),
]);

export type McpServerInfo = Static<typeof McpServerInfoSchema>;

export const McpServerListSchema = Type.Object({
  servers: Type.Array(McpServerInfoSchema),
  /** The OAuth redirect URL to register with providers that need one. */
  callbackUrl: Type.String(),
});

export type McpServerList = Static<typeof McpServerListSchema>;

/** `POST /api/mcp/servers/:id/connect` reply: open `url` to sign in. */
export const McpConnectReplySchema = Type.Object({
  url: Type.Union([Type.String(), Type.Null()]),
  state: McpStateSchema,
});

export type McpConnectReply = Static<typeof McpConnectReplySchema>;
