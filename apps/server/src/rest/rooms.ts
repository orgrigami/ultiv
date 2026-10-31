/**
 * Room routes: the bot-to-bot surface. Rooms are REST-only (never sessions,
 * never chord objects) — a room is a TUNNEL, and its transcript is the
 * mailbox envelopes. The detail view is one merged, speaker-labelled chat;
 * the supervision "say" injects into the bot's endpoint conversation.
 */
import { Effect } from "effect";
import type { MailboxEntry, RoomInfo } from "@spreissen/contracts";
import { errorOf, queryOr, type RouteArgs } from "./types.ts";

/** One merged, speaker-labelled line of the room chat. */
export interface RoomLine {
  readonly at: number;
  readonly speaker: string;
  readonly text: string;
  readonly system: boolean;
  /** Mailbox lines only: the envelope id and its delivery status. */
  readonly id?: string;
  readonly status?: MailboxEntry["status"];
  readonly error?: string | null;
}

export interface RoomDetail {
  readonly room: RoomInfo;
  readonly participants: { readonly profileId: string; readonly name: string }[];
  readonly timeline: RoomLine[];
}

async function roomDetail(args: RouteArgs, room: RoomInfo): Promise<RoomDetail> {
  const participants = await Promise.all(
    room.participants
      .filter((profileId) => !profileId.startsWith("external:"))
      .map(async (profileId) => ({
        profileId,
        name: (await args.mind.profiles.get(args.owner, profileId))?.name ?? profileId.slice(0, 8),
      })),
  );
  const timeline = await args.mind.mailbox.transcriptOf(args.owner, room);
  return { room, participants, timeline: [...timeline] };
}

export async function roomRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/rooms" && method === "GET") {
    const bot = queryOr(args, "bot");
    json(200, await mind.rooms.list(args.owner, bot));
    return true;
  }
  if (path === "/api/main" && method === "GET") {
    const main = await mind.profiles.mainOf(args.owner);
    json(200, { profileId: main });
    return true;
  }
  const match = path.match(/^\/api\/rooms\/([^/]+)(\/say)?$/);
  if (match === null) return false;
  const room = await mind.rooms.get(args.owner, match[1] ?? "");
  if (room === undefined) {
    json(404, { error: "unknown room" });
    return true;
  }
  if (match[2] === undefined && method === "GET") {
    json(200, await roomDetail(args, room));
    return true;
  }
  if (match[2] === "/say" && method === "POST") {
    const body = await args.readJson<{ to?: string; text?: string }>(req);
    if (body.to === undefined || body.text === undefined || body.text.trim() === "") {
      json(400, { error: "to and text are required" });
      return true;
    }
    if (!room.participants.includes(body.to)) {
      json(400, { error: "that bot is not in this room" });
      return true;
    }
    try {
      // The say lands in the bot's endpoint conversation for this room —
      // the thread the exchange actually runs through.
      const endpointId = await mind.mailbox.endpointOf(args.owner, room, body.to);
      const chat = await Effect.runPromise(mind.converse.open(endpointId));
      if (chat === undefined) {
        json(404, { error: "endpoint conversation missing" });
        return true;
      }
      const submission = await Effect.runPromise(
        mind.converse.submit(chat, `[owner] ${body.text}`),
      );
      void Effect.runPromise(mind.converse.settle(chat, submission)).catch(() => undefined);
      await mind.rooms.touch(args.owner, room.id);
      json(200, { ok: true });
    } catch (cause) {
      json(500, { error: errorOf(cause) });
    }
    return true;
  }
  return false;
}
