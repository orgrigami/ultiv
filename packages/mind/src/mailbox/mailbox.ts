/**
 * The inter-entity mailbox: asynchronous, durable messaging where the ROOM is
 * a pure TUNNEL. An exchange runs between two endpoint conversations — the
 * sender's origin thread (their main chat, or the session they were working
 * in when they sent) and the counterpart's MAIN thread. All thinking happens
 * at the endpoints; the tunnel carries only the exchanged envelopes, and its
 * transcript is the mailbox entries (readable end-to-end with the `room`
 * tool). Wakes carry a FINISH SIGNAL plus a pointer, never a transcript copy.
 *
 * The parts: store.ts (the durable doc), policy.ts (loop and cost safety),
 * delivery.ts (idempotent delivery, retries, deadlines, NACKs), wakes.ts
 * (coalesced sender wakes), recovery.ts (boot redelivery), text.ts (every
 * text a conversation sees).
 */
import { randomUUID } from "node:crypto";
import type { MailboxEntry, MailboxEnvelope, MailboxList, RoomInfo } from "@spriessen/contracts";
import { InvalidInput, scrubSecrets } from "@spriessen/core";
import {
  armDeadline,
  cancelEntry,
  cancelSentFrom,
  deliver,
  endpointFor,
  makeEngine,
  type Engine,
  type MailboxDeps,
} from "./delivery.ts";
import {
  currentRoomOf,
  roomLastActivityAt,
  rolloverTopic,
  staleAt,
  validateSend,
} from "./policy.ts";
import { checkOnTopic } from "./topic.ts";
import { ownerRoomWakeText } from "./text.ts";
import type { MailboxOrigin } from "./policy.ts";
import { recover, type RecoveryReport } from "./recovery.ts";
import { normalizeTopic } from "../profiles/rooms.ts";
import { isExternal, onEntriesChanged, readEntries, run, writeEntries } from "./store.ts";

export {
  EXTERNAL_RATE_PER_HOUR,
  HOP_CAP,
  MAX_RETRIES,
  PAIR_RATE_PER_HOUR,
  ROOM_STALE_MS,
  shouldSignalReply,
  staleAt,
  type MailboxOrigin,
} from "./policy.ts";
export { MailboxDoc } from "./store.ts";
export { DEADLINE_MS, type MailboxDeps } from "./delivery.ts";
export type { RecoveryReport } from "./recovery.ts";

export interface MailboxSendInput {
  readonly owner: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "request" | "notify";
  readonly body: string;
  readonly artifacts?: readonly string[];
  readonly origin: MailboxOrigin;
  /** The room's context — a pair may hold many concurrent threads. */
  readonly topic?: string;
  /**
   * The conversation this send is made FROM (the tunnel's near endpoint).
   * Replies and NACKs are signalled back here; omit for the main thread.
   */
  readonly originConversation?: string | null;
}

/** The speaker name for a bot that no longer exists (room view + room tool). */
export const REMOVED_BOT = "Removed bot";

/** The owner's seat id in a room transcript (never a profile id). */
export const OWNER_ID = "owner";
/** How the owner's seat reads in the room view. */
export const OWNER_NAME = "You";

/**
 * An admitted entry, plus the rollover marker: when the send landed in a
 * FRESH room because the targeted one was stale, `rolloverRoomId` names it
 * so the send result can point both bots and the owner at the new room.
 */
export type MailboxSendResult = MailboxEntry & {
  readonly rolloverRoomId?: string;
};

export interface TranscriptLine {
  readonly at: number;
  readonly speaker: string;
  /** The sender's profile id (or `external:<name>`): names can collide. */
  readonly speakerId: string;
  readonly text: string;
  readonly system: boolean;
  readonly id: string;
  readonly status: MailboxEntry["status"];
  readonly error: string | null;
}

