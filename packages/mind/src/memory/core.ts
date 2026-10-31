/**
 * Core memory: the small always-on block that sits in EVERY prompt of its
 * scope — owner core (≤120 words, ≤10 lines, ≤25 words per line) shared by
 * all bots, profile core (≤80 words, ≤8 lines) per bot. Seeded only from
 * profile settings (name, time zone) — never from model output. Only the
 * keeper (owner scope) or the bot itself (profile scope) or a human writes;
 * bots cannot edit lines the owner pinned. Rendered as its own `memory.core`
 * prompt section, capped at 230 words.
 */
import { randomUUID } from "node:crypto";
import type { CoreLine } from "@spreissen/contracts";
import { Effect } from "effect";
import { InvalidInput, NotFound } from "@spreissen/core";
import type { ConverseService } from "../converse/converse.ts";
import { CoreDoc, ownerKey, profileKey } from "./model.ts";

export const CORE_LIMITS = {
  ownerWords: 120,
  ownerLines: 10,
  profileWords: 80,
  profileLines: 8,
  wordsPerLine: 25,
  /** The prompt-render budget across both stores. */
  renderWords: 230,
} as const;

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export const linesWordCount = (lines: readonly CoreLine[]): number =>
  lines.reduce((sum, line) => sum + wordCount(line.text), 0);

export interface CoreService {
  /** Read one store's core lines (owner store: shared by all bots). */
  readonly read: (owner: string, profileId: string | null) => Promise<readonly CoreLine[]>;
  /** Add a line; refuses when the store is over its word/line budget. */
  readonly add: (input: {
    readonly owner: string;
    readonly profileId: string | null;
    readonly scope: "profile" | "owner";
    readonly writer: string | null;
    readonly text: string;
    readonly factId?: string | null;
    readonly pinned?: boolean;
  }) => Promise<CoreLine>;
  /** Replace a line's text; pinned lines refuse bot writers. */
  readonly replace: (input: {
    readonly owner: string;
    readonly profileId: string | null;
    readonly writer: string | null;
    readonly lineId: string;
    readonly text: string;
  }) => Promise<CoreLine>;
  /** Remove a line; pinned lines refuse bot writers. */
  readonly remove: (input: {
    readonly owner: string;
    readonly profileId: string | null;
    readonly writer: string | null;
    readonly lineId: string;
  }) => Promise<void>;
}

