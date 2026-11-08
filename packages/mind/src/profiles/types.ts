/** The Profiles service surface and the shared context its parts build on. */
import type { AgentChange } from "@earendil-works/pi-durable";
import type {
  HomeRef,
  ProfileCreate,
  ProfileInfo,
  SessionInfo,
  SessionKind,
} from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import type { GenerateService } from "../generate/generate.ts";
import type { SaveMeta } from "../versions/store.ts";
import type { BotFilesService } from "./bot-files.ts";
import type { ConversationIndex } from "./conversation-index.ts";
import type { ConversationScope } from "./docs.ts";

export interface ProfilesService {
  readonly list: (owner: string) => Promise<ProfileInfo[]>;
  readonly get: (owner: string, id: string) => Promise<ProfileInfo | undefined>;
  readonly create: (owner: string, input: ProfileCreate) => Promise<ProfileInfo>;
  readonly update: (
    owner: string,
    id: string,
    patch: Partial<ProfileCreate>,
    /** Who saved a Persona change and why (its version entry); default: the owner. */
    meta?: SaveMeta,
  ) => Promise<ProfileInfo>;
  /** Persona and Instructions with versions (docs/BOT-FILES.md); unset in bare tests. */
  readonly files?: BotFilesService;
  readonly setArchived: (owner: string, id: string, archived: boolean) => Promise<ProfileInfo>;
  /**
   * Save a tool (or a verified sub-action pattern) on the profile's
   * autoApprove list — the "always allow" rule. Returns the entries stored;
   * empty = the call stays gated by its pattern and nothing was written.
   */
  readonly allowTool: (
    owner: string,
    profileId: string,
    tool: string,
    input: unknown,
  ) => Promise<string[]>;
  /** Remove the profile row and its session rows; returns them for the cascade. */
  readonly remove: (owner: string, id: string) => Promise<SessionInfo[]>;
  /** Bot Mode: the profile's persistent main chat (created lazily, rotated on reset). */
  readonly ensureMain: (owner: string, profileId: string) => Promise<SessionInfo>;
  readonly resetMain: (owner: string, profileId: string) => Promise<SessionInfo>;
  readonly createSession: (
    owner: string,
    profileId: string,
    title: string | null,
  ) => Promise<SessionInfo>;
  readonly listSessions: (owner: string, profileId?: string) => Promise<SessionInfo[]>;
  /**
   * Branch a chat at a transcript id (branch.ts): "edit" forks before one of
   * the owner's messages, "from" after a bot reply. Returns the new chat.
   */
  readonly branchSession: (
    owner: string,
    sessionId: string,
    at: number,
    mode: "edit" | "from",
  ) => Promise<SessionInfo>;
  readonly removeSession: (owner: string, id: string) => Promise<boolean>;
  readonly touchSession: (
    owner: string,
    chatId: string,
    info: { at: number; titleSeed?: string },
  ) => Promise<void>;
  /** The registry row for a session id, any profile of any owner. */
  readonly rowOf: (id: string) => Promise<SessionInfo | undefined>;
  /** The conversation key a session row resolves to (legacy-aware). */
  readonly keyOfRow: (row: SessionInfo) => Promise<string>;
  /** Key for an id under an owner: registered row, else the default profile scope. */
  readonly keyForSession: (owner: string, id: string) => Promise<string>;
  /**
   * Adopt a conversation into a profile's scope (rooms use this): ensure the
   * key, index it for persona/audit/memory/artifact scoping.
   */
  readonly adoptConversation: (
    key: string,
    scope: {
      readonly owner: string;
      readonly profileId: string;
      readonly kind: SessionInfo["kind"];
      readonly participants: readonly string[] | null;
    },
  ) => Promise<void>;
  /**
   * Bind a task conversation to its bot (kind "task"): the bot stored on the
   * task row, else the spawning conversation's bot. Creates the conversation
   * with the bot's agent when new. Null when neither resolves to a bot.
   */
  readonly bindTask: (
    key: string,
    parentConversationId: string | null,
    stored: { readonly owner: string; readonly profileId: string } | null,
  ) => Promise<{ owner: string; profileId: string } | null>;
  /** The owner's main bot — the default surface; exactly one at a time. Null on a fresh workspace. */
  readonly mainOf: (owner: string) => Promise<string | null>;
  readonly setMain: (owner: string, profileId: string) => Promise<void>;
  /** The stored workspace default model (the settings doc); null = not set. */
  readonly workspaceDefaultModel: () => Promise<{ ref: string; effort: string } | null>;
  /** Store the workspace default model; null clears it (the env applies again). */
  readonly setWorkspaceDefaultModel: (
    model: { ref: string; effort: string } | null,
  ) => Promise<void>;
  /** The stored workspace default for tasks a bot runs at once; null = not set (env, then built in). */
  readonly workspaceTaskLimit: () => Promise<number | null>;
  /** Store the workspace task limit (1..TASK_LIMIT_MAX); null clears it. */
  readonly setWorkspaceTaskLimit: (limit: number | null) => Promise<void>;
  /** The ids of every indexed chat conversation (not tasks); built from the stored rows. */
  readonly chatConversations: () => Promise<readonly string[]>;
  /** The conversation scope index: persona, audit and artifact scoping read this. */
  readonly scopeOf: (conversationId: string) => ConversationScope | undefined;
  readonly profileOf: (conversationId: string) => ProfileInfo | undefined;
  /**
   * The agent a profile's new conversations start with (model default +
   * allowlist); a chat `kind` (anything but "task") also gets the chat-only
   * tool filter (chat-tools.ts).
   */
  readonly agentFor: (profile: ProfileInfo, kind?: SessionKind) => AgentChange;
}

/** What each part of the service shares: storage, the index, and the whole service. */
export interface ProfilesContext {
  readonly converse: ConverseService;
  readonly generate: GenerateService;
  readonly index: ConversationIndex;
  /** Whether a model ref is in the live catalog (profile validation). */
  readonly knownModel: (ref: string) => boolean;
  /** Persona and Instructions files, when wired. */
  readonly files?: BotFilesService;
  /**
   * Retire a bot's Linux user (and group memberships) from a named home's
   * VM — wired by the entity with the same sweep a purge uses. Fired when a
   * bot MOVES between homes, so the old home's VM keeps no stale member
   * (slice 2: the user is re-provisioned, same stored uid, in the new home
   * on its first `bash` there). Best effort; absent in bare tests.
   */
  readonly retireUserFromHome?: (owner: string, home: HomeRef, profileId: string) => Promise<void>;
  /** The assembled service, for parts that call each other. */
  readonly self: () => ProfilesService;
}
