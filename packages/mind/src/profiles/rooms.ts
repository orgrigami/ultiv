/**
 * Rooms: the tunnel registry for bot-to-bot exchanges. A pair may have many
 * rooms ("Q3 report", "onboarding", …) — each is routing context (participants
 * + topic), NOT a place where anyone thinks. Messages flow through the room
 * between two endpoint conversations: the sender's origin thread and the
 * counterpart's main thread. The canonical transcript is the mailbox entries;
 * rooms are not sessions and never appear in session lists.
 */
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { RoomInfo, RoomList } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";

export const RoomsDoc = defineDoc<{ items: RoomInfo[] }>({
  kind: "ultiv.rooms",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** A room's topic key: trimmed, capped. Envelopes use the SAME key (the
 *  mailbox normalizes on send and on read), or a long topic would orphan its
 *  room's transcript. */
export const normalizeTopic = (topic: string): string => topic.trim().slice(0, 200);

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

const readRooms = (converse: ConverseService): Promise<RoomList> =>
  run(converse.docs.snapshot(RoomsDoc)).then((doc) => doc?.items ?? []);

const writeRooms = (
  converse: ConverseService,
  change: (items: RoomList) => RoomList,
): Promise<void> =>
  run(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(RoomsDoc);
      draft.items = change(draft.items);
    }),
  );

export interface RoomsService {
  /** Find or create the room for a participant set and topic (contextual DMs). */
  readonly ensure: (
    owner: string,
    participants: readonly string[],
    topic: string,
  ) => Promise<RoomInfo>;
  readonly get: (owner: string, id: string) => Promise<RoomInfo | undefined>;
  readonly list: (owner: string, profileId?: string) => Promise<RoomList>;
  readonly touch: (owner: string, roomId: string) => Promise<void>;
  /** Remove every room the profile participates in (purge cascade). */
  readonly purgeProfile: (owner: string, profileId: string) => Promise<number>;
}

export const roomsService = (deps: { readonly converse: ConverseService }): RoomsService => {
  const { converse } = deps;
  return {
    ensure: async (owner, participants, topic) => {
      const normalized = normalizeTopic(topic);
      const matches = (room: RoomInfo): boolean =>
        room.owner === owner &&
        room.topic === normalized &&
        sameSet(room.participants, participants);
      const existing = (await readRooms(converse)).find(matches);
      if (existing !== undefined) return existing;
      // Find-or-insert in ONE commit: two deliveries racing for a new pair
      // would otherwise each create the room. A plain copy leaves the
      // transaction (draft values die with it).
      return run(
        converse.docs.commit(async (tx) => {
          const draft = await tx.doc(RoomsDoc);
          const found = draft.items.find(matches);
          if (found !== undefined) return JSON.parse(JSON.stringify(found)) as RoomInfo;
          const room: RoomInfo = {
            id: randomUUID(),
            owner,
            topic: normalized,
            participants: [...participants],
            createdAt: Date.now(),
            lastMessageAt: Date.now(),
          };
          draft.items = [...draft.items, room];
          return room;
        }),
      );
    },
    get: (owner, id) =>
      readRooms(converse).then((rooms) =>
        rooms.find((room) => room.owner === owner && room.id === id),
      ),
    list: (owner, profileId) =>
      readRooms(converse).then((rooms) =>
        rooms
          .filter((room) => room.owner === owner)
          .filter((room) => profileId === undefined || room.participants.includes(profileId))
          .sort((a, b) => b.lastMessageAt - a.lastMessageAt),
      ),
    touch: (owner, roomId) =>
      writeRooms(converse, (items) =>
        items.map((room) =>
          room.owner === owner && room.id === roomId
            ? { ...room, lastMessageAt: Date.now() }
            : room,
        ),
      ),
    purgeProfile: async (owner, profileId) => {
      // Only THIS owner's rooms with the profile go; every other room —
      // other owners' included — stays. Filtered inside the commit.
      let removed = 0;
      await writeRooms(converse, (items) => {
        const remaining = items.filter(
          (room) => room.owner !== owner || !room.participants.includes(profileId),
        );
        removed = items.length - remaining.length;
        return remaining;
      });
      return removed;
    },
  };
};
