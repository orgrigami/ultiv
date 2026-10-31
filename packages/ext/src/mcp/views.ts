/**
 * What the rest of the platform sees of one server: its record, live status
 * and tools with their bot-facing names, plus the REST info shape.
 */
import type { McpServerInfo, McpServerInput } from "@spreissen/contracts";
import type { McpServerRecord } from "./config.ts";
import type { ConnectionStatus, McpToolDef } from "./connection.ts";
import { toolNameOf } from "./names.ts";

export interface McpToolView extends McpToolDef {
  /** `<slug>_<tool>`, provider-safe and unique. */
  readonly name: string;
  readonly enabled: boolean;
}

export interface McpServerView {
  readonly record: McpServerRecord;
  readonly status: ConnectionStatus;
  readonly tools: readonly McpToolView[];
  readonly signedIn: boolean;
}

const DISABLED: ConnectionStatus = {
  state: "disabled",
  reason: null,
  activeTransport: null,
  serverName: null,
  tools: [],
  hasResources: false,
};

/** Name every tool of one server; `reserved` are names other tools already use. */
export const viewOf = (
  record: McpServerRecord,
  status: ConnectionStatus | undefined,
  signedIn: boolean,
  reserved: ReadonlySet<string>,
): McpServerView => {
  const live = record.enabled
    ? (status ?? { ...DISABLED, state: "connecting" as const })
    : DISABLED;
  const taken = new Set(reserved);
  const tools = [...live.tools]
    .sort((a, b) => a.remote.localeCompare(b.remote))
    .map((tool) => ({
      ...tool,
      name: toolNameOf(record.slug, tool.remote, taken),
      enabled: !record.disabledTools.includes(tool.remote),
    }));
  return { record, status: live, tools, signedIn };
};

export const inputOf = (record: McpServerRecord): McpServerInput => ({
  name: record.name,
  transport: record.transport,
  url: record.url,
  command: record.command,
  auth: record.auth,
  profiles: record.profiles,
  enabled: record.enabled,
  autoAllowReadOnly: record.autoAllowReadOnly,
  disabledTools: record.disabledTools,
});

export const infoOf = (view: McpServerView): McpServerInfo => ({
  ...inputOf(view.record),
  id: view.record.id,
  createdAt: view.record.createdAt,
  state: view.status.state,
  reason: view.status.reason,
  activeTransport: view.status.activeTransport,
  serverName: view.status.serverName,
  tools: view.tools.map((tool) => ({
    name: tool.name,
    remoteName: tool.remote,
    title: tool.title,
    description: tool.description.slice(0, 500),
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    enabled: tool.enabled,
  })),
  hasResources: view.status.hasResources,
  firstUseApproved: view.record.firstUseApproved,
  signedIn: view.signedIn,
});
