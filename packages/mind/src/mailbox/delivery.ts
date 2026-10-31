/**
 * Delivery: one envelope into the recipient's ENDPOINT conversation (their
 * main thread, or the thread they tunnel at), settled in the background.
 * Admission is the contract; a failed turn is retried, then dead-lettered
 * with a NACK. Every step is safe to repeat:
 * - each attempt submits with a stable request id (`mailbox:<id>:<attempt>`),
 *   so a redelivery after a restart finds the same input instead of adding
 *   a second one, and the recipient never answers the same message twice;
 * - only a turn that genuinely came back unanswered counts as an attempt;
 * - a message still pending at its deadline expires and the sender is told;
 * - a finish signal or NACK still owed to the sender is marked in the doc,
 *   so `recover` (run on boot) re-sends it along with redelivering pending
 *   messages and re-arming deadlines.
 */
import { NotFound } from "@spreissen/core";
import type { MailboxEntry, RoomInfo } from "@spreissen/contracts";
import type { AuditService } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { RoomsService } from "../profiles/rooms.ts";
import { MAX_RETRIES, shouldSignalReply } from "./policy.ts";
import {
  Lane,
  findEntry,
  isExternal,
  readEntries,
  run,
  updatePending,
  writeEntries,
  type EntryPatch,
} from "./store.ts";
import { cancelledText, deadText, envelopeText, expiredText, replySignalText } from "./text.ts";
import { wakeQueue, type WakeQueue } from "./wakes.ts";

/** How long a message may stay unanswered before the sender gets a timeout NACK. */
export const DEADLINE_MS = 15 * 60_000;

export interface MailboxDeps {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  readonly rooms: RoomsService;
  readonly audit: AuditService;
  /** Materializes envelope artifact grants (copy into the recipient's store). */
  readonly grantArtifacts?: (
    owner: string,
    from: string,
    to: string,
    ids: readonly string[],
  ) => Promise<void>;
  readonly options?: {
    readonly globalLanes?: number;
    readonly profileLanes?: number;
    readonly retryDelayMs?: number;
    /** Per-message deadline; default MAILBOX_DEADLINE_MS or 15 minutes. */
    readonly deadlineMs?: number;
  };
}

export interface Engine {
  readonly deps: MailboxDeps;
  readonly globalLane: Lane;
  readonly profileLane: (id: string) => Lane;
  readonly retryDelayMs: number;
  readonly deadlineMs: number;
  readonly wakes: WakeQueue;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Hear a message expire unanswered (the push notifier rides this). */
  readonly expiredListeners: Set<(entry: MailboxEntry) => void>;
}

const logged =
  (what: string) =>
  (cause: unknown): void => {
    console.error(`${what}:`, cause);
  };

export const makeEngine = (deps: MailboxDeps): Engine => {
  const profileLanes = new Map<string, Lane>();
  return {
    deps,
    globalLane: new Lane(deps.options?.globalLanes ?? 3),
    profileLane: (id) => {
      let lane = profileLanes.get(id);
      if (lane === undefined) {
        lane = new Lane(deps.options?.profileLanes ?? 2);
        profileLanes.set(id, lane);
      }
      return lane;
    },
    retryDelayMs: deps.options?.retryDelayMs ?? 5_000,
    deadlineMs: deps.options?.deadlineMs ?? Number(process.env.MAILBOX_DEADLINE_MS ?? DEADLINE_MS),
    wakes: wakeQueue(deps.converse, (ids) =>
      writeEntries(deps.converse, (items) =>
        items.map((entry) =>
          ids.includes(entry.envelope.id) ? { ...entry, senderNotified: true } : entry,
        ),
      ),
    ),
    timers: new Map(),
    expiredListeners: new Set(),
  };
};

const requestIdOf = (entry: MailboxEntry): string =>
  `mailbox:${entry.envelope.id}:${entry.retries}`;

/** Only a turn that settled unanswered is a failed attempt; an interrupted wait is not. */
const isUnanswered = (cause: unknown): boolean =>
  (cause as { op?: unknown } | null)?.op === "agent turn" ||
  String(cause).includes("agent unanswered");

/** The bot's main-chat conversation id — the default tunnel endpoint. */
export const mainConversationId = async (
  e: Engine,
  owner: string,
  profileId: string,
): Promise<string> => {
  const { converse, profiles } = e.deps;
  const key = await profiles.keyOfRow(await profiles.ensureMain(owner, profileId));
  const cid = await run(converse.conversationIdOf(key));
  if (cid !== undefined) return String(cid);
  return String((await run(converse.ensure(key))).id);
};

/**
 * Where a profile tunnels at in this room: the thread they last sent FROM
 * here (a session, if the exchange started in one), else their main chat.
 */
