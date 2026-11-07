/**
 * A routine trial: the routine's prompt run AS its bot, on the model the
 * live run would use, with every tool call held back (the dry-run guard), so
 * the owner sees what it WOULD do before it touches anything. Nothing runs,
 * nothing is sent, no chat is woken and no push goes out.
 */
import { Type, type Static } from "typebox";
import type { Json } from "./tasks.ts";

const JsonSchema = Type.Unsafe<Json>(Type.Unknown());

/** One call the bot tried during a trial; it did not run. */
export const TrialActionSchema = Type.Object({
  name: Type.String(),
  /** Its input, JSON-safe; a long one is cut to `{ "truncated": "…" }`. */
  input: JsonSchema,
});

export type TrialAction = Static<typeof TrialActionSchema>;

export const RoutineTrialSchema = Type.Object({
  at: Type.Number(),
  /** What the bot would have said (empty when it said nothing). */
  reply: Type.String(),
  /** The calls it tried, in order; none ran. */
  actions: Type.Array(TrialActionSchema),
  /** Why the trial could not run, in owner words; null when it ran. */
  error: Type.Union([Type.String(), Type.Null()]),
});

export type RoutineTrial = Static<typeof RoutineTrialSchema>;

/** Trials kept on a routine, newest last. */
export const TRIALS_KEPT = 3;
