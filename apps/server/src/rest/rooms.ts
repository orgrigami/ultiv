/**
 * Room routes: the bot-to-bot surface. Rooms are REST-only (never sessions,
 * never chord objects) — a room is a TUNNEL, and its transcript is the
 * mailbox envelopes. The detail view is one merged, speaker-labelled chat.
 * Rooms are bot-to-bot only and READ-ONLY to humans: no route here writes
 * into a room or into a bot's endpoint for it.
 */
import type { MailboxEntry, RoomInfo } from "@spriessen/contracts";
import { REMOVED_BOT } from "@spriessen/mind";
import { queryOr, type RouteArgs } from "./types.ts";

/** One merged, speaker-labelled line of the room chat. */
export interface RoomLine {
  readonly at: number;
  readonly speaker: string;
  /** Mailbox lines only: the sender's profile id — seat and avatar by it. */
  readonly speakerId?: string;
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
        // Same fallback as the transcript's speaker names, so the two agree.
        name: (await args.mind.profiles.get(args.owner, profileId))?.name ?? REMOVED_BOT,
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
  // Resolve a chat-side mail note to its conversation: the transcript's
  // "[message from … • re: <envelope id>]" note names the envelope, the room
  // is the one whose topic + participants match the entry. Owner-scoped by
  // both lookups, so a foreign owner reads the same 404 as everyone else.
  const envelope = path.match(/^\/api\/rooms\/by-envelope\/([^/]+)$/);
  if (envelope !== null && method === "GET") {
    const entries = await mind.mailbox.list(args.owner);
    const id = decodeURIComponent(envelope[1] ?? "");
    const entry = entries.find((candidate) => candidate.envelope.id === id);
    if (entry === undefined) {
      json(404, { error: "That message no longer exists." });
      return true;
    }
    const rooms = await mind.rooms.list(args.owner);
    const room = rooms.find(
      (candidate) =>
        candidate.topic === entry.envelope.topic &&
        candidate.participants.includes(entry.envelope.from) &&
        candidate.participants.includes(entry.envelope.to),
    );
    if (room === undefined) {
      json(404, { error: "That bot talk no longer exists." });
      return true;
    }
    json(200, await roomDetail(args, room));
    return true;
  }
  const match = path.match(/^\/api\/rooms\/([^/]+)$/);
  if (match === null || method !== "GET") return false;
  const room = await mind.rooms.get(args.owner, decodeURIComponent(match[1] ?? ""));
  if (room === undefined) {
    json(404, { error: "That bot talk no longer exists." });
    return true;
  }
  json(200, await roomDetail(args, room));
  return true;
}
