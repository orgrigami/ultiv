import { arr, num, obj, str, type Static } from "@earendil-works/pi-schema";

/**
 * Conversation search over REST (`GET /api/history/search`): the owner's
 * view of what their bots' chats said. Each bot's chats are indexed and
 * searched apart — a hit always names the bot whose chat it came from.
 */
export const HistoryHitSchema = obj(
  {
    sessionId: str(),
    sessionTitle: str(),
    /** The chat's kind: `main` (the bot's home chat) or `session`. */
    kind: str(),
    /** Who said it: `user` (the owner), `assistant` (the bot), `tool` (a tool result). */
    role: str(),
    /** The words around the match. */
    snippet: str(),
    /** When it was said (epoch ms; 0 when unknown). */
    at: num(),
  },
  { open: true },
);
export type HistoryHit = Static<typeof HistoryHitSchema>;

/** One bot's hits, best first. */
export const HistoryGroupSchema = obj(
  {
    profile: str(),
    hits: arr(HistoryHitSchema),
  },
  { open: true },
);
export type HistoryGroup = Static<typeof HistoryGroupSchema>;

/** The answer: groups of bots that matched, bots with the best first hit first. */
export const HistorySearchSchema = obj(
  {
    query: str(),
    groups: arr(HistoryGroupSchema),
  },
  { open: true },
);
export type HistorySearch = Static<typeof HistorySearchSchema>;
