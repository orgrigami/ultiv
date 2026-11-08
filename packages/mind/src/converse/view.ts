/**
 * Reading a conversation's view (entries, `pi.live`, `pi.inbox`, documents).
 * pi-durable 1.5 serves the view only through a watch, whose entries are a
 * window over the transcript (the newest 50 by default), so a one-shot read
 * opens a watch, takes its first value and stops it.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationView,
  ConversationWindow,
} from "@earendil-works/pi-durable";

/**
 * The window a transcript projection reads: the newest 500 entries, growing
 * to 1000 before the oldest leave. Enough for any chat or task the app shows
 * whole; a longer history keeps its newest part.
 */
export const TRANSCRIPT_WINDOW: ConversationWindow = { min: 500 };

/** The conversation's view right now; `window` bounds its entries (default: the newest 50). */
export const readView = async (
  conversation: Conversation,
  window?: ConversationWindow,
): Promise<ConversationView> => {
  const watch = await conversation.watch(BACKGROUND_CONTEXT, window);
  const value = watch.value;
  await watch.stop();
  return value;
};
