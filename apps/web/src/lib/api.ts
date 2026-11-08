import type { BotFileName, BotFileState, BotFileVersion } from "./bot-files.ts";
import { routinesApi } from "./api-routines.ts";
import { artifactsApi } from "./api-artifacts.ts";
import type {
  ProjectInfo,
  ProjectOwnerPatch,
  EvalCase,
  EvalExpect,
  EvalRun,
  EvalRunRequest,
  AuditEvent,
  CredentialBinding,
  CredentialBindingInput,
  HistorySearch,
  McpConnectReply,
  McpServerInfo,
  McpServerInput,
  McpServerList,
  MemoryRecord,
  ModelsPayload,
  ProfileInfo,
  ProfilePolicies,
  RoomInfo,
  SessionInfo,
  SettingsModel,
  SkillDetail,
  SkillOverview,
  SkillProposal,
  TaskRow,
  TaskSettings,
  ToolCatalogEntry,
  VaultItemInfo,
} from "@spriessen/contracts";
import type { NodeInfo, NodePairResponse } from "@spriessen/contracts";
import type { NeedsYouExtra } from "./needs-you.ts";
import { UNAUTHORIZED_EVENT } from "./auth.ts";
import { statusText } from "./error-words.ts";
import type {
  MemoryV2Line,
  MemoryV2State,
  PendingApprovalRow,
  ProjectRow,
  PushConfig,
  RoomDetail,
  SecretStored,
  ServerCheck,
  TaskActivity,
} from "./api-types.ts";
export type {
  ArtifactRow,
  MemoryV2Chat,
  MemoryV2Entity,
  MemoryV2Fact,
  MemoryV2Line,
  MemoryV2Proposal,
  MemoryV2State,
  PendingApprovalRow,
  ProjectRow,
  PushConfig,
  RoomDetail,
  RoomLine,
  RoomLineStatus,
  SecretStored,
  ServerCheck,
  TaskActivity,
} from "./api-types.ts";

/**
 * The registries are plain REST on the server's HTTP handler (CRUD over
 * chord's replicated-object wire desyncs on attach). Same base as the chord
 * link: VITE_CHORD_URL in dev/prod override, relative in same-origin builds.
 */
export function base(): string {
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

  /** The request, for logs and debugging — never shown in the message. */
  readonly request: string;

  constructor(status: number, method: string, path: string, detail: string | null) {
    super(detail ?? statusText(status));
    this.request = `${method} ${path}: ${status}`;
    this.name = "ApiError";
    this.status = status;
  }
}

