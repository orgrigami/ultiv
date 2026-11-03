/**
 * The mailbox's loop and cost safety rules (RFC 0001 §5.1–5.2): who may
 * send to whom, hop caps, cycle refusal, per-pair rate limits, per-profile
 * daily budgets and the 24h stale-room rollover. All checks run BEFORE a
 * message is admitted; nothing here touches delivery.
 */
import { InvalidInput, NotFound } from "@spriessen/core";
import type { MailboxEntry, RoomInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { entriesInRoom, isExternal, readEntries } from "./store.ts";

export const HOP_CAP = 3;
export const PAIR_RATE_PER_HOUR = 10;
export const EXTERNAL_RATE_PER_HOUR = 5;
export const MAX_RETRIES = 3;
/**
 * Stale-room rollover: when a send targets the pair's CURRENT room and the
 * room's last envelope is older than this, the mailbox AUTO-OPENS a fresh
 * room (same participants, new id, topic stamped with the resume date) and
 * delivers there. A fresh room is on topic by construction; the old room
 * stays readable. Conversation shape comes from topic + freshness, not a
 * send counter.
 */
export const ROOM_STALE_MS = 24 * 3_600_000;

export type MailboxOrigin = "tool" | "human" | "cron" | "external";

/**
 * After a request's turn settles: the sender is woken with a finish signal
 * ONLY if the recipient did not already reply through the tunnel — a real
 * reply envelope delivers to the sender's endpoint on its own, and signalling
 * as well would double-wake them (two turns, two answers, cascade to the cap).
 */
export const shouldSignalReply = (
  envelope: MailboxEntry["envelope"],
  entriesAfter: readonly MailboxEntry[],
): boolean =>
  !entriesAfter.some(
    (candidate) =>
      candidate.envelope.from === envelope.to &&
      candidate.envelope.to === envelope.from &&
      candidate.envelope.at > envelope.at,
  );

const dayStart = (): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

/**
 * Whether a room whose last envelope landed at `lastAt` is stale at `now`:
 * strictly past ROOM_STALE_MS old — 23h59m still delivers in-room.
 */
export const staleAt = (lastAt: number, now: number): boolean => now - lastAt > ROOM_STALE_MS;

const ROLLOVER_STAMP = / · \d{4}-\d{2}-\d{2}$/u;

/**
 * The fresh room's topic after a rollover: the base topic stamped with the
 * resume date ("pricing" → "pricing · 2026-11-04"), so the new room stays
 * topically identifiable and rooms.ensure opens a NEW record. Re-stripping
 * a previous stamp keeps one lineage legible across chained rollovers.
 */
export const rolloverTopic = (topic: string, at: number): string => {
  const base = topic.replace(ROLLOVER_STAMP, "");
  const date = new Date(at).toISOString().slice(0, 10);
  return base === "" ? `general · ${date}` : `${base} · ${date}`;
};

/** When the room's last envelope landed (its own entries; else its creation). */
export const roomLastActivityAt = (room: RoomInfo, entries: readonly MailboxEntry[]): number =>
  entriesInRoom(entries, room).at(-1)?.envelope.at ?? room.lastMessageAt;

/** How much: pair rate per hour and the per-profile daily budget. */
const checkRates = async (
  converse: ConverseService,
  check: SendCheck,
  dailyBudget: number | null,
): Promise<void> => {
  const { owner, from, to } = check;
  const entries = await readEntries(converse);
  const hourAgo = Date.now() - 3_600_000;
  const pairRate = isExternal(from) ? EXTERNAL_RATE_PER_HOUR : PAIR_RATE_PER_HOUR;
  const between = entries.filter(
    (candidate) =>
      (candidate.owner ?? "") === owner &&
      candidate.envelope.at > hourAgo &&
      ((candidate.envelope.from === from && candidate.envelope.to === to) ||
        (candidate.envelope.from === to && candidate.envelope.to === from)),
  );
  if (between.length >= pairRate) {
    throw new InvalidInput({ reason: `pair rate limit reached (${pairRate}/hour)` });
  }
  if (dailyBudget !== null && !isExternal(from)) {
    const today = dayStart();
    const sent = entries.filter(
      (candidate) => candidate.envelope.from === from && candidate.envelope.at >= today,
    );
    if (sent.length >= dailyBudget) {
      throw new InvalidInput({ reason: `daily turn budget reached (${dailyBudget})` });
    }
  }
};

export interface SendCheck {
  readonly owner: string;
  readonly from: string;
  readonly to: string;
  readonly chain: readonly string[];
  readonly artifacts: readonly string[];
  readonly origin: MailboxOrigin;
}

/** Who may talk to whom: self, cycles, hops, unknown/archived bots, grants, canInitiate. */
const checkParties = async (profiles: ProfilesService, check: SendCheck) => {
  const { owner, from, to, chain } = check;
  if (from === to) throw new InvalidInput({ reason: "cannot message yourself" });
  if (chain.includes(to)) {
    throw new InvalidInput({ reason: `cycle refused: ${to} is already in the chain` });
  }
  if (chain.length >= HOP_CAP) throw new InvalidInput({ reason: `hop cap reached (${HOP_CAP})` });
  const fromProfile = isExternal(from) ? undefined : await profiles.get(owner, from);
  const toProfile = await profiles.get(owner, to);
  if (fromProfile === undefined && !isExternal(from)) {
    throw new NotFound({ what: `profile ${from}` });
  }
  if (toProfile === undefined) throw new NotFound({ what: `profile ${to}` });
  if (toProfile.archivedAt !== null) {
    throw new InvalidInput({ reason: `profile ${to} is archived` });
  }
  if (fromProfile !== undefined && fromProfile.archivedAt !== null) {
    throw new InvalidInput({ reason: "archived profiles cannot send" });
  }
  if (isExternal(from) && check.artifacts.length > 0) {
    throw new InvalidInput({ reason: "external senders cannot carry artifact grants" });
  }
  if (check.origin === "tool") {
    // Open by default: `*` reaches every sibling; an explicit list
    // restricts; an empty list locks the profile out of the mailbox.
    const allowed = fromProfile?.policies.canInitiate ?? [];
    if (!allowed.includes("*") && !allowed.includes(to)) {
      throw new InvalidInput({ reason: `not allowed to initiate contact with ${to}` });
    }
  }
  return fromProfile;
};

/** Refuse a send before anything is admitted. */
export const validateSend = async (
  converse: ConverseService,
  profiles: ProfilesService,
  check: SendCheck,
): Promise<void> => {
  const fromProfile = await checkParties(profiles, check);
  await checkRates(converse, check, fromProfile?.policies.dailyTurnBudget ?? null);
};
