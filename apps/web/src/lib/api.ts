import type {
  AuditEvent,
  CredentialBinding,
  CredentialBindingInput,
  CronJobInfo,
  McpConnectReply,
  McpServerInfo,
  McpServerInput,
  McpServerList,
  MemoryRecord,
  ModelInfo,
  ProfileInfo,
  ProfilePolicies,
  RoomInfo,
  RoutineEvent,
  SensorInfo,
  SessionInfo,
  SkillDetail,
  SkillOverview,
  TaskInfo,
  TaskRow,
  WaitingApproval,
  VaultItemInfo,
  WebhookInfo,
} from "@ultiv/contracts";

/**
 * The registries are plain REST on the server's HTTP handler (CRUD over
 * chord's replicated-object wire desyncs on attach). Same base as the chord
 * link: VITE_CHORD_URL in dev/prod override, relative in same-origin builds.
 */
function base(): string {
  const override = import.meta.env.VITE_CHORD_URL;
  if (override !== undefined && override !== "") {
    return override.replace(/^ws(s?):/, "http$1:").replace(/\/$/, "");
  }
  // Same-origin everywhere: the dev server proxies /api to the chord server
  // (see vite.config.ts); prod builds are served beside it or set the override.
  return "";
}

/** A REST failure carrying the server's own message — never just the status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, method: string, path: string, detail: string | null) {
    super(detail === null ? `${method} ${path}: ${status}` : detail);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface SecretStored {
  ok: boolean;
  stored: { key: string; name: string }[];
}

async function failure(response: Response, method: string, path: string): Promise<ApiError> {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") detail = body.error;
  } catch {
    // Non-JSON body — the status line is all we have.
  }
  return new ApiError(response.status, method, path, detail);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${base()}${path}`);
  if (!response.ok) throw await failure(response, "GET", path);
  return (await response.json()) as T;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!response.ok) throw await failure(response, method, path);
  return (await response.json()) as T;
}

/** DELETE that fails loudly: a swallowed 409 used to read as success. */
async function drop(path: string): Promise<boolean> {
  const response = await fetch(`${base()}${path}`, { method: "DELETE" });
  if (!response.ok) throw await failure(response, "DELETE", path);
  return true;
}

export interface RoomDetail {
  room: RoomInfo;
  participants: { profileId: string; name: string }[];
  timeline: RoomLine[];
}

/** Delivery status of a bot-to-bot message (mailbox lines only). */
export type RoomLineStatus = "pending" | "replied" | "failed" | "dead" | "expired" | "cancelled";

export interface RoomLine {
  at: number;
  speaker: string;
  text: string;
  system: boolean;
  id?: string;
  status?: RoomLineStatus;
  error?: string | null;
}

/** GET /api/push/config — whether the server can push, and this owner's device count. */
export interface PushConfig {
  configured: boolean;
  publicKey: string | null;
  devices: number;
}

/** One row of GET /api/approvals — a gate waiting on the owner somewhere. */
export interface PendingApprovalRow {
  conversationId: string;
  profile: string;
  kind: string;
  sessionId: string | null;
  callId: string;
  name: string;
  input: unknown;
  reason: string | null;
}

/** One row of GET /api/artifacts — a file a bot made (or the owner uploaded). */
export interface ArtifactRow {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  createdAt: number;
  conversationId: string | null;
  owner: string | null;
  profile: string | null;
}

/** One row of GET /api/tasks/:id/activity — progress, waiting gate, conversation. */
export interface TaskActivity {
  conversationId: string | null;
  waiting: WaitingApproval | null;
  steps: {
    kind: string;
    at: number;
    text: string;
    /** Newer servers: the tool call's structure (older ones only send `text`). */
    tool?: {
      name: string;
      status: "running" | "done" | "error";
      input: unknown;
      output: string | null;
      durationMs: number | null;
    };
  }[];
}

/** GET /api/memory/v2 — the v2 store: facts, entities, core, tidy proposals. */
export interface MemoryV2Proposal {
  id: string;
  kind: string;
  at: number;
  factIds: string[];
  summary: string;
  status: "open" | "accepted" | "rejected";
}
export interface MemoryV2Line {
  id: string;
  text: string;
  pinned: boolean;
  at: number;
}
export interface MemoryV2Entity {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  summary: string;
  createdAt: number;
  /** Set when this entity was merged into another; the id stays a redirect. */
  mergedInto: string | null;
}
export interface MemoryV2Fact {
  id: string;
  /** Which store the fact lives in: "owner" = workspace-wide. */
  scope: "profile" | "owner";
  text: string;
  status: "current" | "superseded" | "archived" | "forgotten";
  kind: string;
  tags: string[];
  /** Entity ids this fact is about (from the graph doc). */
  entities: string[];
  importance: number;
  trust: string;
  createdAt: number;
  expiredAt: number | null;
  /** The fact that replaced this one (supersede chain). */
  supersededBy: string | null;
  supersedes: string[];
}
export interface MemoryV2State {
  facts: MemoryV2Fact[];
  entities: MemoryV2Entity[];
  core: { owner: MemoryV2Line[]; profile: MemoryV2Line[] };
  proposals: MemoryV2Proposal[];
  openCount: number;
}