export async function failure(response: Response, method: string, path: string): Promise<ApiError> {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") detail = body.error;
  } catch {
    // Non-JSON body — the status line is all we have.
  }
  return new ApiError(response.status, method, path, detail);
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${base()}${path}`);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw await failure(response, "GET", path);
  }
  return (await response.json()) as T;
}

export async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method,
    // Always JSON, body or not: the server refuses typeless state changes
    // (what another origin could send without a preflight).
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw await failure(response, method, path);
  }
  return (await response.json()) as T;
}

/** DELETE that fails loudly: a swallowed 409 used to read as success. */
async function drop(path: string): Promise<boolean> {
  const response = await fetch(`${base()}${path}`, { method: "DELETE" });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw await failure(response, "DELETE", path);
  }
  return true;
}

export const api = {
  /** Words said in the bots' chats; each bot searched on its own (GET /api/history/search). */
  historySearch: (query: string, bot?: string): Promise<HistorySearch> =>
    getJson<HistorySearch>(
      `/api/history/search?q=${encodeURIComponent(query)}${bot !== undefined ? `&bot=${encodeURIComponent(bot)}` : ""}`,
    ),
  sessions: (profile?: string): Promise<SessionInfo[]> =>
    getJson<SessionInfo[]>(
      profile !== undefined
        ? `/api/sessions?profile=${encodeURIComponent(profile)}`
        : "/api/sessions",
    ),
  /** Branch a chat at a message: edit one of yours, or continue from a bot reply. */
  branchSession: (
    sessionId: string,
    body: { at: number; mode: "edit"; text: string } | { at: number; mode: "from" },
  ): Promise<SessionInfo> =>
    send<SessionInfo>(`/api/sessions/${encodeURIComponent(sessionId)}/branch`, "POST", body),
  /** Behaviour tests: saved chat messages, replayed and graded. */
  evals: (bot?: string): Promise<EvalCase[]> =>
    getJson<EvalCase[]>(
      bot !== undefined ? `/api/evals?bot=${encodeURIComponent(bot)}` : "/api/evals",
    ),
  /** Save one of the owner's messages (transcript id `at`) as a behaviour test. */
  evalCapture: (sessionId: string, at: number): Promise<EvalCase> =>
    send<EvalCase>("/api/evals", "POST", { sessionId, at }),
  evalUpdate: (id: string, patch: { title?: string; expect?: EvalExpect }): Promise<EvalCase> =>
    send<EvalCase>(`/api/evals/${encodeURIComponent(id)}`, "PATCH", patch),
  evalRemove: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/evals/${encodeURIComponent(id)}`, "DELETE"),
  evalStart: (body: EvalRunRequest): Promise<EvalRun> =>
    send<EvalRun>("/api/evals/run", "POST", body),
  evalRuns: (): Promise<EvalRun[]> => getJson<EvalRun[]>("/api/evals/runs"),
  /** A bot's long-running projects (its `project` tool), steered by the owner. */
  projects: (bot?: string): Promise<ProjectRow[]> =>
    getJson<ProjectRow[]>(
      bot !== undefined ? `/api/projects?bot=${encodeURIComponent(bot)}` : "/api/projects",
    ),
  projectUpdate: (id: string, patch: ProjectOwnerPatch): Promise<ProjectInfo> =>
    send<ProjectInfo>(`/api/projects/${encodeURIComponent(id)}`, "PATCH", patch),
  projectRemove: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, "DELETE"),
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
    /** Its home; omitted = an org bot. */
    teamId?: string | null;
  }): Promise<ProfileInfo> => send<ProfileInfo>("/api/profiles", "POST", input),
  updateProfile: (
    id: string,
    patch: {
      name?: string;
      description?: string;
      persona?: string;
      teamId?: string | null;
      hostAccess?: boolean;
      model?: { id: string; effort?: string } | null;
      /** The curated tool list, replaced wholesale; null = every installed tool. */
      toolAllowlist?: readonly string[] | null;
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
  /** `keep` names the fact that holds when accepting a conflict. */
  memoryProposalDecide: (
    id: string,
    verdict: "accept" | "reject",
    profile?: string,
    keep?: string,
  ): Promise<{ id: string; status: string; skipped?: string[] }> =>
    send<{ id: string; status: string; skipped?: string[] }>(
      `/api/memory/v2/proposals/${encodeURIComponent(id)}/${verdict}?profile=${encodeURIComponent(profile ?? "owner")}`,
      "POST",
      keep !== undefined ? { keep } : undefined,
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
  /** The owner's lifecycle act on a fact: it changed, it was wrong, it ended, or it holds. */
  memoryFactUpdate: (
    id: string,
    profile: string,
    update: { op: "change" | "correct" | "end" | "confirm"; text?: string; at?: string },
  ): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(
      `/api/memory/v2/facts/${encodeURIComponent(id)}/update?profile=${encodeURIComponent(profile)}`,
      "POST",
      update,
    ),
  memoryFactRestore: (id: string, profile?: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(
      `/api/memory/v2/facts/${encodeURIComponent(id)}/restore?profile=${encodeURIComponent(profile ?? "owner")}`,
      "POST",
    ),
  room: (id: string): Promise<RoomDetail> =>
    getJson<RoomDetail>(`/api/rooms/${encodeURIComponent(id)}`),
  roomByEnvelope: (envelopeId: string): Promise<RoomDetail> =>
    getJson<RoomDetail>(`/api/rooms/by-envelope/${encodeURIComponent(envelopeId)}`),
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
  models: (): Promise<ModelsPayload> => getJson<ModelsPayload>("/api/models"),
  settingsModel: (): Promise<SettingsModel> => getJson<SettingsModel>("/api/settings/model"),
  setSettingsModel: (input: { ref: string; effort: string } | null): Promise<SettingsModel> =>
    send<SettingsModel>("/api/settings/model", "PUT", input),
  settingsTasks: (): Promise<TaskSettings> => getJson<TaskSettings>("/api/settings/tasks"),
  setSettingsTasks: (maxRunningTasks: number | null): Promise<TaskSettings> =>
    send<TaskSettings>("/api/settings/tasks", "PUT", { maxRunningTasks }),
  settingsPause: (): Promise<{ paused: boolean }> =>
    getJson<{ paused: boolean }>("/api/settings/pause"),
  setSettingsPause: (paused: boolean): Promise<{ paused: boolean }> =>
    send<{ paused: boolean }>("/api/settings/pause", "PUT", { paused }),
  botUsage: (profileId: string): Promise<{ budget: number | null; today: number }> =>
    getJson<{ budget: number | null; today: number }>(
      `/api/usage?profile=${encodeURIComponent(profileId)}`,
    ),
  tools: (): Promise<ToolCatalogEntry[]> => getJson<ToolCatalogEntry[]>("/api/tools"),
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
  pendingApprovals: (): Promise<PendingApprovalRow[]> =>
    getJson<PendingApprovalRow[]>("/api/approvals"),
  /** The Needs you inputs no poll carries: tidy counts, escalations, approval chats. */
  needsYou: (): Promise<NeedsYouExtra> => getJson<NeedsYouExtra>("/api/needs-you"),
  /** Run a parked engine task again (Needs you's Retry). */
  retryParked: (taskId: string): Promise<{ outcome: string }> =>
    send<{ outcome: string }>(`/api/needs-you/parked/${encodeURIComponent(taskId)}/retry`, "POST"),
  serverCheck: (): Promise<ServerCheck> => getJson<ServerCheck>("/api/server/check"),
  // Nodes: the owner's paired machines (bash `node` targets). The token
  // exists only in pairNode's response — nothing else ever returns it.
  nodes: (): Promise<NodeInfo[]> => getJson<NodeInfo[]>("/api/nodes"),
  pairNode: (input: { name: string; roots: string[] }): Promise<NodePairResponse> =>
    send<NodePairResponse>("/api/nodes", "POST", input),
  revokeNode: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/nodes/${encodeURIComponent(id)}/revoke`, "POST"),
  updateNodeRoots: (id: string, roots: string[]): Promise<NodeInfo> =>
    send<NodeInfo>(`/api/nodes/${encodeURIComponent(id)}/roots`, "PUT", { roots }),
  removeTask: (id: string): Promise<boolean> => drop(`/api/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string): Promise<{ cancelled: boolean }> =>
    send<{ cancelled: boolean }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, "POST"),
  ...routinesApi,
  ...artifactsApi,
  /**
   * One bot's audit tail (read-only; its Crew profile Activity tab). The
   * server filters by profile after taking the tail, so read the widest
   * window and keep this bot's newest `limit` here.
   */
  auditOf: async (profileId: string, limit = 50): Promise<AuditEvent[]> =>
    (
      await getJson<AuditEvent[]>(`/api/audit?limit=1000&profile=${encodeURIComponent(profileId)}`)
    ).slice(-limit),
  audit: (limit?: number): Promise<AuditEvent[]> =>
    getJson<AuditEvent[]>(`/api/audit?limit=${limit ?? 200}`),
  /** Owner-level events of one kind (sign-in rows in Settings). */
  auditKind: (kind: "auth" | "permission" | "vault", limit = 30): Promise<AuditEvent[]> =>
    getJson<AuditEvent[]>(`/api/audit?limit=${limit}&kind=${kind}`),
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
  botFiles: (profile: string): Promise<Record<BotFileName, BotFileState>> =>
    getJson<Record<BotFileName, BotFileState>>(
      `/api/profiles/${encodeURIComponent(profile)}/files`,
    ),
  botFileVersions: (profile: string, file: BotFileName): Promise<BotFileVersion[]> =>
    getJson<BotFileVersion[]>(
      `/api/profiles/${encodeURIComponent(profile)}/files/${file}/versions`,
    ),
  botFileSave: (profile: string, file: BotFileName, text: string): Promise<BotFileState> =>
    send<BotFileState>(`/api/profiles/${encodeURIComponent(profile)}/files/${file}`, "PUT", {
      text,
      reason: "Edited on the profile page",
    }),
  botFileRestore: (profile: string, file: BotFileName, version: number): Promise<BotFileState> =>
    send<BotFileState>(
      `/api/profiles/${encodeURIComponent(profile)}/files/${file}/restore`,
      "POST",
      { version },
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
  skillFile: (
    profile: string,
    name: string,
    path: string,
  ): Promise<{ path: string; content: string }> =>
    getJson<{ path: string; content: string }>(
      `/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}/files/${path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`,
    ),
  skillVersions: (profile: string, name: string): Promise<BotFileVersion[]> =>
    getJson<BotFileVersion[]>(
      `/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}/versions`,
    ),
  skillRestore: (profile: string, name: string, version: number): Promise<unknown> =>
    send(`/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}/restore`, "POST", {
      version,
    }),
  skillRevert: (profile: string, name: string): Promise<unknown> =>
    send(`/api/skills/${encodeURIComponent(profile)}/${encodeURIComponent(name)}/revert`, "POST"),
  skillProposal: (profile: string, id: string, verdict: "accept" | "reject"): Promise<unknown> =>
    send(
      `/api/skills/${encodeURIComponent(profile)}/proposals/${encodeURIComponent(id)}/${verdict}`,
      "POST",
    ),
  skillCurate: (profile: string): Promise<{ proposals: SkillProposal[] }> =>
    send(`/api/skills/${encodeURIComponent(profile)}/curate`, "POST"),
};
