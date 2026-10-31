/**
 * The mailbox's loop and cost safety rules (RFC 0001 §5.1–5.2): who may
 * send to whom, hop caps, cycle refusal, per-pair rate limits, per-pair
 * exchange caps and per-profile daily budgets. All checks run BEFORE a
 * message is admitted; nothing here touches delivery.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InvalidInput, NotFound } from "@spreissen/core";
import type { MailboxEntry, MailboxEnvelope } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { isExternal, readEntries, run } from "./store.ts";

export const HOP_CAP = 3;
export const PAIR_RATE_PER_HOUR = 10;
export const EXTERNAL_RATE_PER_HOUR = 5;
export const MAX_RETRIES = 3;
/**
 * Ad-hoc exchange cap: a bot may send at most this many tool-initiated
 * messages to one sibling (all topics/rooms combined), so two bots never
 * loop forever. Deliberate paths (REST/owner sends) are exempt.
 */
export const ROOM_EXCHANGE_CAP = 3;

export type MailboxOrigin = "tool" | "human" | "cron" | "external";

/**
 * After a request's turn settles: the sender is woken with a finish signal
 * ONLY if the recipient did not already reply through the tunnel — a real
 * reply envelope delivers to the sender's endpoint on its own, and signalling
 * as well would double-wake them (two turns, two answers, cascade to the cap).
 */
export const shouldSignalReply = (
  envelope: MailboxEnvelope,
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

/** The first text of a model message, whatever its content shape. */
const firstText = (content: unknown): string =>
  String(
    (Array.isArray(content) ? (content as readonly { text?: unknown }[])[0]?.text : content) ?? "",
  );

/**
 * When the owner last gave this conversation a REAL instruction (an input
 * that is not bracketed machinery). The exchange cap counts sends after this
 * moment, so every fresh owner brief opens a new exchange budget — while
 * autonomous wake chains (bracketed inputs only) keep accumulating to the
 * cap. 0 when unknown → conservative all-time counting.
 */
export const lastBriefedAt = async (
  converse: ConverseService,
  conversationId: string | null,
): Promise<number> => {
  if (conversationId === null || conversationId === "") return 0;
  try {
    const chat = await run(converse.open(conversationId));
    if (chat === undefined) return 0;
    const view = await chat.viewState(BACKGROUND_CONTEXT);
    const entries = view.value?.entries ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      for (const message of (entries[index]?.model ?? []) as readonly unknown[]) {
        const record = message as { role?: string; content?: unknown; timestamp?: unknown };
        if (record.role !== "user") continue;
        const text = firstText(record.content).trim();
        if (text !== "" && !text.startsWith("[")) {
          return typeof record.timestamp === "number" ? record.timestamp : 0;
        }
      }
    }
    return 0;
  } catch {
    return 0;
  }
};

/** Tool sends from `from` to `to` since the cutoff — what the exchange cap counts. */
export const exchangeUsed = (
  entries: readonly MailboxEntry[],
  owner: string,
  from: string,
  to: string,
  cutoff: number,
): number =>
  entries.filter(
    (candidate) =>
      (candidate.owner ?? "") === owner &&
      candidate.origin !== "human" &&
      candidate.origin !== "cron" &&
      candidate.envelope.from === from &&
      candidate.envelope.to === to &&
      candidate.envelope.at > cutoff,
  ).length;

export interface SendCheck {
  readonly owner: string;
  readonly from: string;
  readonly to: string;
  readonly chain: readonly string[];
  readonly artifacts: readonly string[];
  readonly origin: MailboxOrigin;
  readonly originConversation: string | null;
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

/** How much: pair rate per hour, the ad-hoc exchange cap, the daily budget. */
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
  if (check.origin === "tool") {
    // Ad-hoc exchanges don't run forever: each bot gets a fixed number of
    // sends per sibling (all topics combined), so back-and-forth converges.
    // The window opens at the owner's LAST real instruction on the sending
    // thread — a fresh brief resets the budget; autonomous wake chains
    // (bracketed inputs only) accumulate to the cap.
    const cutoff = await lastBriefedAt(converse, check.originConversation);
    if (exchangeUsed(entries, owner, from, to, cutoff) >= ROOM_EXCHANGE_CAP) {
      throw new InvalidInput({
        reason:
          `exchange cap reached (${ROOM_EXCHANGE_CAP} messages to this sibling in this exchange) — ` +
          "conclude here; a fresh instruction from your owner on this thread resets it",
      });
    }
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

/** Refuse a send before anything is admitted. */
export const validateSend = async (
  converse: ConverseService,
  profiles: ProfilesService,
  check: SendCheck,
): Promise<void> => {
  const fromProfile = await checkParties(profiles, check);
  await checkRates(converse, check, fromProfile?.policies.dailyTurnBudget ?? null);
};
