/**
 * Run control of a conversation: Stop (`interrupt`), withdrawing one queued
 * message, reading the live run state, aborting only the running turn
 * (`abortRun`, Redirect now) — which, unlike Stop, leaves queued messages in
 * the inbox — and Retry for messages a failed run left queued (`retryQueued`).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import {
  ConversationBusy,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type ConversationDocToken,
  type Harness,
  type JsonObject,
  type LiveState,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { External } from "@spriessen/core";
import { asEffect } from "./as-effect.ts";
import type { ConverseService } from "./converse.ts";

/**
 * One conversation document, read once (a single-document watch, let go at
 * once): cheap enough for the deadline watcher's once-a-second poll.
 */
const docOf = async <T extends JsonObject>(
  harness: Harness,
  token: ConversationDocToken<T>,
  conversation: Conversation,
): Promise<Readonly<T> | undefined> => {
  const watch = await harness.watchDoc(token, conversation.id, BACKGROUND_CONTEXT);
  if (watch === undefined) return undefined;
  const value = watch.value;
  await watch.stop();
  return value;
};

const liveDocOf = (harness: Harness, conversation: Conversation) =>
  docOf(harness, LiveDoc, conversation) as Promise<LiveState | undefined>;

/**
 * Retry (D3): a `continue` submission places the kept inbox in a new run on
 * the context as it is; the model sees nothing extra and the transcript
 * shows nothing. pi-durable admits it only while the conversation is idle.
 */
const retryQueuedOf = async (
  harness: Harness,
  conversation: Conversation,
): Promise<"started" | "busy" | "empty"> => {
  if ((await liveDocOf(harness, conversation))?.run !== undefined) return "busy";
  const items = (await docOf(harness, InboxDoc, conversation))?.items ?? [];
  if (!items.some((item) => item.mode !== "write")) return "empty";
  try {
    await conversation.submit({ type: "continue" }, BACKGROUND_CONTEXT);
  } catch (cause) {
    // A run started between the read and the submit.
    if (cause instanceof ConversationBusy) return "busy";
    throw cause;
  }
  return "started";
};

export const controlOps = (
  harness: Harness,
): Pick<
  ConverseService,
  "interrupt" | "withdraw" | "liveOf" | "abortRun" | "retryQueued" | "resume"
> => ({
  resume: () => {
    try {
      harness.resume();
    } catch (cause) {
      // Only after close (shutdown racing boot): nothing left to run.
      console.error("harness resume failed:", cause);
    }
  },
  retryQueued: (conversation) => asEffect("queue retry", retryQueuedOf(harness, conversation)),
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
  liveOf: (conversation) => asEffect("live read", liveDocOf(harness, conversation)),
  abortRun: (conversation) =>
    asEffect(
      "run abort",
      (async () => {
        const run = (await liveDocOf(harness, conversation))?.run;
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