export interface MailboxService {
  /** Send (admit) a message; validations refuse before anything is admitted. */
  readonly send: (input: MailboxSendInput) => Promise<MailboxSendResult>;
  /** An inbound envelope from an external sender: strictly fewer rights. */
  readonly deliverExternal: (
    input: Omit<MailboxSendInput, "origin" | "owner"> & {
      readonly owner: string;
      readonly chain: readonly string[];
    },
  ) => Promise<MailboxEntry>;
  /** Entries visible to an owner (their bots' traffic), newest last. */
  readonly list: (owner: string) => Promise<MailboxList>;
  /** Dead-lettered entries — the attention path reads this. */
  readonly dead: (owner: string) => Promise<MailboxList>;
  /**
   * The tunnel transcript for a room: every exchanged envelope,
   * speaker-labelled, oldest first, with its delivery status.
   */
  readonly transcriptOf: (owner: string, room: RoomInfo) => Promise<readonly TranscriptLine[]>;
  /** The conversation a profile tunnels at in a room (their latest send origin, else main). */
  readonly endpointOf: (owner: string, room: RoomInfo, profileId: string) => Promise<string>;
  /** Hear any committed mailbox change (send, delivery, status). Returns the unsubscribe. */
  readonly listen: (fn: () => void) => () => void;
  /** Hear a message expire unanswered. Returns the unsubscribe. */
  readonly onExpired: (fn: (entry: MailboxEntry) => void) => () => void;
  /** Remove every entry touching a profile (purge cascade). */
  readonly purgeProfile: (owner: string, profileId: string) => Promise<number>;
  /** Cancel a pending message; the sender is told. A finished one is returned unchanged. */
  readonly cancel: (owner: string, id: string) => Promise<MailboxEntry>;
  /**
   * The owner speaks into a room: the line lands in the room's transcript
   * (from "owner") and wakes ONLY the addressed bot, in its endpoint
   * conversation for the room, framed so the memory guard reads the OWNER's
   * voice. No delivery engine, no NACK: the owner is present.
   */
  readonly ownerSay: (input: {
    readonly owner: string;
    readonly room: RoomInfo;
    /** The addressed bot (a participant): the only one woken. */
    readonly to: string;
    readonly text: string;
  }) => Promise<MailboxEntry>;
  /**
   * Stop propagation: cancel every pending message SENT from these
   * conversations (a stopped work tree), without waking the sender. Returns
   * how many were settled.
   */
  readonly cancelSentFrom: (conversations: readonly string[]) => Promise<number>;
  /** Boot: redeliver pending messages, fire or re-arm deadlines, re-send owed wakes. */
  readonly recover: () => Promise<RecoveryReport>;
}

const admit = async (
  e: Engine,
  owner: string,
  envelope: MailboxEnvelope,
  origin: MailboxOrigin,
  originConversation: string | null,
): Promise<MailboxEntry> => {
  const entry: MailboxEntry = {
    envelope,
    status: "pending",
    retries: 0,
    deliveredAt: null,
    settledAt: null,
    error: null,
    owner,
    origin,
    originConversation,
    deadlineAt: envelope.at + e.deadlineMs,
  };
  await writeEntries(e.deps.converse, (items) => [...items, entry]);
  e.deps.audit.record({
    at: Date.now(),
    kind: "mailbox",
    conversationId: "mailbox",
    profile: envelope.from,
    callId: envelope.id,
    name: "send",
    durationMs: null,
    ok: true,
    error: null,
  });
  armDeadline(e, entry);
  void deliver(e, entry).catch((cause) => {
    console.error("mailbox delivery failed:", cause);
  });
  return entry;
};

const envelopeOf = (
  input: Pick<MailboxSendInput, "to" | "kind" | "body">,
  from: string,
  chain: readonly string[],
  topic: string,
  artifacts: readonly string[],
): MailboxEnvelope => ({
  id: randomUUID(),
  chain: [...chain],
  from,
  to: input.to,
  kind: input.kind,
  replyTo: null,
  ...(topic !== "" ? { topic } : {}),
  body: input.body.slice(0, 20_000),
  artifacts: [...artifacts],
  at: Date.now(),
});

