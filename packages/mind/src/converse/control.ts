/**
 * Run control of a conversation: Stop (`interrupt`), withdrawing one queued
 * message, reading the live run state, and aborting only the running turn
 * (`abortRun`, Redirect now) — which, unlike Stop, leaves queued messages in
 * the inbox. Also the tasks the engine parked after too many restarts in a
 * row (`parked`) and running one again (`retryParked`).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import type { Harness, LiveState, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { External } from "@spreissen/core";
import { asEffect } from "./as-effect.ts";
import type { ConverseService } from "./converse.ts";

/**
 * A pi-durable task parked by the restart limit: it was cut off (a crash or
 * restart mid-run) `settings.restartLimit` times in a row without progress,
 * so the engine stopped running it until someone retries it.
 */
export type ParkedTask = {
  readonly taskId: string;
  /** The registered task name (`pi.generation` for a chat turn). */
  readonly kind: string;
  readonly conversationId: string;
};

const parkedOf = async (harness: Harness): Promise<readonly ParkedTask[]> => {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return inspection.tasks.flatMap(({ record, state }) =>
    state.kind === "blocked" && state.reason === "restart_limit"
      ? [
          {
            taskId: String(record.id),
            kind: record.kind,
            conversationId: String(record.conversationId),
          },
        ]
      : [],
  );
};

export const controlOps = (
  harness: Harness,
): Pick<
  ConverseService,
  "interrupt" | "withdraw" | "liveOf" | "abortRun" | "parked" | "retryParked"
> => ({
  parked: () => asEffect("parked tasks", parkedOf(harness)),
  retryParked: (taskId) =>
    asEffect(
      "parked retry",
      (async () => {
        // Only a task that is parked right now: retryTask on anything else is a no-op or a throw.
        const found = (await parkedOf(harness)).find((task) => task.taskId === taskId);
        if (found === undefined) return "not_parked" as const;
        const numeric = Number(taskId);
        const id = (Number.isSafeInteger(numeric) ? numeric : taskId) as unknown as TaskId;
        await harness.retryTask(id, BACKGROUND_CONTEXT);
        return "retried" as const;
      })(),
    ),
  interrupt: (conversation) =>
    Effect.tryPromise({
      try: () => conversation.abort(BACKGROUND_CONTEXT),
      catch: (cause) => new External({ op: "conversation abort", cause }),
    }),
  withdraw: (conversation, submissionId) => {
    // Submission ids are numbers on the wire as strings (as the inbox mirror sends them).
    const numeric = Number(submissionId);
    const id = (Number.isSafeInteger(numeric) ? numeric : submissionId) as unknown as SubmissionId;
    return asEffect(
      "submission withdraw",
      harness.abortSubmission(id, BACKGROUND_CONTEXT, conversation.id),
    );
  },
  liveOf: (conversation) =>
    asEffect(
      "live read",
      conversation.viewState(BACKGROUND_CONTEXT).then((view) => {
        const live = view.value?.docs["pi.live"] as LiveState | undefined;
        view.dispose();
        return live;
      }),
    ),
  abortRun: (conversation) =>
    asEffect(
      "run abort",
      (async () => {
        const view = await conversation.viewState(BACKGROUND_CONTEXT);
        const run = (view.value?.docs["pi.live"] as LiveState | undefined)?.run;
        view.dispose();
        if (run === undefined) return "idle" as const;
        // The run task aborts bottom-up: running tools get their abort signal
        // and an `aborted` result, the streamed partial is kept as an aborted
        // assistant message, and the run's inputs settle unanswered. The inbox
        // is NOT withdrawn (that is Stop's job).
        await harness.abortTask(run.taskId, BACKGROUND_CONTEXT);
        await conversation.waitForIdle(BACKGROUND_CONTEXT);
        return "aborted" as const;
      })(),
    ),
});
