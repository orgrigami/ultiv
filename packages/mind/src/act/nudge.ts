/**
 * The background-work nudge: a wrapper on every act tool that watches how
 * deep the current turn is going and, at a threshold, appends one line to a
 * tool result suggesting task_spawn. It fires where the model can act on it
 * (inside the turn, at a tool boundary), it never blocks or rewrites work,
 * and it stays quiet outside a cooldown. The gate (capacity, not-a-task)
 * lives with the caller, who owns the tasks service.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";

/** True when this conversation may spawn a task right now. */
export interface NudgeGate {
  readonly maySpawn: (conversationId: string) => Promise<boolean>;
}

export const TASK_NUDGE =
  "This turn is doing a lot inline. If the rest is mechanical, task_spawn can run it in " +
  "the background while you end your turn; you are woken with the result.";

/** Tool calls within this window count as one stretch of work. */
const WINDOW_MS = 5 * 60_000;
/** A stretch this many calls deep is worth moving to a task. */
const CALLS_THRESHOLD = 8;
/** One call this slow is evidence on its own. */
const SLOW_MS = 30_000;
/** At most one nudge per conversation in this window. */
const COOLDOWN_MS = 10 * 60_000;

/**
 * Appends the nudge to a result's own text blocks (never to structuredOutput,
 * never to an error), or returns the result untouched when there is nothing
 * safe to append to.
 */
const withNote = <T extends { readonly output?: readonly unknown[] }>(result: T): T => {
  const output = result.output;
  if (output === undefined || output.length === 0) return result;
  const note = { type: "text", text: TASK_NUDGE };
  return { ...result, output: [...output, note] as T["output"] };
};

export const withTaskNudge = <TParameters extends TSchema>(
  tool: ToolRegistration<TParameters>,
  gate: NudgeGate,
  now: () => number = Date.now,
): ToolRegistration<TParameters> => {
  /** Recent call finishes per conversation; a stretch of work in progress. */
  const stretches = new Map<string, number[]>();
  /** Last nudge per conversation, for the cooldown. */
  const nudgedAt = new Map<string, number>();
  return {
    ...tool,
    execute: async (args, api, context) => {
      const startedAt = now();
      const conversation = String(api.conversationId);
      const result = await tool.execute(args, api, context);
      if (result.isError === true) return result;
      const at = now();
      const stretch = (stretches.get(conversation) ?? []).filter((seen) => at - seen < WINDOW_MS);
      stretch.push(at);
      if (stretch.length > 0) stretches.set(conversation, stretch);
      else stretches.delete(conversation);
      if (at - (nudgedAt.get(conversation) ?? -Infinity) < COOLDOWN_MS) return result;
      const slow = at - startedAt >= SLOW_MS;
      if (!slow && stretch.length < CALLS_THRESHOLD) return result;
      if (!(await gate.maySpawn(conversation))) return result;
      nudgedAt.set(conversation, at);
      return withNote(result);
    },
  };
};