const sendOps = (e: Engine): Pick<MailboxService, "send" | "deliverExternal"> => ({
  send: async (input) => {
    const topic = normalizeTopic(input.topic ?? "");
    const originConversation = input.originConversation ?? null;
    await validateSend(e.deps.converse, e.deps.profiles, {
      owner: input.owner,
      from: input.from,
      to: input.to,
      chain: [input.from],
      artifacts: input.artifacts ?? [],
      origin: input.origin,
    });
    // Stale-room rollover: a send into the pair's current room whose last
    // envelope is older than ROOM_STALE_MS opens a FRESH room (same
    // participants, new id, topic stamped with the resume date) and delivers
    // there. Pre-creating the room here routes delivery deterministically
    // and lets the send result name the new room. A fresh room is on topic
    // by construction; the old room stays readable.
    const participants = [input.from, input.to];
    const entries = await readEntries(e.deps.converse);
    // The talk continues in the most recently active room of this topic's
    // lineage (after a rollover, bots keep using the base topic).
    const current = currentRoomOf(
      await e.deps.rooms.list(input.owner, input.from),
      [input.from, input.to],
      topic,
      entries,
    );
    let admittedTopic = current?.topic ?? topic;
    let rolloverRoomId: string | undefined;
    if (current !== undefined && staleAt(roomLastActivityAt(current, entries), Date.now())) {
      admittedTopic = rolloverTopic(topic, Date.now());
      rolloverRoomId = (await e.deps.rooms.ensure(input.owner, participants, admittedTopic)).id;
    }
    const envelope = envelopeOf(
      input,
      input.from,
      [input.from],
      admittedTopic,
      input.artifacts ?? [],
    );
    if (current !== undefined && rolloverRoomId === undefined) {
      // On-topic gate (fail-open): an established room's topic is judged
      // before admitting; a fresh (rolled-over) room is on topic by
      // construction, and the first exchange in a room is never classified.
      try {
        await checkOnTopic(e.deps.judge, entries, current, input.body);
      } catch (cause) {
        // Only a refusal is audited — admits don't double the audit volume.
        const reason = (cause as { reason?: unknown }).reason ?? String(cause);
        e.deps.audit.record({
          at: Date.now(),
          kind: "mailbox",
          conversationId: "mailbox",
          profile: input.from,
          callId: envelope.id,
          name: "off-topic",
          durationMs: null,
          ok: false,
          error: String(reason).slice(0, 300),
        });
        throw cause;
      }
    }
    const entry = await admit(e, input.owner, envelope, input.origin, originConversation);
    return rolloverRoomId === undefined ? entry : { ...entry, rolloverRoomId };
  },
  deliverExternal: async (input) => {
    const sender = `external:${input.from.replace(/^external:/, "")}`;
    const chain = [...input.chain, sender];
    const topic = normalizeTopic(input.topic ?? "");
    await validateSend(e.deps.converse, e.deps.profiles, {
      owner: input.owner,
      from: sender,
      to: input.to,
      chain,
      artifacts: [],
      origin: "external",
    });
    return admit(e, input.owner, envelopeOf(input, sender, chain, topic, []), "external", null);
  },
});

const transcriptOf =
  (e: Engine) =>
  async (owner: string, room: RoomInfo): Promise<readonly TranscriptLine[]> => {
    const entries = await readEntries(e.deps.converse);
    const nameOf = async (id: string): Promise<string> => {
      if (id === OWNER_ID) return OWNER_NAME;
      if (isExternal(id)) return id.replace(/^external:/, "");
      return (await e.deps.profiles.get(owner, id))?.name ?? REMOVED_BOT;
    };
    const inRoom = entries
      .filter(
        (candidate) =>
          (candidate.owner ?? "") === owner &&
          candidate.envelope.topic === room.topic &&
          // The owner's own lines (ownerSay) share the room's transcript.
          (candidate.envelope.from === OWNER_ID ||
            room.participants.includes(candidate.envelope.from)) &&
          room.participants.includes(candidate.envelope.to),
      )
      .sort((a, b) => a.envelope.at - b.envelope.at);
    return Promise.all(
      inRoom.map(async (candidate) => ({
        at: candidate.envelope.at,
        speaker: await nameOf(candidate.envelope.from),
        speakerId: candidate.envelope.from,
        text: candidate.envelope.body,
        system: false,
        id: candidate.envelope.id,
        status: candidate.status,
        // Rows from before errors were owner-worded hold raw causes: scrub.
        error: candidate.error === null ? null : scrubSecrets(candidate.error),
      })),
    );
  };

