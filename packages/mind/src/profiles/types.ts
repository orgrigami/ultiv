/** The Profiles service surface and the shared context its parts build on. */
import type { AgentChange } from "@earendil-works/pi-durable";
import type { ProfileCreate, ProfileInfo, SessionInfo } from "@ultiv/contracts";
import type { ConverseService } from "../converse/converse.ts";
import type { GenerateService } from "../generate/generate.ts";
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
  ) => Promise<ProfileInfo>;
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
  /** The conversation scope index: persona, audit and artifact scoping read this. */
  readonly scopeOf: (conversationId: string) => ConversationScope | undefined;
  readonly profileOf: (conversationId: string) => ProfileInfo | undefined;
  /** The agent a profile's new conversations start with (model default + allowlist). */
  readonly agentFor: (profile: ProfileInfo) => AgentChange;
}

/** What each part of the service shares: storage, the index, and the whole service. */
export interface ProfilesContext {
  readonly converse: ConverseService;
  readonly generate: GenerateService;
  readonly index: ConversationIndex;
  /** The assembled service, for parts that call each other. */
  readonly self: () => ProfilesService;
}
