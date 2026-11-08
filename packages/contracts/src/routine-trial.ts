/**
 * A routine trial: the routine's prompt run AS its bot, on the model the
 * live run would use, with every tool call held back (the dry-run guard), so
 * the owner sees what it WOULD do before it touches anything. Nothing runs,
 * nothing is sent, no chat is woken and no push goes out.
 */
import {
  arr,
  nul,
  num,
  obj,
  str,
  union,
  unknown,
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";
import type { Json } from "./tasks.ts";

const JsonSchema = unknown() as Schema<Json>;

/** One call the bot tried during a trial; it did not run. */
export const TrialActionSchema = obj(
  {
    name: str(),
    /** Its input, JSON-safe; a long one is cut to `{ "truncated": "…" }`. */
    input: JsonSchema,
  },
  { open: true },
);

export type TrialAction = Static<typeof TrialActionSchema>;

export const RoutineTrialSchema = obj(
  {
    at: num(),
    /** What the bot would have said (empty when it said nothing). */
    reply: str(),
    /** The calls it tried, in order; none ran. */
    actions: arr(TrialActionSchema),
    /** Why the trial could not run, in owner words; null when it ran. */
    error: union([str(), nul()]),
  },
  { open: true },
);

export type RoutineTrial = Static<typeof RoutineTrialSchema>;

/** Trials kept on a routine, newest last. */
export const TRIALS_KEPT = 3;
