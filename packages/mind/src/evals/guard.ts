/**
 * The replay guard: a conversation that replays an eval case never runs a
 * tool. Every call it makes (model-issued or nested from code mode) is
 * blocked before execution, so nothing is written, sent, spent or put up for
 * approval; the model reads the block and answers without the result. The
 * replay list is durable (the evals doc): a replay resumed after a restart
 * stays blocked. Ids are kept in memory once read.
 */
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { ConverseService } from "../converse/converse.ts";
import { changeEvals, readEvals } from "./store.ts";

export const REPLAY_BLOCK =
  "[eval replay] Tools do not run while this conversation is replayed for a test. Answer as " +
  "well as you can without the result; say what you would have done.";

export interface ReplayGuard {
  /** Mark a conversation as a replay (durable) before its first input. */
  readonly add: (conversationId: string) => Promise<void>;
  readonly isReplay: (conversationId: string) => Promise<boolean>;
}

export const replayGuard = (converse: ConverseService): ReplayGuard => {
  const known = new Set<string>();
  let loaded: Promise<void> | undefined;
  const load = (): Promise<void> => {
    loaded ??= Effect.runPromise(readEvals(converse)).then(
      (state) => void state.replays.forEach((id) => known.add(id)),
      (cause: unknown) => {
        // Read again on the next call; replays started in this process are
        // already in memory, so only a resumed one waits for the retry.
        loaded = undefined;
        console.error("eval replay list read failed:", cause);
      },
    );
    return loaded;
  };
  return {
    add: async (conversationId) => {
      known.add(conversationId);
      await Effect.runPromise(
        changeEvals(converse, (state) => ({
          replays: [...state.replays.filter((id) => id !== conversationId), conversationId],
        })),
      );
    },
    isReplay: async (conversationId) => {
      if (known.has(conversationId)) return true;
      await load();
      return known.has(conversationId);
    },
  };
};

/** The hook that blocks every tool call of a replay conversation. */
export const replayGuardExtension = (guard: ReplayGuard) =>
  defineExtension({
    name: "ultius.mind.eval-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (_call, api) =>
          (await guard.isReplay(String(api.conversationId))) ? { block: REPLAY_BLOCK } : undefined,
      }),
    ],
  });
