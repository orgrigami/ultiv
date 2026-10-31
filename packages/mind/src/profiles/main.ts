/**
 * Bot Mode main chats and the owner's main bot: each profile's persistent
 * main chat (created lazily, single-flight, rotated on reset), the spawn-time
 * onboarding turn, and the one main bot per owner.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { NotFound } from "@spreissen/core";
import type { ProfileInfo, SessionInfo } from "@spreissen/contracts";
import {
  MAIN_PREFIX,
  SettingsDoc,
  commitSessions,
  readProfiles,
  readSessions,
  scopedKey,
} from "./docs.ts";
import type { ProfilesContext, ProfilesService } from "./types.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const requireProfile = async (
  ctx: ProfilesContext,
  owner: string,
  profileId: string,
): Promise<ProfileInfo> => {
  const profile = await ctx.self().get(owner, profileId);
  if (profile === undefined) throw new NotFound({ what: `profile ${profileId}` });
  return profile;
};

/** The spawn-time first turn, from the provided identity details. */
export const onboardProfile = async (
  ctx: ProfilesContext,
  owner: string,
  profile: ProfileInfo,
): Promise<void> => {
  const { converse } = ctx;
  try {
    const main = await ctx.self().ensureMain(owner, profile.id);
    const key = scopedKey(owner, profile.id, main.id);
    const conversation = await run(converse.ensure(key));
    const description = profile.description !== "" ? `\n\nYour role: ${profile.description}` : "";
    const persona =
      profile.persona !== ""
        ? `\n\nYour identity and persona, as the owner wrote it:\n${profile.persona}`
        : "\n\nNo persona was provided yet; the owner will shape you over time.";
    const submission = await run(
      converse.submit(
        conversation,
        `[onboarding] You are ${profile.name} — a new bot in this workspace, created by the ` +
          `owner just now.${description}${persona}\n\nIntroduce yourself in one or two lines ` +
          `(who you are, what you are for), then stand by. Use no tools for this.`,
      ),
    );
    void run(converse.settle(conversation, submission)).catch(() => undefined);
  } catch {
    // Admission is best-effort at spawn time; creation itself never fails.
  }
};

const ensureMainOnce = async (
  ctx: ProfilesContext,
  owner: string,
  profileId: string,
): Promise<SessionInfo> => {
  await requireProfile(ctx, owner, profileId);
  const rows = await run(readSessions(ctx.converse));
  const existing = rows.find(
    (row) => row.owner === owner && row.profile === profileId && row.kind === "main",
  );
  if (existing !== undefined) return existing;
  const profile = await requireProfile(ctx, owner, profileId);
  const row: SessionInfo = {
    id: `${MAIN_PREFIX}${randomUUID().slice(0, 8)}`,
    owner,
    profile: profileId,
    kind: "main",
    participants: null,
    title: profile.name,
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
  };
  await run(commitSessions(ctx.converse, (sessions) => [...sessions, row]));
  await ctx.index.ensureConversationFor(scopedKey(owner, profileId, row.id), profile, {
    owner,
    profileId,
    kind: "main",
    participants: null,
  });
  return row;
};

export const mainOps = (
  ctx: ProfilesContext,
): Pick<ProfilesService, "ensureMain" | "resetMain" | "mainOf" | "setMain"> => {
  const { converse } = ctx;
  /**
   * Single-flight per (owner, profile): onboarding's spawn-time ensureMain
   * races the caller's — concurrent creation must yield ONE main chat.
   */
  const mainInFlight = new Map<string, Promise<SessionInfo>>();
  return {
    ensureMain: (owner, profileId) => {
      const flightKey = `${owner}:${profileId}`;
      const inFlight = mainInFlight.get(flightKey);
      if (inFlight !== undefined) return inFlight;
      const promise = ensureMainOnce(ctx, owner, profileId).finally(() => {
        mainInFlight.delete(flightKey);
      });
      mainInFlight.set(flightKey, promise);
      return promise;
    },
    resetMain: async (owner, profileId) => {
      // The old main row stays listed as a plain session (history kept);
      // a fresh main id means a fresh conversation key.
      await run(
        commitSessions(converse, (sessions) =>
          sessions.map((row) =>
            row.owner === owner && row.profile === profileId && row.kind === "main"
              ? { ...row, kind: "session" as const, title: `${row.title} (reset)` }
              : row,
          ),
        ),
      );
      return ctx.self().ensureMain(owner, profileId);
    },
    mainOf: async (owner) => {
      const stored = await run(converse.docs.snapshot(SettingsDoc));
      const main = stored?.main[owner];
      if (main !== undefined && main !== "") return main;
      const rows = await run(readProfiles(converse));
      const owned = rows.filter((p) => p.owner === owner);
      const fallback = owned.find((p) => p.id === "default") ?? owned[0];
      // Fresh workspace: no bots, no main. The first spawn claims it.
      return fallback?.id ?? null;
    },
    setMain: async (owner, profileId) => {
      await requireProfile(ctx, owner, profileId);
      await run(
        converse.docs.commit(async (tx) => {
          const draft = await tx.doc(SettingsDoc);
          draft.main = { ...draft.main, [owner]: profileId };
        }),
      );
    },
  };
};
