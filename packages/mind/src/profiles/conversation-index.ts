/**
 * The conversation→profile index: which bot (and which kind of chat) a
 * durable conversation belongs to. Persona rendering, audit stamping and the
 * artifact scope resolver all read it; it is rebuilt lazily from the docs.
 */
import type { AgentChange } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { ProfileInfo, SessionInfo } from "@spreissen/contracts";
import { TasksDoc, taskConversationKey } from "../tasks/tasks.ts";
import type { ConverseService } from "../converse/converse.ts";
import {
  legacyKey,
  pairKey,
  readProfiles,
  readSessions,
  scopedKey,
  type ConversationScope,
} from "./docs.ts";

export interface ConversationIndex {
  readonly scopes: Map<string, ConversationScope>;
  readonly profiles: Map<string, ProfileInfo>;
  /** Build the index once from the stored rows. */
  readonly ensure: () => Promise<void>;
  /** The conversation key a session row resolves to (legacy-aware). */
  readonly keyOfRow: (row: SessionInfo) => Promise<string>;
  /** Ensure the conversation behind a key and index it under a profile. */
  readonly ensureConversationFor: (
    key: string,
    profile: ProfileInfo,
    scope: ConversationScope,
  ) => Promise<void>;
}

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

const scopeOfRow = (row: SessionInfo): ConversationScope => ({
  owner: row.owner,
  profileId: row.profile,
  kind: row.kind,
  participants: row.participants,
});

export const conversationIndex = (
  converse: ConverseService,
  agentFor: (profile: ProfileInfo) => AgentChange,
): ConversationIndex => {
  const scopes = new Map<string, ConversationScope>();
  const profiles = new Map<string, ProfileInfo>();
  let built: Promise<void> | undefined;

  const keyOfRow = async (row: SessionInfo): Promise<string> => {
    const scoped =
      row.kind === "dm" && row.participants !== null
        ? pairKey(row.owner, row.participants[0] ?? "", row.participants[1] ?? "")
        : scopedKey(row.owner, row.profile, row.id);
    const mapped = await run(converse.conversationIdOf(scoped));
    if (mapped !== undefined) return scoped;
    // Pre-profile conversations keep their `owner:id` mapping; resolved keys
    // must follow the data, not the new format.
    if (row.profile === "default" && row.kind === "session") {
      const legacy = legacyKey(row.owner, row.id);
      const legacyMapped = await run(converse.conversationIdOf(legacy));
      if (legacyMapped !== undefined) return legacy;
    }
    return scoped;
  };

  const rebuild = async (): Promise<void> => {
    const [rows, stored, tasks] = await Promise.all([
      run(readSessions(converse)),
      run(readProfiles(converse)),
      run(converse.docs.snapshot(TasksDoc)),
    ]);
    for (const row of rows) {
      const key =
        row.kind === "dm" && row.participants !== null
          ? pairKey(row.owner, row.participants[0] ?? "", row.participants[1] ?? "")
          : await keyOfRow(row);
      const cid = await run(converse.conversationIdOf(key));
      if (cid !== undefined) {
        scopes.set(String(cid), scopeOfRow(row));
        const profile = stored.find(
          (candidate) => candidate.owner === row.owner && candidate.id === row.profile,
        );
        if (profile !== undefined) profiles.set(String(cid), profile);
      }
    }
    // Task conversations run as their bot: the one stored on the row, else
    // the spawning conversation's (indexed above, or an earlier task's).
    for (const task of tasks?.tasks ?? []) {
      const cid = await run(converse.conversationIdOf(taskConversationKey(task.id)));
      if (cid === undefined) continue;
      const parent = task.conversationId === null ? undefined : scopes.get(task.conversationId);
      const owner = task.bot?.owner ?? parent?.owner;
      const profileId = task.bot?.profileId ?? parent?.profileId;
      const profile = stored.find(
        (candidate) => candidate.owner === owner && candidate.id === profileId,
      );
      if (owner === undefined || profileId === undefined || profile === undefined) continue;
      scopes.set(String(cid), { owner, profileId, kind: "task", participants: null });
      profiles.set(String(cid), profile);
    }
  };

  return {
    scopes,
    profiles,
    ensure: async () => {
      built ??= rebuild();
      await built;
    },
    keyOfRow,
    ensureConversationFor: async (key, profile, scope) => {
      const change = agentFor(profile);
      const hasOverride = change.model !== undefined || change.tools !== undefined;
      await run(converse.ensure(key, hasOverride ? change : undefined));
      const cid = await run(converse.conversationIdOf(key));
      if (cid !== undefined) {
        profiles.set(String(cid), profile);
        scopes.set(String(cid), scope);
      }
    },
  };
};