export const api = {
  sessions: (profile?: string): Promise<SessionInfo[]> =>
    getJson<SessionInfo[]>(
      profile !== undefined
        ? `/api/sessions?profile=${encodeURIComponent(profile)}`
        : "/api/sessions",
    ),
  profiles: (): Promise<ProfileInfo[]> => getJson<ProfileInfo[]>("/api/profiles"),
  rooms: (bot?: string): Promise<RoomInfo[]> =>
    getJson<RoomInfo[]>(
      bot !== undefined ? `/api/rooms?bot=${encodeURIComponent(bot)}` : "/api/rooms",
    ),
  createProfile: (input: {
    name: string;
    description?: string;
    persona?: string;
    model?: { id: string; effort?: string } | null;
    policies?: Partial<ProfilePolicies>;
  }): Promise<ProfileInfo> => send<ProfileInfo>("/api/profiles", "POST", input),
  updateProfile: (
    id: string,
    patch: {
      name?: string;
      description?: string;
      persona?: string;
      model?: { id: string; effort?: string } | null;
      /** Per-key merge server-side, so a partial object is safe. */
      policies?: Partial<ProfilePolicies>;
    },
  ): Promise<ProfileInfo> =>
    send<ProfileInfo>(`/api/profiles/${encodeURIComponent(id)}`, "PATCH", patch),
  deleteProfile: (id: string): Promise<boolean> => drop(`/api/profiles/${encodeURIComponent(id)}`),
  archiveProfile: (id: string): Promise<ProfileInfo> =>
    send<ProfileInfo>(`/api/profiles/${encodeURIComponent(id)}/archive`, "POST"),
  unarchiveProfile: (id: string): Promise<ProfileInfo> =>
    send<ProfileInfo>(`/api/profiles/${encodeURIComponent(id)}/unarchive`, "POST"),
  main: (): Promise<{ profileId: string | null }> =>
    getJson<{ profileId: string | null }>("/api/main"),
  setMain: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/profiles/${encodeURIComponent(id)}/main`, "POST"),
  mainChat: (profileId: string): Promise<SessionInfo> =>
    getJson<SessionInfo>(`/api/profiles/${encodeURIComponent(profileId)}/main`),
  profileMemory: (id: string): Promise<MemoryRecord[]> =>
    getJson<MemoryRecord[]>(`/api/profiles/${encodeURIComponent(id)}/memory`),
  profileMemoryAdd: (id: string, text: string): Promise<MemoryRecord> =>
    send<MemoryRecord>(`/api/profiles/${encodeURIComponent(id)}/memory`, "POST", { text }),
  profileMemoryRemove: (id: string, recordId: string): Promise<boolean> =>
    drop(`/api/profiles/${encodeURIComponent(id)}/memory/${encodeURIComponent(recordId)}`),
  memoryV2: (profile?: string): Promise<MemoryV2State> =>
    getJson<MemoryV2State>(`/api/memory/v2?profile=${encodeURIComponent(profile ?? "owner")}`),
  memoryProposalDecide: (
    id: string,
    verdict: "accept" | "reject",
    profile?: string,
  ): Promise<{ id: string; status: string }> =>
    send<{ id: string; status: string }>(
      `/api/memory/v2/proposals/${encodeURIComponent(id)}/${verdict}?profile=${encodeURIComponent(profile ?? "owner")}`,
      "POST",
    ),
  memoryCoreAdd: (text: string, profile?: string, pinned?: boolean): Promise<MemoryV2Line> =>
    send<MemoryV2Line>(
      `/api/memory/v2/core?profile=${encodeURIComponent(profile ?? "owner")}`,
      "POST",
      { text, ...(pinned === true ? { pinned: true } : {}) },
    ),
  memoryCoreRemove: (lineId: string, profile?: string): Promise<boolean> =>
    drop(
      `/api/memory/v2/core/${encodeURIComponent(lineId)}?profile=${encodeURIComponent(profile ?? "owner")}`,
    ),
  memoryCoreUpdate: (lineId: string, text: string, profile?: string): Promise<MemoryV2Line> =>
    send<MemoryV2Line>(
      `/api/memory/v2/core/${encodeURIComponent(lineId)}?profile=${encodeURIComponent(profile ?? "owner")}`,
      "PATCH",
      { text },
    ),
  memoryPurge: (profile?: string, confirm?: number): Promise<{ purged: number }> =>
    send<{ purged: number }>(
      `/api/memory/purge?profile=${encodeURIComponent(profile ?? "owner")}`,
      "POST",
      { confirm },
    ),
  memoryTidyRun: (): Promise<{ proposals: number }> =>
    send<{ proposals: number }>("/api/memory/tidy/run", "POST"),
  memoryFactForget: (id: string, profile?: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(
      `/api/memory/v2/facts/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile ?? "owner")}`,
      "DELETE",
    ),
  memoryFactRestore: (id: string, profile?: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(
      `/api/memory/v2/facts/${encodeURIComponent(id)}/restore?profile=${encodeURIComponent(profile ?? "owner")}`,
      "POST",
    ),
  artifacts: (profile: string): Promise<ArtifactRow[]> =>
    getJson<ArtifactRow[]>(`/api/artifacts?profile=${encodeURIComponent(profile)}`),
  artifactUrl: (id: string): string => `${base()}/api/artifacts/${encodeURIComponent(id)}`,
  room: (id: string): Promise<RoomDetail> =>
    getJson<RoomDetail>(`/api/rooms/${encodeURIComponent(id)}`),
  roomSay: (id: string, to: string, text: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(id)}/say`, "POST", { to, text }),
  mailboxCancel: (id: string): Promise<unknown> =>
    send<unknown>(`/api/mailbox/${encodeURIComponent(id)}/cancel`, "POST", {}),
  mcpServers: (): Promise<McpServerList> => getJson<McpServerList>("/api/mcp/servers"),
  mcpAdd: (input: McpServerInput): Promise<McpServerInfo> =>
    send<McpServerInfo>("/api/mcp/servers", "POST", input),
  mcpUpdate: (id: string, input: McpServerInput): Promise<McpServerInfo> =>
    send<McpServerInfo>(`/api/mcp/servers/${encodeURIComponent(id)}`, "PATCH", input),
  mcpRemove: (id: string): Promise<boolean> => drop(`/api/mcp/servers/${encodeURIComponent(id)}`),
  mcpReconnect: (id: string): Promise<McpServerInfo> =>
    send<McpServerInfo>(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, "POST"),
  /** Start sign-in: open the returned url (null = already signed in). */
  mcpConnect: (id: string): Promise<McpConnectReply> =>
    send<McpConnectReply>(`/api/mcp/servers/${encodeURIComponent(id)}/connect`, "POST"),
  mcpSignOut: (id: string): Promise<McpServerInfo> =>
    send<McpServerInfo>(`/api/mcp/servers/${encodeURIComponent(id)}/signout`, "POST"),
  /** Secure input: typed values go straight to the vault; only names come back. */
  secretSubmit: (callId: string, values: Record<string, string>): Promise<SecretStored> =>
    send<SecretStored>(`/api/secrets/${encodeURIComponent(callId)}`, "POST", { values }),
  secretCancel: (callId: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/secrets/${encodeURIComponent(callId)}`, "POST", { cancel: true }),
  vault: (): Promise<VaultItemInfo[]> => getJson<VaultItemInfo[]>("/api/vault"),
  vaultCreate: (item: Record<string, unknown>): Promise<VaultItemInfo> =>
    send<VaultItemInfo>("/api/vault", "POST", item),
  vaultRemove: (id: string): Promise<boolean> => drop(`/api/vault/${encodeURIComponent(id)}`),
  pushConfig: (): Promise<PushConfig> => getJson<PushConfig>("/api/push/config"),
  pushSubscribe: (subscription: PushSubscriptionJSON): Promise<{ ok: boolean }> =>
    send("/api/push/subscribe", "POST", { subscription }),
  pushUnsubscribe: (endpoint: string): Promise<{ removed: boolean }> =>
    send("/api/push/unsubscribe", "POST", { endpoint }),
  pushTest: (): Promise<{ outcome: string }> => send("/api/push/test", "POST", {}),
  /** Fire-and-forget (keepalive, so a closing tab still reports hidden). */
  pushPresence: (tab: string, visible: boolean): void => {
    void fetch(`${base()}/api/push/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab, visible }),
      keepalive: true,
    }).catch(() => undefined);
  },
  bindings: (): Promise<CredentialBinding[]> => getJson<CredentialBinding[]>("/api/vault/bindings"),
  bindingSave: (id: string, input: CredentialBindingInput): Promise<CredentialBinding> =>
    send<CredentialBinding>(`/api/vault/${encodeURIComponent(id)}/binding`, "PUT", input),
  bindingRemove: (id: string): Promise<boolean> =>
    drop(`/api/vault/${encodeURIComponent(id)}/binding`),
  models: (): Promise<ModelInfo[]> => getJson<ModelInfo[]>("/api/models"),
  create: (title: string | null, profileId?: string): Promise<{ id: string }> =>
    send<{ id: string }>("/api/sessions", "POST", {
      title,
      ...(profileId !== undefined ? { profileId } : {}),
    }),
  remove: (id: string): Promise<boolean> => drop(`/api/sessions/${encodeURIComponent(id)}`),
  tasks: (): Promise<TaskRow[]> => getJson<TaskRow[]>("/api/tasks"),
  taskActivity: (id: string): Promise<TaskActivity> =>
    getJson<TaskActivity>(`/api/tasks/${encodeURIComponent(id)}/activity`),
  approvalDecide: (
    conversationId: string,
    callId: string,
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
    input?: unknown,
  ): Promise<{ ok: boolean; stored: number | null }> =>
    send<{ ok: boolean; stored: number | null }>(
      `/api/approvals/${encodeURIComponent(conversationId)}/${encodeURIComponent(callId)}`,
      "POST",
      {
        approved,
        ...(always === true ? { always: true } : {}),
        ...(takeover === true ? { takeover: true } : {}),
        ...(input !== undefined ? { input } : {}),
      },
    ),
  artifactsFor: (conversationId: string): Promise<ArtifactRow[]> =>
    getJson<ArtifactRow[]>(`/api/artifacts?conversationId=${encodeURIComponent(conversationId)}`),
  pendingApprovals: (): Promise<PendingApprovalRow[]> =>
    getJson<PendingApprovalRow[]>("/api/approvals"),
  removeTask: (id: string): Promise<boolean> => drop(`/api/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string): Promise<{ cancelled: boolean }> =>
    send<{ cancelled: boolean }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, "POST"),
  // Routines: schedules, webhooks, sensors and their shared receipt log.
  cron: (): Promise<CronJobInfo[]> => getJson<CronJobInfo[]>("/api/cron"),
  removeCron: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/cron/${encodeURIComponent(id)}`, "DELETE"),
  webhooks: (): Promise<WebhookInfo[]> => getJson<WebhookInfo[]>("/api/webhooks"),
  createWebhook: (input: {
    sessionId: string;
    name?: string;
    schema?: Record<string, unknown> | null;
  }): Promise<WebhookInfo> => send<WebhookInfo>("/api/webhooks", "POST", input),
  removeWebhook: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/webhooks/${encodeURIComponent(id)}`, "DELETE"),
  testWebhook: (id: string, payload: unknown): Promise<{ accepted: boolean; detail?: string }> =>
    send(`/api/webhooks/${encodeURIComponent(id)}/test`, "POST", { payload }),
  sensors: (): Promise<SensorInfo[]> => getJson<SensorInfo[]>("/api/sensors"),
  removeSensor: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/sensors/${encodeURIComponent(id)}`, "DELETE"),
  routineEvents: (limit?: number): Promise<RoutineEvent[]> =>
    getJson<RoutineEvent[]>(`/api/routines/events?limit=${limit ?? 30}`),
  audit: (limit?: number): Promise<AuditEvent[]> =>
    getJson<AuditEvent[]>(`/api/audit?limit=${limit ?? 200}`),
  /** Jev's decisions in one chat (approval mode 'jev'), newest last. */
  adjudications: (conversationId: string): Promise<AuditEvent[]> =>
    getJson<AuditEvent[]>(
      `/api/audit?limit=200&kind=adjudication&conversation=${encodeURIComponent(conversationId)}`,
    ),
  stateOf: (profile: string): Promise<{ key: string; value: string; updatedAt: number }[]> =>
    getJson(`/api/state?profile=${encodeURIComponent(profile)}`),
  removeState: (profile: string, key: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(
      `/api/state/${encodeURIComponent(profile)}/${encodeURIComponent(key)}`,
      "DELETE",
    ),
  skills: (): Promise<SkillOverview> => getJson<SkillOverview>("/api/skills"),
  skill: (profile: string, name: string): Promise<SkillDetail> =>
    getJson<SkillDetail>(`/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}`),
  skillSave: (
    profile: string,
    name: string,
    patch: { body?: string; enabled?: boolean },
  ): Promise<unknown> =>
    send(`/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}`, "PUT", patch),
  skillRemove: (profile: string, name: string): Promise<boolean> =>
    drop(`/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}`),
  skillRevert: (profile: string, name: string): Promise<unknown> =>
    send(`/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}/revert`, "POST"),
  skillProposal: (profile: string, id: string, verdict: "accept" | "reject"): Promise<unknown> =>
    send(
      `/api/skills/${encodeURIComponent(profile)}/proposals/${encodeURIComponent(id)}/${verdict}`,
      "POST",
    ),
};
