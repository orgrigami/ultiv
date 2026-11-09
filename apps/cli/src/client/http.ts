/**
 * The REST half of the terminal client: the same `/api` routes the web
 * calls, signed in with the saved session cookie. Every state-changing call
 * sends `application/json` (the server's cross-site gate refuses the
 * no-preflight types). A 401 becomes `SignInRequired`, so every command can
 * answer "run spriessen login" the same way.
 */
import type {
  CoreLine,
  CronJobInfo,
  EvalCase,
  EvalRun,
  EvalRunRequest,
  HistorySearch,
  MemoryFact,
  ModelsPayload,
  NodeInfo,
  NodePairResponse,
  ProfileCreate,
  ProfileInfo,
  ProjectInfo,
  SessionInfo,
  SettingsModel,
  TaskRow,
} from "@spriessen/contracts";

/** One gate waiting on the owner (GET /api/approvals). */
export interface ApprovalRow {
  readonly conversationId: string;
  readonly profile: string;
  readonly kind: string;
  readonly sessionId: string | null;
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly reason: string | null;
}

/** GET /api/needs-you: what no other read carries (the CLI shows counts). */
export interface NeedsYouExtra {
  readonly tidy: readonly { readonly profile: string; readonly open: number }[];
  readonly escalations: readonly unknown[];
  readonly parked?: readonly {
    readonly taskId: string;
    readonly kind: string;
    readonly profile: string;
  }[];
  /** Open browser takeover asks (older servers leave it out). */
  readonly takeovers?: readonly {
    readonly id: string;
    readonly profile: string;
    readonly reason: string;
  }[];
}

/** GET /api/memory/v2?profile=: the parts the terminal shows. */
export interface MemoryStore {
  readonly facts: readonly MemoryFact[];
  readonly core: { readonly owner: readonly CoreLine[]; readonly profile: readonly CoreLine[] };
  readonly openCount: number;
}

/** GET /api/server/check: names and switches only, never a value. */
export interface ServerCheck {
  /** The server's Node version (absent on servers older than the Node 26 lock). */
  readonly node?: string;
  readonly keys: readonly {
    readonly names: readonly string[];
    readonly set: boolean;
    readonly enables: string;
    readonly group: "models" | "features";
  }[];
  readonly models: {
    readonly providers: readonly string[];
    readonly count: number;
    readonly default: string;
  };
  readonly microvm: { readonly available: boolean; readonly detail: string };
  readonly listen: { readonly port: number; readonly scope: "all" | "loopback" | "specific" };
}

export interface HistoryQuery {
  readonly q: string;
  readonly bot?: string;
  readonly since?: string;
  readonly until?: string;
  readonly who?: string;
  readonly limit?: number;
}

export interface AuthStatus {
  readonly passcodeSet: boolean;
  /** This request may set the first passcode (no passcode yet, on the host itself). */
  readonly bootstrap: boolean;
  /** The cookie sent is a live session. */
  readonly session: boolean;
}

export class SignInRequired extends Error {
  constructor() {
    super("sign in first: run `spriessen login`");
  }
}

/** A refused REST call: the server's own sentence, with its status and route for the debug view. */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail: string;
  constructor(status: number, path: string, detail: string) {
    super(detail);
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

export interface Api {
  readonly server: string;
  readonly cookie: string | undefined;
  authStatus(): Promise<AuthStatus>;
  /** Sign in with the passcode; answers the session cookie (`name=value`). */
  signIn(passcode: string): Promise<string>;
  /** The one-time first passcode (only on the host itself); answers the session cookie. */
  setPasscode(passcode: string): Promise<string>;
  signOut(): Promise<void>;
  profiles(): Promise<ProfileInfo[]>;
  createProfile(input: ProfileCreate): Promise<ProfileInfo>;
  setMain(profileId: string): Promise<{ ok: boolean }>;
  main(): Promise<{ profileId: string | null }>;
  mainChat(profileId: string): Promise<SessionInfo>;
  sessions(profile?: string): Promise<SessionInfo[]>;
  createSession(profileId: string, title?: string | null): Promise<{ id: string }>;
  approvals(): Promise<ApprovalRow[]>;
  decide(
    row: Pick<ApprovalRow, "conversationId" | "callId">,
    approved: boolean,
    always?: boolean,
  ): Promise<{ ok: boolean; stored: number | null }>;
  tasks(): Promise<TaskRow[]>;
  cancelTask(taskId: string): Promise<{ cancelled: boolean }>;
  historySearch(query: HistoryQuery): Promise<HistorySearch>;
  memory(profileId: string): Promise<MemoryStore>;
  routines(profileId?: string): Promise<CronJobInfo[]>;
  serverCheck(): Promise<ServerCheck>;
  needsYou(): Promise<NeedsYouExtra>;
  nodes(): Promise<NodeInfo[]>;
  pairNode(name: string, roots: readonly string[]): Promise<NodePairResponse>;
  revokeNode(id: string): Promise<{ ok: boolean }>;
  setNodeRoots(id: string, roots: readonly string[]): Promise<NodeInfo>;
  models(): Promise<ModelsPayload>;
  /** Set (or with null, clear) the workspace default model new chats start on. */
  setDefaultModel(ref: string | null, effort?: string): Promise<SettingsModel>;
  /** Branch a chat: edit one of your messages (and send it), or continue from a reply. */
  branch(
    sessionId: string,
    body: { at: number; mode: "edit"; text: string } | { at: number; mode: "from" },
  ): Promise<SessionInfo>;
  projects(bot?: string): Promise<ProjectInfo[]>;
  evals(bot?: string): Promise<EvalCase[]>;
  saveEval(sessionId: string, at: number): Promise<EvalCase>;
  startEvals(request: EvalRunRequest): Promise<EvalRun>;
  evalRun(runId: string): Promise<EvalRun>;
}

const errorText = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return response.statusText || "request failed";
};