export const endpointFor = async (
  e: Engine,
  owner: string,
  room: Pick<RoomInfo, "topic">,
  profileId: string,
  entries: readonly MailboxEntry[],
): Promise<string> => {
  const mine = entries
    .filter(
      (candidate) =>
        (candidate.owner ?? "") === owner &&
        candidate.envelope.topic === room.topic &&
        candidate.envelope.from === profileId &&
        candidate.originConversation != null,
    )
    .sort((a, b) => a.envelope.at - b.envelope.at);
  const last = mine[mine.length - 1];
  return last?.originConversation ?? (await mainConversationId(e, owner, profileId));
};

const nameOf = async (e: Engine, owner: string, id: string): Promise<string> =>
  (await e.deps.profiles.get(owner, id))?.name ?? id;

/** Wake the sender's origin thread (else their main chat); external senders have none. */
const notifySender = async (e: Engine, entry: MailboxEntry, text: string): Promise<void> => {
  if (isExternal(entry.envelope.from)) return;
  const target =
    entry.originConversation ??
    (await mainConversationId(e, entry.owner ?? "", entry.envelope.from));
  e.wakes.wake(target, text, entry.envelope.id);
};

/** Settle a pending entry as failed (dead, expired, cancelled) and tell the sender. */
const finishWithNack = async (
  e: Engine,
  id: string,
  patch: EntryPatch,
  textOf: (entry: MailboxEntry, toName: string) => string,
): Promise<MailboxEntry | undefined> => {
  const done = await updatePending(e.deps.converse, id, {
    ...patch,
    settledAt: Date.now(),
    senderNotified: false,
  });
  if (done === undefined) return undefined;
  clearDeadline(e, id);
  const text = textOf(done, await nameOf(e, done.owner ?? "", done.envelope.to));
  e.deps.audit.record({
    at: Date.now(),
    kind: "mailbox",
    conversationId: "mailbox",
    profile: done.envelope.from,
    callId: id,
    name: done.status,
    durationMs: null,
    ok: false,
    error: text.slice(0, 300),
  });
  await notifySender(e, done, text);
  return done;
};

const onFailure = async (e: Engine, entry: MailboxEntry, cause: unknown): Promise<void> => {
  const retries = entry.retries + 1;
  const error = String(cause).slice(0, 300);
  if (retries < MAX_RETRIES) {
    const updated = await updatePending(e.deps.converse, entry.envelope.id, { retries, error });
    if (updated === undefined) return;
    setTimeout(() => {
      void deliver(e, updated).catch(logged("mailbox delivery failed"));
    }, e.retryDelayMs).unref?.();
    return;
  }
  await finishWithNack(e, entry.envelope.id, { retries, error, status: "dead" }, deadText);
};

/** Resolve everything an attempt needs: names, the room, the endpoint conversation. */
const prepare = async (e: Engine, entry: MailboxEntry) => {
  const { converse, profiles, rooms } = e.deps;
  const { envelope } = entry;
  const owner = entry.owner ?? "";
  const [fromProfile, toProfile, room, entries] = await Promise.all([
    isExternal(envelope.from) ? Promise.resolve(undefined) : profiles.get(owner, envelope.from),
    profiles.get(owner, envelope.to),
    rooms.ensure(owner, [envelope.from, envelope.to], envelope.topic ?? ""),
    readEntries(converse),
  ]);
  // Envelope artifact grants materialize as copies into the recipient's
  // store — otherwise "granted artifacts" are ids the recipient can't read.
  // Granted once: a redelivery finds them already copied.
  if (
    entry.deliveredAt === null &&
    envelope.artifacts.length > 0 &&
    !isExternal(envelope.from) &&
    e.deps.grantArtifacts !== undefined
  ) {
    await e.deps
      .grantArtifacts(owner, envelope.from, envelope.to, envelope.artifacts)
      .catch(logged("mailbox artifact grant failed"));
  }
  const endpointId = entry.endpoint ?? (await endpointFor(e, owner, room, envelope.to, entries));
  const chat = await run(converse.open(endpointId));
  if (chat === undefined) throw new Error(`tunnel endpoint ${endpointId} unmapped`);
  return {
    room,
    chat,
    endpointId,
    fromName: fromProfile?.name ?? envelope.from,
    toName: toProfile?.name ?? envelope.to,
  };
};

/** The turn answered: mark replied and, when owed, signal the sender. */
const afterSettled = async (
  e: Engine,
  entry: MailboxEntry,
  toName: string,
  roomId: string,
): Promise<void> => {
  const { envelope } = entry;
  // A finish SIGNAL, not a transcript copy — and ONLY when the recipient
  // did not reply through the tunnel (their reply envelope already woke the
  // sender; a second signal would double every turn).
  const signal =
    envelope.kind === "request" &&
    !isExternal(envelope.from) &&
    shouldSignalReply(envelope, await readEntries(e.deps.converse));
  const settled = await updatePending(e.deps.converse, envelope.id, {
    status: "replied",
    settledAt: Date.now(),
    error: null,
    ...(signal ? { senderNotified: false } : {}),
  });
  if (settled === undefined) return; // expired or cancelled meanwhile
  clearDeadline(e, envelope.id);
  if (signal) await notifySender(e, settled, replySignalText(toName, envelope.id, roomId));
};

