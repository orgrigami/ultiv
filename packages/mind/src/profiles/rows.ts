/** Profile rows: list, read, create, edit, archive, always-allow and remove. */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { InvalidInput, NotFound } from "@spriessen/core";
import { bashNodeNameOf, type HomeRef, type ProfileInfo } from "@spriessen/contracts";
import {
  actionTextsOf,
  exactOnlyCall,
  exactScriptInput,
  globEscape,
  MAX_EXACT_SCRIPT_CHARS,
  mayAutoApprove,
  targetExactEntry,
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
import { homeRuleProblem, type HomeChange } from "../org/home-rules.ts";

/** Refuse a change that would break a home invariant (main bot in the org, the org never empty). */
export const guardHome = async (
  ctx: ProfilesContext,
  owner: string,
  change: HomeChange,
): Promise<void> => {
  const rows = await run(readProfiles(ctx.converse));
  const problem = homeRuleProblem(rows, owner, await ctx.self().mainOf(owner), change);
  if (problem !== null) throw new InvalidInput({ reason: problem });
};

/** The home a `departmentId` names: a department, or the org for null/empty. */
const homeRefOf = (departmentId: string | null | undefined): HomeRef | undefined => {
  if (departmentId === undefined) return undefined;
  return typeof departmentId === "string" && departmentId !== ""
    ? { kind: "department", departmentId }
    : { kind: "org" };
};

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
      validatePatch(input, ctx.knownModel);
      return guardHome(ctx, owner, { kind: "create", to: input.departmentId ?? null }).then(() =>
        createRow(ctx, owner, input),
      );
    },
    update: async (owner, id, patch, meta) => {
      validatePatch(patch, ctx.knownModel);
      const moving = patch.departmentId !== undefined;
      if (moving) {
        await guardHome(ctx, owner, { kind: "move", id, to: patch.departmentId ?? null });
      }
      const before = moving ? await ctx.self().get(owner, id) : undefined;
      const next = await updateRow(ctx, owner, id, patch, meta);
      // A move between homes: retire the bot's user from the OLD home's VM
      // (its group memberships go with it); the new home provisions the
      // same stored uid on the bot's first `bash` there (slice 2).
      const from = homeRefOf(before?.departmentId);
      const to = homeRefOf(next.departmentId);
      if (ctx.retireUserFromHome !== undefined && from !== undefined && to !== undefined) {
        const moved =
          from.kind !== to.kind ||
          (from.kind === "department" &&
            to.kind === "department" &&
            from.departmentId !== to.departmentId);
        if (moved) void ctx.retireUserFromHome(owner, from, id).catch(() => {});
      }
      return next;
    },
  };
};

const createRow = (
  ctx: ProfilesContext,
  owner: string,
  input: Parameters<ProfilesService["create"]>[1],
): Promise<ProfileInfo> => {
  const { converse } = ctx;
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
    departmentId: input.departmentId ?? null,
    hostAccess: input.hostAccess ?? false,
  };
  return run(commitProfiles(converse, (profiles) => [...profiles, profile])).then(async () => {
    // The first bot in a fresh workspace claims main automatically — there
    // is no seeded Ultius anymore.
    const settings = await run(converse.docs.snapshot(SettingsDoc));
    const stored = settings?.main[owner];
    if (stored === undefined || stored === "") await ctx.self().setMain(owner, profile.id);
    // Both files exist from the start: Persona from the field, Instructions empty.
    ctx.files?.ensure(profile);
    // Spawning initiates the conversation: the bot's first turn runs
    // under its own identity, built from the provided details. Best
    // effort — admission succeeds even when the model call cannot run.
    if (input.onboard !== false) void onboardProfile(ctx, owner, profile);
    return profile;
  });
};

const updateRow = async (
  ctx: ProfilesContext,
  owner: string,
  id: string,
  patch: Parameters<ProfilesService["update"]>[2],
  meta: Parameters<ProfilesService["update"]>[3],
): Promise<ProfileInfo> => {
  const { converse } = ctx;
  const rows = await run(readProfiles(converse));
  const current = rows.find((p) => p.owner === owner && p.id === id);
  if (current === undefined) throw new NotFound({ what: `profile ${id}` });
  const next = patchedProfile(current, patch);
  await run(
    commitProfiles(converse, (profiles) =>
      profiles.map((row) => (row.id === id && row.owner === owner ? next : row)),
    ),
  );
  // A Persona edit is a version of the Persona file; the field mirrors it.
  if (patch.persona !== undefined && ctx.files !== undefined) {
    ctx.files.ensure(current);
    ctx.files.save(next, "persona", next.persona, meta ?? { by: "owner", reason: "Edited" });
  }
  // Every chat of the bot picks the edit up from its next turn.
  refreshCopies(ctx.index.profiles, next);
  return next;
};

export const lifecycleOps = (
  ctx: ProfilesContext,
): Pick<ProfilesService, "setArchived" | "allowTool" | "remove"> => {
  const { converse } = ctx;
  /** Add entries to one profile's autoApprove list (deduplicated); returns them. */
  const saveEntries = async (
    owner: string,
    profileId: string,
    entries: string[],
  ): Promise<string[]> => {
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
    // The gate reads the per-conversation copy: refresh it so the rule
    // applies from the next call, not only after a restart.
    const next = await ctx.self().get(owner, profileId);
    if (next !== undefined) refreshCopies(ctx.index.profiles, next);
    return entries;
  };
  return {
    setArchived: async (owner, id, archived) => {
      if (archived) await guardHome(ctx, owner, { kind: "archive", id });
      return run(
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
        });
    },
    allowTool: async (owner, profileId, tool, input): Promise<string[]> => {
      const rows = await run(readProfiles(converse));
      const current = rows.find((p) => p.owner === owner && p.id === profileId);
      if (current === undefined) throw new NotFound({ what: `profile ${profileId}` });
      // The merged bash tool's beyond-VM targets are never granted as a whole
      // or by pattern from a card: "Always allow" saves THIS exact script
      // only, pinned to the target (`bash@host:=<script>` /
      // `bash@node:<id>:=<script>`), so a different script — or the same
      // script on another target — still asks. Nothing is saved when the
      // call isn't a plain `{ script, target }` or the script is too long to
      // keep; the call stays gated. The script itself is never logged.
      if (exactOnlyCall(tool, input)) {
        const exact = exactScriptInput(input);
        // A node rule pins the RESOLVED paired node. Without the registry's
        // resolver, only a call that names its node can be pinned (slice 2
        // wires the real lookup in); an unnamed node call stays gated.
        const named = bashNodeNameOf(input);
        const target =
          exact === undefined
            ? undefined
            : exact.target === "host"
              ? { kind: "host" as const }
              : named === null
                ? undefined
                : { kind: "node" as const, nodeId: named };
        const entry =
          exact !== undefined && target !== undefined
            ? targetExactEntry(target, exact.script)
            : undefined;
        const full = current.policies.autoApprove.length >= PROFILE_LIMITS.autoApproveEntries;
        if (
          exact === undefined ||
          exact.script === "" ||
          exact.script.length > MAX_EXACT_SCRIPT_CHARS ||
          entry === undefined ||
          (full && !current.policies.autoApprove.includes(entry)) ||
          !mayAutoApprove([entry], { callId: "always", name: tool, input })
        ) {
          console.warn(`always-allow on ${tool}: not saved as an exact rule, the call stays gated`);
          return [];
        }
        return saveEntries(owner, profileId, [entry]);
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
      return saveEntries(owner, profileId, entries);
    },
    remove: async (owner, id) => {
      await guardHome(ctx, owner, { kind: "remove", id });
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
