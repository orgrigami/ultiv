/**
 * Delivery: the one path outside input rides into a session — webhook calls,
 * cron fires, sensor ticks, mailbox envelopes. It resolves the session's
 * registry row (and with it the owner and profile scope), admits the text
 * into the session's durable conversation, and settles it in the background
 * exactly like a typed input. Admission is the contract: once the submission
 * is durable, the caller succeeded — the TURN may still fail (no provider,
 * bad tool), and that is the session transcript's problem, not the sender's.
 *
 * `whenBusy` is the priority class: ROUTINE wakes steer a turn in flight at
 * the next boundary; low-priority sources (sensors) queue as follow-ups.
 */
import { Effect } from "effect";
import type { MindService } from "@spriessen/mind";
import { isNothingToReport } from "@spriessen/contracts";

export type WhenBusy = "steer" | "followUp" | "reject";

/** The routine that delivered the text; its reply earns a push. */
export type DeliverySource = "webhook" | "cron" | "sensor";

type ReplyListener = (sessionId: string, source: DeliverySource) => void;
const replyListeners = new Set<ReplyListener>();

/**
 * Hear a routine-delivered turn settle with a reply worth the owner's
 * attention: not empty and not the quiet "[nothing to report]" marker.
 * Returns the unsubscribe.
 */
export const onRoutineReply = (fn: ReplyListener): (() => void) => {
  replyListeners.add(fn);
  return () => void replyListeners.delete(fn);
};

/** A session's durable conversation, and the owner its registry row names. */
const conversationOfSession = async (mind: MindService, sessionId: string) => {
  const row = await mind.profiles.rowOf(sessionId);
  const owner = row?.owner;
  const key =
    row !== undefined
      ? await mind.profiles.keyOfRow(row)
      : owner !== undefined
        ? await mind.profiles.keyForSession(owner, sessionId)
        : sessionId; // pre-registry ids: the raw key, exactly as before
  return { owner, conversation: await Effect.runPromise(mind.converse.ensure(key)) };
};

/**
 * Context for a session that must not start a turn: a note the bot reads
 * with its next turn (a webhook payload from a sender who may not ask for
 * work, on a thread that already has a chat). No turn, no push.
 */
export const noteToSession = async (
  mind: MindService,
  sessionId: string,
  kind: string,
  text: string,
): Promise<void> => {
  const { conversation } = await conversationOfSession(mind, sessionId);
  await Effect.runPromise(mind.converse.note(conversation, kind, {}, text));
};

export const deliverToSession = async (
  mind: MindService,
  sessionId: string,
  text: string,
  whenBusy: WhenBusy = "followUp",
  source?: DeliverySource,
): Promise<void> => {
  const { owner, conversation } = await conversationOfSession(mind, sessionId);
  const submission = await Effect.runPromise(mind.converse.submit(conversation, text, whenBusy));
  await mind.profiles.touchSession(owner ?? "guest", sessionId, {
    at: Date.now(),
    titleSeed: text,
  });
  void Effect.runPromise(mind.converse.settle(conversation, submission))
    .then((settled) => {
      if (source === undefined || settled.text.trim() === "") return;
      if (isNothingToReport(settled.text)) return;
      for (const fn of replyListeners) fn(sessionId, source);
    })
    .catch((cause) => {
      console.error("delivered turn failed:", cause);
    });
};
