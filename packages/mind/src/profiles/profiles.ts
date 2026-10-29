/**
 * The Profiles faculty: user-defined AI entities above sessions. One runtime,
 * one entity per profile — each profile owns its main chat ("Bot Mode"),
 * sessions, per-pair DM threads, artifacts scope and persona. The service owns
 * the conversation→profile index that persona rendering, audit stamping and
 * the artifact scope resolver all read. The parts live beside it: rows.ts
 * (profile rows), main.ts (main chats, onboarding, the main bot), sessions.ts
 * (session rows and keys), conversation-index.ts, agent.ts; docs and pure
 * helpers live in docs.ts.
 */
import type { ConverseService } from "../converse/converse.ts";
import type { GenerateService } from "../generate/generate.ts";
import { agentForProfile } from "./agent.ts";
import { conversationIndex } from "./conversation-index.ts";
import { mainOps } from "./main.ts";
import { lifecycleOps, rowOps } from "./rows.ts";
import { keyOps, sessionOps } from "./sessions.ts";
import type { ProfilesContext, ProfilesService } from "./types.ts";

export {
  MAIN_PREFIX,
  ProfilesDoc,
  SessionsDoc,
  defaultPolicies,
  defaultTimezone,
  legacyKey,
  pairKey,
  pairSessionId,
  scopedKey,
} from "./docs.ts";
export type { ConversationScope } from "./docs.ts";
export type { ProfilesService } from "./types.ts";

export const profilesService = (deps: {
  readonly converse: ConverseService;
  readonly generate: GenerateService;
  /** The act's tool registrations, for per-profile allowlists. */
  readonly tools: () => readonly { readonly name: string }[];
  /** Names an allowlist implies (connector helpers). */
  readonly implied?: (allowlist: readonly string[]) => readonly string[];
  /** Whether a model ref is in the live catalog; every ref passes without one (tests). */
  readonly knownModel?: (ref: string) => boolean;
}): ProfilesService => {
  const agentFor: ProfilesService["agentFor"] = (profile) =>
    agentForProfile(profile, deps.tools, deps.implied);
  const index = conversationIndex(deps.converse, agentFor);
  const ctx: ProfilesContext = {
    converse: deps.converse,
    generate: deps.generate,
    index,
    knownModel: deps.knownModel ?? (() => true),
    self: () => service,
  };
  const service: ProfilesService = {
    ...rowOps(ctx),
    ...lifecycleOps(ctx),
    ...mainOps(ctx),
    ...sessionOps(ctx),
    ...keyOps(ctx),
    scopeOf: (conversationId) => index.scopes.get(String(conversationId)),
    profileOf: (conversationId) => index.profiles.get(String(conversationId)),
    agentFor,
  };
  void index.ensure();
  return service;
};
