/**
 * Mailbox routes: read-only. Bot talks are bot-to-bot only, and humans
 * READ them: no route sends into a room ("send as this bot", supervision
 * lines) or changes a message's course (cancel). Deadlines, topical rooms
 * and the rate limits bound a stuck or runaway talk.
 */
import type { RouteArgs } from "./types.ts";

export async function mailboxRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/mailbox" && method === "GET") {
    json(200, (await mind.mailbox.list(args.owner)).slice(-100).reverse());
    return true;
  }
  if (path === "/api/mailbox/dead" && method === "GET") {
    json(200, await mind.mailbox.dead(args.owner));
    return true;
  }
  return false;
}
