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
import type { ProfileInfo } from "@spriessen/contracts";
import { agentForProfile } from "./agent.ts";
import type { BotFilesService } from "./bot-files.ts";
import { conversationIndex } from "./conversation-index.ts";
import { mainOps, settingsModelOps, taskLimitOps } from "./main.ts";
import { lifecycleOps, rowOps } from "./rows.ts";
import { keyOps, sessionOps } from "./sessions.ts";
import { branchOps } from "./branch.ts";
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
  /** Every registry tool (faculties + late installs); the allowlist never drops a faculty. */
  readonly allTools?: () => readonly { readonly name: string }[];
  /** Names an allowlist implies (connector helpers). */
  readonly implied?: (allowlist: readonly string[]) => readonly string[];
  /**
   * Tool names a bot loses from its LIST while its host-access switch is off
   * (slice 10): its home's stdio connector tools. The merged `bash` tool
   * never leaves the list (its default vm target is ordinary sandboxed
   * work); its host/node targets are refused per call instead. Absent in
   * bare tests, where every tool stays listed.
   */
  readonly hostExcluded?: (profile: ProfileInfo) => readonly string[];
  /** Whether a model ref is in the live catalog; every ref passes without one (tests). */
  readonly knownModel?: (ref: string) => boolean;
  /** Persona and Instructions files (docs/BOT-FILES.md). */
  readonly files?: BotFilesService;
  /** Retires a moved bot's user from its old home's VM (slice 2); best effort. */
  readonly retireUserFromHome?: ProfilesContext["retireUserFromHome"];
}): ProfilesService => {
  const agentFor: ProfilesService["agentFor"] = (profile) =>
    agentForProfile(
      profile,
      deps.tools,
      deps.implied,
      deps.hostExcluded?.(profile) ?? [],
      deps.allTools,
    );
  const index = conversationIndex(deps.converse, agentFor);
  const ctx: ProfilesContext = {
    converse: deps.converse,
    generate: deps.generate,
    index,
    knownModel: deps.knownModel ?? (() => true),
    ...(deps.files !== undefined ? { files: deps.files } : {}),
    ...(deps.retireUserFromHome !== undefined
      ? { retireUserFromHome: deps.retireUserFromHome }
      : {}),
    self: () => service,
  };
  const service: ProfilesService = {
    ...rowOps(ctx),
    ...lifecycleOps(ctx),
    ...mainOps(ctx),
    ...settingsModelOps(ctx),
    ...taskLimitOps(ctx),
    ...sessionOps(ctx),
    ...keyOps(ctx),
    ...branchOps(ctx),
    scopeOf: (conversationId) => index.scopes.get(String(conversationId)),
    profileOf: (conversationId) => index.profiles.get(String(conversationId)),
    agentFor,
    ...(deps.files !== undefined ? { files: deps.files } : {}),
  };
  void index.ensure();
  return service;
};
