/**
 * Fact handles: the short id a model can see and use. Fact ids are UUIDs,
 * and the harness never shows a tool's structured output to the model — so
 * every model-facing memory line carries `#` plus the id's first 8
 * characters, and every tool that takes a fact id also takes that handle
 * (or any unique prefix of at least 6 characters, `#` optional).
 */
import { InvalidInput, NotFound } from "@spriessen/core";

export const HANDLE_CHARS = 8;
const MIN_PREFIX = 6;

/** The model-facing handle of a fact id: `#1a2b3c4d`. */
export const handleOf = (id: string): string => `#${id.slice(0, HANDLE_CHARS)}`;

/**
 * The fact id a reference names, among `facts`: the full id, or a unique
 * prefix (a handle). Undefined when nothing matches; a prefix two facts
 * share is refused with a sentence the model can act on.
 */
export const resolveFactRef = (
  ref: string,
  facts: readonly { readonly id: string }[],
): string | undefined => {
  const wanted = ref.trim().replace(/^#/, "").toLowerCase();
  if (wanted === "") return undefined;
  const exact = facts.find((fact) => fact.id.toLowerCase() === wanted);
  if (exact !== undefined) return exact.id;
  if (wanted.length < MIN_PREFIX) return undefined;
  const ids = [...new Set(facts.map((fact) => fact.id))].filter((id) =>
    id.toLowerCase().startsWith(wanted),
  );
  if (ids.length > 1) {
    throw new InvalidInput({
      reason: `the handle #${wanted} matches ${ids.length} facts; use a longer prefix of the id`,
    });
  }
  return ids[0];
};

/** resolveFactRef, refusing an unknown reference with the model's own words. */
export const requireFactRef = (ref: string, facts: readonly { readonly id: string }[]): string => {
  const id = resolveFactRef(ref, facts);
  if (id === undefined) {
    throw new NotFound({ what: `fact ${ref.trim()} (use a #handle from memory_recall)` });
  }
  return id;
};

/** A day as the model reads it: YYYY-MM-DD in the bot's zone (WIB by default). */
export const dayOf = (at: number, offsetHours = 7): string =>
  new Date(at + offsetHours * 3_600_000).toISOString().slice(0, 10);

/** A refusal the model can act on: the error's reason, or what was not found. */
export const causeText = (cause: unknown): string => {
  const error = cause as { reason?: unknown; what?: unknown } | null;
  if (typeof error?.reason === "string") return error.reason;
  if (typeof error?.what === "string") return `unknown ${error.what}`;
  return String(cause);
};
