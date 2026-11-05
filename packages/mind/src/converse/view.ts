/**
 * Reading a conversation's structural view (entries + `pi.live`, `pi.inbox`,
 * … docs). pi-durable 1.5 dropped `viewState()`: a view is a watch now, and
 * its `entries` are a WINDOW over the fork-aware history (head markers such
 * as compaction summaries sit where they were written), the newest 50 by
 * default. Every surface here projected the whole transcript, so the default
 * window below holds all of it, as `viewState()` did; a reader that needs only
 * the docs or the last few steps passes a small one.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationView,
  ConversationWindow,
} from "@earendil-works/pi-durable";

/** Large enough for any one chat: the view holds the whole transcript, as before 1.5. */
export const FULL_WINDOW: ConversationWindow = { min: 1_000_000, max: 1_000_000 };

/** The docs and the newest few entries: for reads of `pi.live`, `pi.inbox` and recent steps. */
export const RECENT_WINDOW: ConversationWindow = { min: 50 };

/** One read of the view, then the watch is let go. */
export const readView = async (
  conversation: Conversation,
  window: ConversationWindow = FULL_WINDOW,
): Promise<ConversationView> => {
  const watch = await conversation.watch(BACKGROUND_CONTEXT, window);
  const value = watch.value;
  await watch.stop();
  return value;
};

/** A followed view: its first value now, every later revision to `onValue`; `stop` lets go. */
export type FollowedView = {
  readonly value: ConversationView;
  readonly stop: () => void;
};

export const followView = async (
  conversation: Conversation,
  onValue: (value: ConversationView) => void,
  window: ConversationWindow = FULL_WINDOW,
): Promise<FollowedView> => {
  const watch = await conversation.watch(BACKGROUND_CONTEXT, window);
  watch.start(async (call) => {
    if (call.kind === "value") onValue(call.value);
  });
  return {
    value: watch.value,
    stop: () => {
      void watch.stop();
    },
  };
};
