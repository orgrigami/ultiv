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
import type { MailboxEntry, MailboxEnvelope, MailboxList, RoomInfo } from "@spreissen/contracts";
import {
  armDeadline,
  cancelEntry,
  deliver,
  endpointFor,
  makeEngine,
  type Engine,
  type MailboxDeps,
} from "./delivery.ts";
import { ROOM_EXCHANGE_CAP, exchangeUsed, lastBriefedAt, validateSend } from "./policy.ts";
import type { MailboxOrigin } from "./policy.ts";
import { recover, type RecoveryReport } from "./recovery.ts";
import { isExternal, readEntries, writeEntries } from "./store.ts";

export {
  EXTERNAL_RATE_PER_HOUR,
  HOP_CAP,
  MAX_RETRIES,
  PAIR_RATE_PER_HOUR,
  ROOM_EXCHANGE_CAP,
  shouldSignalReply,
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

export interface TranscriptLine {
  readonly at: number;
  readonly speaker: string;
  readonly text: string;
  readonly system: boolean;
  readonly id: string;
  readonly status: MailboxEntry["status"];
  readonly error: string | null;
}

export interface MailboxService {
  /** Send (admit) a message; validations refuse before anything is admitted. */
  readonly send: (input: MailboxSendInput) => Promise<MailboxEntry>;
  /** An inbound envelope from an external sender: strictly fewer rights. */
  readonly deliverExternal: (
    input: Omit<MailboxSendInput, "origin" | "owner"> & {
      readonly owner: string;
      readonly chain: readonly string[];
    },
  ) => Promise<MailboxEntry>;
  /** Entries visible to an owner (their bots' traffic), newest last. */
  readonly list: (owner: string) => Promise<MailboxList>;
  /** Tool sends from `from` to `to` against the exchange cap (used/cap). */
  readonly budgetOf: (
    owner: string,
    from: string,
    to: string,
    originConversation?: string | null,
  ) => Promise<{ readonly used: number; readonly cap: number }>;
  /** Dead-lettered entries — the attention path reads this. */
  readonly dead: (owner: string) => Promise<MailboxList>;
  /**
   * The tunnel transcript for a room: every exchanged envelope,
   * speaker-labelled, oldest first, with its delivery status.
   */
  readonly transcriptOf: (owner: string, room: RoomInfo) => Promise<readonly TranscriptLine[]>;
  /** The conversation a profile tunnels at in a room (their latest send origin, else main). */
  readonly endpointOf: (owner: string, room: RoomInfo, profileId: string) => Promise<string>;
  /** Hear a message expire unanswered. Returns the unsubscribe. */
  readonly onExpired: (fn: (entry: MailboxEntry) => void) => () => void;
  /** Remove every entry touching a profile (purge cascade). */
  readonly purgeProfile: (owner: string, profileId: string) => Promise<number>;
  /** Cancel a pending message; the sender is told. A finished one is returned unchanged. */
  readonly cancel: (owner: string, id: string) => Promise<MailboxEntry>;
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
    const topic = (input.topic ?? "").trim();
    const originConversation = input.originConversation ?? null;
    await validateSend(e.deps.converse, e.deps.profiles, {
      owner: input.owner,
      from: input.from,
      to: input.to,
      chain: [input.from],
      artifacts: input.artifacts ?? [],
      origin: input.origin,
      originConversation,
    });
    const envelope = envelopeOf(input, input.from, [input.from], topic, input.artifacts ?? []);
    return admit(e, input.owner, envelope, input.origin, originConversation);
  },
  deliverExternal: async (input) => {
    const sender = `external:${input.from.replace(/^external:/, "")}`;
    const chain = [...input.chain, sender];
    const topic = (input.topic ?? "").trim();
    await validateSend(e.deps.converse, e.deps.profiles, {
      owner: input.owner,
      from: sender,
      to: input.to,
      chain,
      artifacts: [],
      origin: "external",
      originConversation: null,
    });
    return admit(e, input.owner, envelopeOf(input, sender, chain, topic, []), "external", null);
  },
});

const transcriptOf =
  (e: Engine) =>
  async (owner: string, room: RoomInfo): Promise<readonly TranscriptLine[]> => {
    const entries = await readEntries(e.deps.converse);
    const nameOf = async (id: string): Promise<string> => {
      if (isExternal(id)) return id.replace(/^external:/, "");
      return (await e.deps.profiles.get(owner, id))?.name ?? id;
    };
    const inRoom = entries
      .filter(
        (candidate) =>
          (candidate.owner ?? "") === owner &&
          candidate.envelope.topic === room.topic &&
          room.participants.includes(candidate.envelope.from) &&
          room.participants.includes(candidate.envelope.to),
      )
      .sort((a, b) => a.envelope.at - b.envelope.at);
    return Promise.all(
      inRoom.map(async (candidate) => ({
        at: candidate.envelope.at,
        speaker: await nameOf(candidate.envelope.from),
        text: candidate.envelope.body,
        system: false,
        id: candidate.envelope.id,
        status: candidate.status,
        error: candidate.error,
      })),
    );
  };

export const mailboxService = (deps: MailboxDeps): MailboxService => {
  const e = makeEngine(deps);
  const { converse, profiles } = deps;
  const service: MailboxService = {
    ...sendOps(e),
    transcriptOf: transcriptOf(e),
    endpointOf: (owner, room, profileId) =>
      readEntries(converse).then((entries) => endpointFor(e, owner, room, profileId, entries)),
    budgetOf: async (owner, from, to, originConversation = null) => {
      const entries = await readEntries(converse);
      const cutoff = await lastBriefedAt(converse, originConversation);
      return { used: exchangeUsed(entries, owner, from, to, cutoff), cap: ROOM_EXCHANGE_CAP };
    },
    list: async (owner) => {
      const entries = await readEntries(converse);
      const owned = new Set((await profiles.list(owner)).map((profile) => profile.id));
      return entries.filter(
        (entry) => owned.has(entry.envelope.from) || owned.has(entry.envelope.to),
      );
    },
    dead: (owner) =>
      service.list(owner).then((entries) => entries.filter((entry) => entry.status === "dead")),
    purgeProfile: (_owner, profileId) =>
      readEntries(converse).then(async (entries) => {
        const remaining = entries.filter(
          (entry) => entry.envelope.from !== profileId && entry.envelope.to !== profileId,
        );
        await writeEntries(converse, () => remaining);
        return entries.length - remaining.length;
      }),
    onExpired: (fn) => {
      e.expiredListeners.add(fn);
      return () => void e.expiredListeners.delete(fn);
    },
    cancel: (owner, id) => cancelEntry(e, owner, id),
    recover: () => recover(e),
  };
  return service;
};