export const coreService = (deps: {
  readonly converse: ConverseService;
  /** Profile settings seed the core (name, time zone) on first access. */
  readonly profiles?: {
    readonly get: (
      owner: string,
      id: string,
    ) => Promise<
      | {
          readonly name: string;
          readonly timezone: string;
          readonly policies: { readonly memoryKeeper: boolean };
        }
      | undefined
    >;
  };
}): CoreService => {
  const keyOf = (owner: string, profileId: string | null): string =>
    profileId === null ? ownerKey(owner) : profileKey(owner, profileId);

  const read = (owner: string, profileId: string | null): Promise<readonly CoreLine[]> =>
    run(deps.converse.docs.snapshotKeyed(CoreDoc, keyOf(owner, profileId))).then(
      (store) => store?.lines ?? [],
    );

  /** Seed once from profile settings only (name, time zone) — no model output. */
  const seedIfNew = async (owner: string, profileId: string | null): Promise<void> => {
    let settings: { readonly name?: string; readonly timezone?: string } = {};
    if (profileId !== null && deps.profiles !== undefined) {
      const profile = await deps.profiles.get(owner, profileId).catch(() => undefined);
      if (profile !== undefined) settings = { name: profile.name, timezone: profile.timezone };
    }
    await run(
      deps.converse.docs.commit(async (tx) => {
        const core = await tx.doc(CoreDoc, keyOf(owner, profileId), {
          lines: [],
          seededAt: null,
        });
        if (core.seededAt !== null) return;
        const lines: CoreLine[] = [];
        if (settings.timezone !== undefined && settings.timezone !== "") {
          lines.push({
            id: randomUUID(),
            text: `Owner's time zone: ${settings.timezone}.`,
            factId: null,
            pinned: true,
            at: Date.now(),
          });
        }
        core.lines = lines;
        core.seededAt = Date.now();
      }),
    );
  };

  const service: CoreService = {
    read: async (owner, profileId) => {
      await seedIfNew(owner, profileId);
      return read(owner, profileId);
    },
    add: async (input) => {
      const text = input.text.trim();
      if (text === "") throw new InvalidInput({ reason: "core line text is required" });
      if (wordCount(text) > CORE_LIMITS.wordsPerLine) {
        throw new InvalidInput({
          reason: `core lines carry at most ${CORE_LIMITS.wordsPerLine} words`,
        });
      }
      if (input.pinned === true && input.writer !== null) {
        throw new InvalidInput({ reason: "only the owner pins core lines" });
      }
      if (input.scope === "owner" && input.writer !== null) {
        // Only the designated keeper (or a human, writer null) writes owner core.
        const writer =
          deps.profiles === undefined
            ? undefined
            : await deps.profiles.get(input.owner, input.writer).catch(() => undefined);
        if (writer?.policies.memoryKeeper !== true) {
          throw new InvalidInput({ reason: "owner core is written by the keeper or a human only" });
        }
      }
      const lines = await service.read(input.owner, input.profileId);
      const isOwner = input.profileId === null;
      const maxLines = isOwner ? CORE_LIMITS.ownerLines : CORE_LIMITS.profileLines;
      const maxWords = isOwner ? CORE_LIMITS.ownerWords : CORE_LIMITS.profileWords;
      if (lines.length >= maxLines) {
        throw new InvalidInput({ reason: `core is full (${maxLines} lines); remove one first` });
      }
      if (linesWordCount(lines) + wordCount(text) > maxWords) {
        throw new InvalidInput({
          reason: `core is over its ${maxWords}-word budget; shorten or remove a line`,
        });
      }
      const line: CoreLine = {
        id: randomUUID(),
        text,
        factId: input.factId ?? null,
        pinned: input.pinned ?? false,
        at: Date.now(),
      };
      await run(
        deps.converse.docs.commit(async (tx) => {
          const core = await tx.doc(CoreDoc, keyOf(input.owner, input.profileId), {
            lines: [],
            seededAt: null,
          });
          core.lines = [...core.lines, line];
        }),
      );
      return line;
    },
    replace: async (input) => {
      const lines = await service.read(input.owner, input.profileId);
      const existing = lines.find((line) => line.id === input.lineId);
      if (existing === undefined) {
        throw new NotFound({ what: `core line ${input.lineId}` });
      }
      if (existing.pinned && input.writer !== null) {
        throw new InvalidInput({ reason: "bots cannot edit lines the owner pinned" });
      }
      const text = input.text.trim();
      if (text === "" || wordCount(text) > CORE_LIMITS.wordsPerLine) {
        throw new InvalidInput({
          reason: `core lines carry 1–${CORE_LIMITS.wordsPerLine} words`,
        });
      }
      const others = lines.filter((line) => line.id !== input.lineId);
      const isOwner = input.profileId === null;
      const budget = isOwner ? CORE_LIMITS.ownerWords : CORE_LIMITS.profileWords;
      if (linesWordCount(others) + wordCount(text) > budget) {
        throw new InvalidInput({ reason: `core is over its ${budget}-word budget` });
      }
      const updated: CoreLine = { ...existing, text };
      await run(
        deps.converse.docs.commit(async (tx) => {
          const core = await tx.doc(CoreDoc, keyOf(input.owner, input.profileId), {
            lines: [],
            seededAt: null,
          });
          core.lines = core.lines.map((line) => (line.id === updated.id ? updated : line));
        }),
      );
      return updated;
    },
    remove: async (input) => {
      const lines = await service.read(input.owner, input.profileId);
      const existing = lines.find((line) => line.id === input.lineId);
      if (existing === undefined) {
        throw new NotFound({ what: `core line ${input.lineId}` });
      }
      if (existing.pinned && input.writer !== null) {
        throw new InvalidInput({ reason: "bots cannot remove lines the owner pinned" });
      }
      await run(
        deps.converse.docs.commit(async (tx) => {
          const core = await tx.doc(CoreDoc, keyOf(input.owner, input.profileId), {
            lines: [],
            seededAt: null,
          });
          core.lines = core.lines.filter((line) => line.id !== input.lineId);
        }),
      );
    },
  };
  return service;
};
