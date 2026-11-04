import { Type, type Static } from "typebox";

/**
 * Conversation search over REST (`GET /api/history/search`): the owner's
 * view of what their bots' chats said. Each bot's chats are indexed and
 * searched apart — a hit always names the bot whose chat it came from.
 */
export const HistoryHitSchema = Type.Object({
  sessionId: Type.String(),
  sessionTitle: Type.String(),
  /** The chat's kind: `main` (the bot's home chat) or `session`. */
  kind: Type.String(),
  /** Who said it: `user` (the owner), `assistant` (the bot), `tool` (a tool result). */
  role: Type.String(),
  /** The words around the match. */
  snippet: Type.String(),
  /** When it was said (epoch ms; 0 when unknown). */
  at: Type.Number(),
});
export type HistoryHit = Static<typeof HistoryHitSchema>;

/** One bot's hits, best first. */
export const HistoryGroupSchema = Type.Object({
  profile: Type.String(),
  hits: Type.Array(HistoryHitSchema),
});
export type HistoryGroup = Static<typeof HistoryGroupSchema>;

/** The answer: groups of bots that matched, bots with the best first hit first. */
export const HistorySearchSchema = Type.Object({
  query: Type.String(),
  groups: Type.Array(HistoryGroupSchema),
});
export type HistorySearch = Static<typeof HistorySearchSchema>;
