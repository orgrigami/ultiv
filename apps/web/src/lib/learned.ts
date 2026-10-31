/**
 * What a skill_learn step in the chat shows: the lesson, and whether its
 * one-tap undo still applies. Undo only rolls back the exact version this
 * step saved; if the skill changed since, the Skills page is the place.
 */
import type { BotFileVersion } from "./bot-files.ts";

export interface LearnedRef {
  readonly profile: string;
  readonly skill: string;
  readonly version: number;
  readonly lesson: string;
}

/** The learned save a finished skill_learn step reported, or undefined. */
export const learnedOf = (details: unknown): LearnedRef | undefined => {
  if (typeof details !== "object" || details === null) return undefined;
  const record = details as Record<string, unknown>;
  const { profile, skill, version, lesson } = record;
  if (typeof profile !== "string" || profile === "") return undefined;
  if (typeof skill !== "string" || skill === "") return undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  return { profile, skill, version, lesson: typeof lesson === "string" ? lesson : "" };
};

export type UndoState = "undo" | "undone" | "changed";

/** Whether this learned version can still be undone, against the skill's history. */
export const undoStateOf = (history: readonly BotFileVersion[], version: number): UndoState => {
  const newest = history.reduce<BotFileVersion | undefined>(
    (best, entry) => (best === undefined || entry.n > best.n ? entry : best),
    undefined,
  );
  if (newest === undefined) return "changed";
  if (newest.n === version) return "undo";
  if (newest.n === version + 1 && newest.reason === `Undid version ${version}`) return "undone";
  return "changed";
};
