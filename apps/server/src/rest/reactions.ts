/**
 * Reaction reads: GET /api/sessions/:sessionId/reactions. The owner reads
 * the acks their bots stored through the react tool, joined to the chat
 * transcript by entryId. Writes go through the mind only: no POST route in
 * v1 (the owner's own react button is a later wave), and no delete or edit
 * (a bot re-reacts to replace its own row). Owner-scoped through the shared
 * seam: another owner's session reads exactly like a missing one.
 */
import { Effect } from "effect";
import { ReactionsDoc } from "@spriessen/mind";
import { ownsSession } from "./owner-scope.ts";
import type { RouteArgs } from "./types.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** The reactions routes; returns false when the path is not ours. */
export async function reactionRoutes(args: RouteArgs): Promise<boolean> {
  const { path, json } = args;
  const match = path.match(/^\/api\/sessions\/([^/]+)\/reactions$/);
  if (match === null || (args.req.method ?? "GET") !== "GET") return false;
  const sessionId = decodeURIComponent(match[1] ?? "");
  if (!(await ownsSession(args, sessionId))) {
    json(404, { error: "no such session" });
    return true;
  }
  const row = await args.mind.profiles.rowOf(sessionId);
  if (row === undefined) {
    json(404, { error: "no such session" });
    return true;
  }
  const key = await args.mind.profiles.keyOfRow(row);
  // The map carries the numeric conversation id: string it for the doc key.
  const conversation = await run(args.mind.converse.conversationIdOf(key));
  if (conversation === undefined) {
    // Registered but never opened: no conversation, no reactions yet.
    json(200, { reactions: [] });
    return true;
  }
  const store = await run(
    args.mind.converse.docs.snapshotKeyed(ReactionsDoc, String(conversation)),
  );
  json(200, { reactions: store?.rows ?? [] });
  return true;
}