export const mailboxService = (deps: MailboxDeps): MailboxService => {
  const e = makeEngine(deps);
  const { converse, profiles } = deps;
  const service: MailboxService = {
    ...sendOps(e),
    transcriptOf: transcriptOf(e),
    ownerSay: async ({ owner, room, to, text }) => {
      if (!room.participants.includes(to)) {
        throw new InvalidInput({ reason: "that bot is not in this bot talk" });
      }
      const body = text.trim().slice(0, 20_000);
      if (body === "") throw new InvalidInput({ reason: "the message is empty" });
      const envelope: MailboxEnvelope = {
        id: randomUUID(),
        chain: [],
        from: OWNER_ID,
        to,
        kind: "notify",
        replyTo: null,
        ...(room.topic !== "" ? { topic: room.topic } : {}),
        body,
        artifacts: [],
        at: Date.now(),
      };
      const entry: MailboxEntry = {
        envelope,
        // "replied" reads as settled (nothing owed): the wake happened, and
        // whether the bot answers is its own turn, not a delivery state.
        status: "replied",
        retries: 0,
        deliveredAt: Date.now(),
        settledAt: Date.now(),
        error: null,
        owner,
        origin: "human",
        originConversation: null,
        senderNotified: true,
      };
      await writeEntries(converse, (items) => [...items, entry]);
      e.deps.audit.record({
        at: Date.now(),
        kind: "mailbox",
        conversationId: "mailbox",
        profile: to,
        callId: envelope.id,
        name: "owner-say",
        durationMs: null,
        ok: true,
        error: null,
      });
      // Wake ONLY the addressed bot, at its endpoint for this room, framed
      // with the owner prefix the memory guard reads as the owner's voice.
      // The owner is present: no retries, no deadlines, no NACKs.
      const endpoint = await endpointFor(e, owner, room, to, await readEntries(converse)).catch(
        () => undefined,
      );
      const chat = endpoint === undefined ? undefined : await run(converse.open(endpoint));
      if (chat !== undefined) {
        const submission = await run(
          converse.submit(
            chat,
            ownerRoomWakeText(room.topic, body),
            "followUp",
            `room-owner:${envelope.id}`,
          ),
        );
        void run(converse.settle(chat, submission)).catch((cause: unknown) => {
          console.error("owner room wake failed:", cause);
        });
      }
      return entry;
    },
    endpointOf: (owner, room, profileId) =>
      readEntries(converse).then((entries) => endpointFor(e, owner, room, profileId, entries)),
    list: async (owner) => {
      const entries = await readEntries(converse);
      const owned = new Set((await profiles.list(owner)).map((profile) => profile.id));
      return entries.filter(
        (entry) => owned.has(entry.envelope.from) || owned.has(entry.envelope.to),
      );
    },
    dead: (owner) =>
      service.list(owner).then((entries) => entries.filter((entry) => entry.status === "dead")),
    purgeProfile: async (_owner, profileId) => {
      // Filter INSIDE the commit: writing back a snapshot read earlier would
      // wipe any message admitted in between.
      let removed = 0;
      await writeEntries(converse, (items) => {
        const remaining = items.filter(
          (entry) => entry.envelope.from !== profileId && entry.envelope.to !== profileId,
        );
        removed = items.length - remaining.length;
        return remaining;
      });
      return removed;
    },
    listen: (fn) => onEntriesChanged(converse, fn),
    onExpired: (fn) => {
      e.expiredListeners.add(fn);
      return () => void e.expiredListeners.delete(fn);
    },
    cancel: (owner, id) => cancelEntry(e, owner, id),
    cancelSentFrom: (conversations) => cancelSentFrom(e, conversations),
    recover: () => recover(e),
  };
  return service;
};
