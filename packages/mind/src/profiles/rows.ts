/** Profile rows: list, read, create, edit, archive, always-allow and remove. */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { NotFound } from "@ultiv/core";
import type { ProfileInfo } from "@ultiv/contracts";
import {
  NEVER_PATTERN_MATCHED,
  actionTextsOf,
  globEscape,
  mayAutoApprove,
} from "../auto-approve.ts";
import {
  SettingsDoc,
  commitProfiles,
  commitSessions,
  defaultPolicies,
  defaultTimezone,
  readProfiles,
  readSessions,
} from "./docs.ts";
import { onboardProfile } from "./main.ts";
import { PROFILE_LIMITS, patchedProfile, refreshCopies, validatePatch } from "./update.ts";
import type { ProfilesContext, ProfilesService } from "./types.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const rowOps = (
  ctx: ProfilesContext,
): Pick<ProfilesService, "list" | "get" | "create" | "update"> => {
  const { converse } = ctx;
  return {
    list: async (owner) =>
      // No default bot materializes on a fresh workspace — it starts empty and
      // the first spawned bot becomes main (see create). After a deliberate
      // deletion the list stays empty; nothing resurrects.
      run(readProfiles(converse)).then((all) => all.filter((p) => p.owner === owner)),
    get: (owner, id) =>
      run(readProfiles(converse)).then((rows) =>
        rows.find((p) => p.owner === owner && p.id === id),
      ),
    create: (owner, input) => {
      // Same checks as update; `model: null` means "workspace default".
      validatePatch(input);
      const profile: ProfileInfo = {
        id: randomUUID(),
        owner,
        name: input.name.trim().slice(0, PROFILE_LIMITS.name),
        description: (input.description ?? "").slice(0, PROFILE_LIMITS.description),
        persona: (input.persona ?? "").slice(0, PROFILE_LIMITS.persona),
        timezone: input.timezone ?? defaultTimezone(),
        model: input.model ?? null,
        toolAllowlist: input.toolAllowlist ?? null,
        policies: { ...defaultPolicies(), ...input.policies },
        createdAt: Date.now(),
        archivedAt: null,
      };
      return run(commitProfiles(converse, (profiles) => [...profiles, profile])).then(async () => {
        // The first bot in a fresh workspace claims main automatically — there
        // is no seeded Ultius anymore.
        const settings = await run(converse.docs.snapshot(SettingsDoc));
        const stored = settings?.main[owner];
        if (stored === undefined || stored === "") await ctx.self().setMain(owner, profile.id);
        // Spawning initiates the conversation: the bot's first turn runs
        // under its own identity, built from the provided details. Best
        // effort — admission succeeds even when the model call cannot run.
        if (input.onboard !== false) void onboardProfile(ctx, owner, profile);
        return profile;
      });
    },
    update: async (owner, id, patch) => {
      validatePatch(patch);
      const rows = await run(readProfiles(converse));
      const current = rows.find((p) => p.owner === owner && p.id === id);
      if (current === undefined) throw new NotFound({ what: `profile ${id}` });
      const next = patchedProfile(current, patch);
      await run(
        commitProfiles(converse, (profiles) =>
          profiles.map((row) => (row.id === id && row.owner === owner ? next : row)),
        ),
      );
      // Every chat of the bot picks the edit up from its next turn.
      refreshCopies(ctx.index.profiles, next);
      return next;
    },
  };
};

export const lifecycleOps = (
  ctx: ProfilesContext,
): Pick<ProfilesService, "setArchived" | "allowTool" | "remove"> => {
  const { converse } = ctx;
  return {
    setArchived: (owner, id, archived) =>
      run(
        commitProfiles(converse, (rows) =>
          rows.map((row) =>
            row.id === id && row.owner === owner
              ? { ...row, archivedAt: archived ? Date.now() : null }
              : row,
          ),
        ),
      )
        .then(() => ctx.self().get(owner, id))
        .then((profile) => {
          if (profile === undefined) throw new NotFound({ what: `profile ${id}` });
          return profile;
        }),
    allowTool: async (owner, profileId, tool, input): Promise<string[]> => {
      const rows = await run(readProfiles(converse));
      const current = rows.find((p) => p.owner === owner && p.id === profileId);
      if (current === undefined) throw new NotFound({ what: `profile ${profileId}` });
      // The privileged host shell is never granted from a card — bash.ts is
      // explicit that it must never be always-allowed, and a pattern for it
      // is authored via REST only. The call stays gated.
      if (NEVER_PATTERN_MATCHED.includes(tool)) {
        console.warn(`always-allow on ${tool}: refused, the host shell stays gated`);
        return [];
      }
      // "Always allow" on a card that a tool:pattern entry just refused must
      // not silently widen the profile to the whole tool: when the list
      // already holds patterns for this tool, save THIS call's exact action
      // text as one more narrow pattern. And only a SINGLE shell text may
      // become a rule — a multi-field call (http_request's
      // method/url/host/credential) would mint per-field rules whose weakest
      // field is the grant ("http_request:POST" approving ANY POST to any
      // host). Every candidate is verified with the gate's own predicate
      // before it is stored; if none verifies, nothing is written and []
      // tells the caller the call stays gated (the card already went out).
      const hasPattern = current.policies.autoApprove.some((e) => e.startsWith(`${tool}:`));
      let entries: string[];
      if (!hasPattern) {
        entries = [tool];
      } else {
        const texts = actionTextsOf(input);
        const first = texts[0];
        const single = texts.length === 1 && first?.shell === true ? first : undefined;
        const request = { callId: "always", name: tool, input };
        const candidate = single === undefined ? undefined : `${tool}:${globEscape(single.text)}`;
        if (candidate === undefined || !mayAutoApprove([candidate], request)) {
          console.warn(
            `always-allow on ${tool}: the call stays gated by its pattern, no rule saved`,
          );
          return [];
        }
        entries = [candidate];
      }
      await run(
        commitProfiles(converse, (all) =>
          all.map((row) =>
            row.id === profileId && row.owner === owner
              ? {
                  ...row,
                  policies: {
                    ...row.policies,
                    autoApprove: [...new Set([...row.policies.autoApprove, ...entries])],
                  },
                }
              : row,
          ),
        ),
      );
      return entries;
    },
    remove: async (owner, id) => {
      const rows = await run(readSessions(converse));
      const mine = rows.filter((row) => row.owner === owner && row.profile === id);
      await run(
        commitSessions(converse, (sessions) =>
          sessions.filter((row) => !(row.owner === owner && row.profile === id)),
        ),
      );
      await run(
        commitProfiles(converse, (profiles) =>
          profiles.filter((p) => !(p.owner === owner && p.id === id)),
        ),
      );
      return mine;
    },
  };
};
