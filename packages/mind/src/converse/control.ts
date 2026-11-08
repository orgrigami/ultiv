/**
 * Run control of a conversation: Stop (`interrupt`), withdrawing one queued
 * message, reading the live run state, and aborting only the running turn
 * (`abortRun`, Redirect now) — which, unlike Stop, leaves queued messages in
 * the inbox. Also the turns that restarts cut off too many times in a row
 * (`parked`) and running one again (`retryParked`).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import type {
  Conversation,
  Harness,
  InboxState,
  LiveState,
  Report,
  SubmissionId,
} from "@earendil-works/pi-durable";
import { External } from "@spriessen/core";
import { asEffect } from "./as-effect.ts";
import type { ConverseService } from "./converse.ts";
import { conversationIdFrom } from "./ids.ts";
import { readView } from "./view.ts";

/**
 * A chat turn that restarts cut off: the host stopped mid-answer
 * `settings.restartLimit` times in a row (or kept stopping while the model
 * answered), so the engine ended the run (`pi.live.runFailure`) instead of
 * running it again. The owner runs it again from Needs you.
 */
export type ParkedTask = {
  readonly taskId: string;
  /** The registered task name (`pi.generation` for a chat turn). */
  readonly kind: string;
  readonly conversationId: string;
};

/**
 * The turns the engine reported interrupted since this process started
 * (`task_interrupted` on a generation). Feed `onReport` to `Harness.open`.
 */
export type InterruptedRuns = {
  readonly onReport: (report: Report) => void;
  readonly list: () => readonly ParkedTask[];
  readonly forget: (taskId: string) => void;
};

export const interruptedRuns = (): InterruptedRuns => {
  const runs = new Map<string, ParkedTask>();
  return {
    onReport: (report) => {
      if (report.kind !== "task_interrupted" || report.task.kind !== "pi.generation") return;
      const taskId = String(report.task.id);
      runs.set(taskId, {
        taskId,
        kind: report.task.kind,
        conversationId: String(report.task.conversationId),
      });
    },
    list: () => [...runs.values()],
    forget: (taskId) => void runs.delete(taskId),
  };
};

/**
 * The entry `retryQueued` writes. It carries no model content (an empty
 * `model`), so the model sees nothing new; being a queued write is what makes
 * the engine place the inbox at the next boundary.
 */
export const QUEUE_RETRY_KIND = "ultiv.queue-retry";

const retryQueuedOf = async (conversation: Conversation): Promise<"started" | "busy" | "empty"> => {
  const { docs } = await readView(conversation);
  if ((docs["pi.live"] as LiveState | undefined)?.run !== undefined) return "busy";
  const items = (docs["pi.inbox"] as InboxState | undefined)?.items ?? [];
  if (!items.some((item) => item.mode !== "write")) return "empty";
  await conversation.submit(
    { type: "write", entry: { kind: QUEUE_RETRY_KIND, data: { at: Date.now() }, model: [] } },
    BACKGROUND_CONTEXT,
  );
  return "started";
};

/** The live doc of a conversation right now. */
const liveDocOf = async (conversation: Conversation): Promise<LiveState | undefined> =>
  (await readView(conversation)).docs["pi.live"] as LiveState | undefined;

/**
 * The reported turns whose run failure still stands: a later run (a new
 * message, a retry) replaces `runFailure`, and the turn leaves the list.
 */
const parkedOf = async (
  harness: Harness,
  interrupted: InterruptedRuns | undefined,
): Promise<readonly ParkedTask[]> => {
  const standing: ParkedTask[] = [];
  for (const task of interrupted?.list() ?? []) {
    const conversation = await harness
      .conversation(conversationIdFrom(task.conversationId), BACKGROUND_CONTEXT)
      .catch(() => undefined);
    const live = conversation === undefined ? undefined : await liveDocOf(conversation);
    if (live?.run === undefined && String(live?.runFailure?.taskId) === task.taskId) {
      standing.push(task);
    } else {
      interrupted?.forget(task.taskId);
    }
  }
  return standing;
};

export const controlOps = (
  harness: Harness,
  interrupted?: InterruptedRuns,
): Pick<
  ConverseService,
  | "interrupt"
  | "withdraw"
  | "liveOf"
  | "abortRun"
  | "parked"
  | "retryParked"
  | "retryQueued"
  | "resume"
> => ({
  parked: () => asEffect("parked tasks", parkedOf(harness, interrupted)),
  resume: () => {
    try {
      harness.resume();
    } catch (cause) {
      // Only after close (shutdown racing boot): nothing left to run.
      console.error("harness resume failed:", cause);
    }
  },
  retryQueued: (conversation) => asEffect("queue retry", retryQueuedOf(conversation)),
  retryParked: (taskId) =>
    asEffect(
      "parked retry",
      (async () => {
        // Only a turn whose failure still stands: a continue on a busy chat throws.
        const found = (await parkedOf(harness, interrupted)).find((task) => task.taskId === taskId);
        if (found === undefined) return "not_parked" as const;
        const conversation = await harness.conversation(
          conversationIdFrom(found.conversationId),
          BACKGROUND_CONTEXT,
        );
        if (conversation === undefined) return "not_parked" as const;
        // A continue runs on the context as it is, without a new message.
        await conversation.submit({ type: "continue" }, BACKGROUND_CONTEXT);
        interrupted?.forget(taskId);
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
  liveOf: (conversation) => asEffect("live read", liveDocOf(conversation)),
  abortRun: (conversation) =>
    asEffect(
      "run abort",
      (async () => {
        const run = (await liveDocOf(conversation))?.run;
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
