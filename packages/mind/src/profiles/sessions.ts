/** Session rows of a profile, and the keys and scopes their conversations map to. */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { InvalidInput, NotFound } from "@spreissen/core";
import type { SessionInfo } from "@spreissen/contracts";
import { commitSessions, readSessions, scopedKey, titleFor } from "./docs.ts";
import { requireProfile } from "./main.ts";
import type { ProfilesContext, ProfilesService } from "./types.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const sessionOps = (
  ctx: ProfilesContext,
): Pick<ProfilesService, "createSession" | "listSessions" | "removeSession" | "touchSession"> => {
  const { converse, generate } = ctx;
  return {
    createSession: async (owner, profileId, title) => {
      const profile = await requireProfile(ctx, owner, profileId);
      if (profile.archivedAt !== null) throw new InvalidInput({ reason: "profile is archived" });
      const row: SessionInfo = {
        id: randomUUID(),
        owner,
        profile: profileId,
        kind: "session",
        participants: null,
        title: title ?? "",
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      };
      await run(commitSessions(converse, (sessions) => [...sessions, row]));
      await ctx.index.ensureConversationFor(scopedKey(owner, profileId, row.id), profile, {
        owner,
        profileId,
        kind: "session",
        participants: null,
      });
      return row;
    },
    listSessions: (owner, profileId) =>
      run(readSessions(converse)).then((rows) =>
        rows
          // Legacy pair-DM rows predate rooms; they were never the owner's
          // chats (and carried the shared-identity bug) — keep them out of
          // the list. DELETE /api/sessions/:id still removes them.
          .filter((row) => row.kind !== "dm" && row.kind !== "task")
          .filter((row) =>
            profileId === undefined
              ? row.owner === owner
              : row.owner === owner &&
                (row.profile === profileId || row.participants?.includes(profileId) === true),
          ),
      ),
    removeSession: (owner, id) =>
      run(
        commitSessions(converse, (sessions) =>
          sessions.filter((row) => !(row.id === id && row.owner === owner)),
        ),
      ).then(() => true),
    touchSession: async (owner, chatId, info) => {
      const seedTitle =
        info.titleSeed !== undefined ? await titleFor(generate, info.titleSeed) : undefined;
      await run(
        commitSessions(converse, (sessions) => {
          const index = sessions.findIndex(
            (row) => row.id === chatId && (row.owner === owner || owner === "guest"),
          );
          if (index < 0) {
            // Register on first contact (legacy ids included), under default.
            return [
              ...sessions,
              {
                id: chatId,
                owner,
                profile: "default",
                kind: "session" as const,
                participants: null,
                title: seedTitle ?? chatId,
                createdAt: info.at,
                lastMessageAt: info.at,
              },
            ];
          }
          const current = sessions[index] as SessionInfo;
          sessions[index] = {
            ...current,
            lastMessageAt: info.at,
            title: current.title === "" && seedTitle !== undefined ? seedTitle : current.title,
          };
          return sessions;
        }),
      );
    },
  };
};

export const keyOps = (
  ctx: ProfilesContext,
): Pick<
  ProfilesService,
  "rowOf" | "keyOfRow" | "keyForSession" | "adoptConversation" | "bindTask"
> => {
  const { converse, index } = ctx;
  return {
    rowOf: (id) => run(readSessions(converse)).then((rows) => rows.find((row) => row.id === id)),
    keyOfRow: (row) => index.keyOfRow(row),
    keyForSession: async (owner, id) => {
      const row = await ctx.self().rowOf(id);
      if (row !== undefined && (row.owner === owner || owner === "guest")) {
        return index.keyOfRow(row);
      }
      return scopedKey(owner, "default", id);
    },
    adoptConversation: async (key, scope) => {
      const profile = await ctx.self().get(scope.owner, scope.profileId);
      if (profile === undefined) throw new NotFound({ what: `profile ${scope.profileId}` });
      await index.ensureConversationFor(key, profile, {
        owner: scope.owner,
        profileId: scope.profileId,
        kind: scope.kind,
        participants: scope.participants,
      });
    },
    /**
     * Bind a background task's conversation to its bot: the task runs AS that
     * bot (model, tools, identity, messaging, artifacts, memory, approvals).
     * The row's stored bot wins (it survives a restart); else the spawner's.
     */
    bindTask: async (key, parentConversationId, stored) => {
      await index.ensure();
      const parent =
        parentConversationId === null ? undefined : index.scopes.get(parentConversationId);
      const owner = stored?.owner ?? parent?.owner;
      const profileId = stored?.profileId ?? parent?.profileId;
      if (owner === undefined || profileId === undefined) return null;
      const profile = await ctx.self().get(owner, profileId);
      if (profile === undefined) return null;
      const participants =
        parent !== undefined && parent.owner === owner && parent.profileId === profileId
          ? parent.participants
          : null;
      await index.ensureConversationFor(key, profile, {
        owner,
        profileId,
        kind: "task",
        participants,
      });
      return { owner, profileId };
    },
  };
};