/** POST a passcode to a sign-in route; answers the session cookie it set. */
const cookieFrom = async (server: string, path: string, passcode: string): Promise<string> => {
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  if (!response.ok) throw new ApiError(response.status, path, await errorText(response));
  const pair = response.headers.get("set-cookie")?.split(";")[0];
  if (pair === undefined || pair === "") throw new Error("the server sent no session cookie");
  return pair;
};

export const createApi = (server: string, cookie: string | undefined): Api => {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers["cookie"] = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${server}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 && !path.startsWith("/api/auth/")) throw new SignInRequired();
    if (!response.ok) throw new ApiError(response.status, path, await errorText(response));
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  };
  const id = encodeURIComponent;
  return {
    server,
    cookie,
    authStatus: () => call("GET", "/api/auth/status"),
    signIn: (passcode) => cookieFrom(server, "/api/auth/sign-in", passcode),
    setPasscode: (passcode) => cookieFrom(server, "/api/auth/passcode", passcode),
    signOut: async () => {
      await call("POST", "/api/auth/sign-out", {});
    },
    profiles: () => call("GET", "/api/profiles"),
    createProfile: (input) => call("POST", "/api/profiles", input),
    setMain: (profileId) => call("POST", `/api/profiles/${id(profileId)}/main`, {}),
    main: () => call("GET", "/api/main"),
    mainChat: (profileId) => call("GET", `/api/profiles/${id(profileId)}/main`),
    sessions: (profile) =>
      call("GET", profile === undefined ? "/api/sessions" : `/api/sessions?profile=${id(profile)}`),
    createSession: (profileId, title = null) => call("POST", "/api/sessions", { title, profileId }),
    approvals: () => call("GET", "/api/approvals"),
    decide: (row, approved, always) =>
      call("POST", `/api/approvals/${id(row.conversationId)}/${id(row.callId)}`, {
        approved,
        ...(always === true ? { always: true } : {}),
      }),
    tasks: () => call("GET", "/api/tasks"),
    cancelTask: (taskId) => call("POST", `/api/tasks/${id(taskId)}/cancel`, {}),
    historySearch: (query) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      return call("GET", `/api/history/search?${params.toString()}`);
    },
    memory: (profileId) => call("GET", `/api/memory/v2?profile=${id(profileId)}`),
    routines: (profileId) =>
      call("GET", profileId === undefined ? "/api/cron" : `/api/cron?profile=${id(profileId)}`),
    serverCheck: () => call("GET", "/api/server/check"),
    needsYou: () => call("GET", "/api/needs-you"),
    nodes: () => call("GET", "/api/nodes"),
    pairNode: (name, roots) => call("POST", "/api/nodes", { name, roots }),
    revokeNode: (nodeId) => call("POST", `/api/nodes/${id(nodeId)}/revoke`, {}),
    setNodeRoots: (nodeId, roots) => call("PUT", `/api/nodes/${id(nodeId)}/roots`, { roots }),
    models: () => call("GET", "/api/models"),
    setDefaultModel: (ref, effort = "") =>
      call("PUT", "/api/settings/model", ref === null ? { ref: null } : { ref, effort }),
    branch: (sessionId, body) => call("POST", `/api/sessions/${id(sessionId)}/branch`, body),
    projects: (bot) =>
      call("GET", bot === undefined ? "/api/projects" : `/api/projects?bot=${id(bot)}`),
    evals: (bot) => call("GET", bot === undefined ? "/api/evals" : `/api/evals?bot=${id(bot)}`),
    saveEval: (sessionId, at) => call("POST", "/api/evals", { sessionId, at }),
    startEvals: (request) => call("POST", "/api/evals/run", request),
    evalRun: (runId) => call("GET", `/api/evals/runs/${id(runId)}`),
  };
};
