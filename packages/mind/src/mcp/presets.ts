/**
 * Known connectors a bot can add by id. Only servers whose URL was checked
 * against the provider's own docs belong here (context7: upstash/context7
 * README; deepwiki: docs.devin.ai; linear: linear.app/docs/mcp; notion:
 * developers.notion.com). Adding still goes through the owner's card.
 */
export type PresetKey = "none" | "optional" | "oauth";

export interface McpPreset {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly about: string;
  /** none: keyless; optional: works keyless, a key raises limits; oauth: sign in. */
  readonly key: PresetKey;
  /** Where an optional key goes. */
  readonly header?: { readonly name: string; readonly prefix: string };
  /** OAuth sign-in defaults (scopes, provider quirks) applied unless overridden. */
  readonly oauth?: {
    readonly scope?: string;
    readonly authParams?: readonly { readonly name: string; readonly value: string }[];
  };
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "context7",
    name: "context7",
    url: "https://mcp.context7.com/mcp",
    about: "Up-to-date library and framework docs. Free without a key; a key raises rate limits.",
    key: "optional",
    header: { name: "Authorization", prefix: "Bearer " },
  },
  {
    id: "deepwiki",
    name: "deepwiki",
    url: "https://mcp.deepwiki.com/mcp",
    about: "Ask about public GitHub repositories. Free, no key.",
    key: "none",
  },
  {
    id: "linear",
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    about: "Linear issues and projects. The owner signs in on the Connectors screen.",
    key: "oauth",
  },
  {
    id: "notion",
    name: "notion",
    url: "https://mcp.notion.com/mcp",
    about: "Notion pages and databases. The owner signs in on the Connectors screen.",
    key: "oauth",
  },
  {
    id: "google-drive",
    name: "google-drive",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    about:
      "Google Drive files (official remote server; needs the Drive MCP API enabled and an OAuth " +
      'client with "Use this client for an AI-powered agent"). The owner signs in; the client ' +
      "id and secret must be pre-registered; store them as vault items of the connector's home " +
      "(the org or a team) and name them when adding the connector; register this " +
      "workspace's sign-in return address on the OAuth client. Its return address shows on the " +
      "Connectors screen.",
    key: "oauth",
    oauth: {
      // Google issues a refresh token only for access_type=offline; prompt=consent
      // re-issues one on re-connect (developers.google.com Drive MCP guide).
      authParams: [
        { name: "access_type", value: "offline" },
        { name: "prompt", value: "consent" },
      ],
    },
  },
];

export const presetById = (id: string): McpPreset | undefined =>
  MCP_PRESETS.find((preset) => preset.id === id.trim().toLowerCase());
