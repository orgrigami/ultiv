/**
 * Response shapes of the REST routes that have no contract in
 * @spriessen/contracts: room transcripts, push config, the approvals inbox,
 * the server check, artifacts, task activity, the memory v2 store and
 * secure-input replies. api.ts re-exports them.
 */

import type {
  ArtifactSource,
  ProjectInfo,
  ProjectWork,
  RoomInfo,
  WaitingApproval,
} from "@spriessen/contracts";

/** One row of GET /api/projects: the project plus the tasks and routines linked to it. */
export type ProjectRow = ProjectInfo & { work?: ProjectWork };

export interface SecretStored {
  ok: boolean;
  stored: { key: string; name: string }[];
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
  /** Mailbox lines only: the sender's profile id (names can collide). */
  speakerId?: string;
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

/** GET /api/server/check — which keys are set (never their values) and how the server runs. */
export interface ServerCheck {
  /** The server's Node version (absent on servers older than the Node 26 lock). */
  node?: string;
  keys: { names: string[]; set: boolean; enables: string; group: "models" | "features" }[];
  models: { providers: string[]; count: number; default: string; source: string };
  microvm: { available: boolean; detail: string };
  listen: { port: number; scope: "all" | "loopback" | "specific" };
  /** Memory meaning search: the embedding model (null = off), where it runs, its last result. */
  meaning?: {
    model: string | null;
    remote: boolean;
    tools: boolean;
    lastOkAt: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
  };
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
  /** Where it sits in its bot's files ("reports/board.md"); absent on loose legacy files. */
  path?: string;
  /** The last write; a file written again keeps its id and createdAt. */
  updatedAt?: number;
  /** The chat it came from (`?sources=1` lists and every /meta); null = none maps. */
  source?: ArtifactSource | null;
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
  /** World-time validity: the day it started, and the day it stops (or stopped) holding. */
  validFrom?: number | null;
  validTo?: number | null;
  /** How the bot knows it; "inferred" until the owner confirms. */
  basis?: "owner_said" | "observed" | "inferred" | "confirmed";
  /** Why a version left the present (changed, corrected, ended). */
  retired?: "changed" | "corrected" | "ended";
  confirmations?: number;
  /** Where it came from: the conversation it was learned in, when known. */
  source?: { conversation: string | null; origin: string };
}

/** One of the bot's chats, by the conversation id facts record as their source. */
export interface MemoryV2Chat {
  sessionId: string;
  title: string;
  kind: string;
}

export interface MemoryV2State {
  facts: MemoryV2Fact[];
  /** The bot's chats by conversation id ("Learned in …"); empty for the owner store. */
  chats?: Record<string, MemoryV2Chat>;
  entities: MemoryV2Entity[];
  core: { owner: MemoryV2Line[]; profile: MemoryV2Line[] };
  proposals: MemoryV2Proposal[];
  openCount: number;
}