const attempt = async (e: Engine, id: string): Promise<void> => {
  const { converse, rooms } = e.deps;
  // An unreadable doc (the server closing under a queued retry) leaves the
  // message pending; boot recovery delivers it.
  const entry = await findEntry(converse, id).catch(() => undefined);
  if (entry === undefined || entry.status !== "pending") return;
  let prepared: Awaited<ReturnType<typeof prepare>>;
  let submission;
  try {
    prepared = await prepare(e, entry);
    const text = envelopeText(entry.envelope, prepared.fromName, prepared.room.topic);
    submission = await run(converse.submit(prepared.chat, text, undefined, requestIdOf(entry)));
    await updatePending(converse, id, {
      deliveredAt: entry.deliveredAt ?? Date.now(),
      endpoint: prepared.endpointId,
      submissionId: String(submission.id),
    });
    await rooms.touch(entry.owner ?? "", prepared.room.id);
  } catch (cause) {
    await onFailure(e, entry, cause);
    return;
  }
  try {
    await run(converse.settle(prepared.chat, submission));
  } catch (cause) {
    // A turn that came back unanswered is a failed attempt. Anything else
    // (the server shutting down mid-wait) leaves the message pending:
    // recovery or the deadline picks it up, never a second copy.
    if (isUnanswered(cause)) await onFailure(e, entry, cause);
    else console.error("mailbox settle interrupted; left pending:", cause);
    return;
  }
  await afterSettled(e, entry, prepared.toName, prepared.room.id).catch(
    logged("mailbox reply bookkeeping failed"),
  );
};

/** Run one attempt inside the global and per-recipient lanes. */
export const deliver = async (e: Engine, entry: MailboxEntry): Promise<void> => {
  const releaseGlobal = await e.globalLane.acquire();
  const releaseProfile = await e.profileLane(entry.envelope.to).acquire();
  try {
    await attempt(e, entry.envelope.id);
  } finally {
    releaseProfile();
    releaseGlobal();
  }
};

export const clearDeadline = (e: Engine, id: string): void => {
  const timer = e.timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  e.timers.delete(id);
};

/** Past the deadline: take back a still-queued input, mark expired, NACK the sender. */
export const expire = async (e: Engine, id: string): Promise<void> => {
  const entry = await findEntry(e.deps.converse, id);
  if (entry === undefined || entry.status !== "pending") return;
  if (entry.deadlineAt !== undefined && entry.deadlineAt > Date.now()) {
    armDeadline(e, entry);
    return;
  }
  await withdrawQueued(e, entry);
  const minutes = Math.max(1, Math.round(e.deadlineMs / 60_000));
  const expired = await finishWithNack(
    e,
    id,
    { status: "expired", error: `no reply within ${minutes} minutes` },
    (done, toName) => expiredText(done, toName, e.deadlineMs),
  );
  if (expired === undefined) return;
  for (const fn of e.expiredListeners) {
    try {
      fn(expired);
    } catch (cause) {
      console.error("mailbox expiry listener failed:", cause);
    }
  }
};

export const armDeadline = (e: Engine, entry: MailboxEntry): void => {
  if (entry.deadlineAt === undefined) return;
  clearDeadline(e, entry.envelope.id);
  const delay = Math.min(Math.max(0, entry.deadlineAt - Date.now()), 2 ** 31 - 1);
  const timer = setTimeout(() => {
    e.timers.delete(entry.envelope.id);
    void expire(e, entry.envelope.id).catch(logged("mailbox expiry failed"));
  }, delay);
  timer.unref?.();
  e.timers.set(entry.envelope.id, timer);
};

/** Best effort: a still-queued input is taken back; one already being answered stays. */
const withdrawQueued = async (e: Engine, entry: MailboxEntry): Promise<void> => {
  if (entry.endpoint === undefined || entry.submissionId === undefined) return;
  try {
    const chat = await run(e.deps.converse.open(entry.endpoint));
    if (chat !== undefined) await run(e.deps.converse.withdraw(chat, entry.submissionId));
  } catch (cause) {
    logged("mailbox withdraw failed")(cause);
  }
};

/** The owner cancels a pending message; the sender is told not to wait for it. */
export const cancelEntry = async (e: Engine, owner: string, id: string): Promise<MailboxEntry> => {
  const entry = await findEntry(e.deps.converse, id);
  const owned = new Set((await e.deps.profiles.list(owner)).map((profile) => profile.id));
  if (entry === undefined || !(owned.has(entry.envelope.from) || owned.has(entry.envelope.to))) {
    throw new NotFound({ what: `message ${id}` });
  }
  const cancelled = await finishWithNack(
    e,
    id,
    { status: "cancelled", error: "cancelled by the owner" },
    cancelledText,
  );
  if (cancelled === undefined) return entry; // it had already finished
  await withdrawQueued(e, cancelled);
  return cancelled;
};

export { notifySender };
