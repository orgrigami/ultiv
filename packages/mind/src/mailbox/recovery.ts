/**
 * Boot recovery: after a restart, every message is accounted for. Pending
 * messages are redelivered (the stable request id makes a delivery that did
 * land before the crash count once), deadlines are re-armed or fired, and a
 * finish signal or NACK the crash swallowed is sent again.
 */
import type { MailboxEntry } from "@spreissen/contracts";
import { armDeadline, deliver, expire, notifySender, type Engine } from "./delivery.ts";
import { isExternal, readEntries, updatePending } from "./store.ts";
import { cancelledText, deadText, expiredText, replySignalText } from "./text.ts";

export interface RecoveryReport {
  readonly redelivered: number;
  readonly expired: number;
  readonly rewoken: number;
}

const logged = (cause: unknown): void => {
  console.error("mailbox recovery:", cause);
};

/** The wake a settled entry still owes its sender, rebuilt from the entry. */
const owedText = async (e: Engine, entry: MailboxEntry): Promise<string | undefined> => {
  const owner = entry.owner ?? "";
  const toName = (await e.deps.profiles.get(owner, entry.envelope.to))?.name ?? entry.envelope.to;
  switch (entry.status) {
    case "dead":
      return deadText(entry, toName);
    case "expired":
      return expiredText(entry, toName, e.deadlineMs);
    case "cancelled":
      return cancelledText(entry, toName);
    case "replied": {
      const { from, to, topic } = entry.envelope;
      const room = await e.deps.rooms.ensure(owner, [from, to], topic ?? "");
      return replySignalText(toName, entry.envelope.id, room.id);
    }
    default:
      return undefined;
  }
};

/** A pending entry: expire it if its time is up, else re-arm and redeliver. */
const resumePending = async (
  e: Engine,
  entry: MailboxEntry,
): Promise<"redelivered" | "expired" | "dropped"> => {
  let current = entry;
  if (current.deadlineAt === undefined) {
    // Admitted before deadlines existed. Stale ones are closed quietly —
    // waking bots about old traffic would only start new exchanges.
    const deadlineAt = current.envelope.at + e.deadlineMs;
    if (deadlineAt <= Date.now()) {
      await updatePending(e.deps.converse, current.envelope.id, {
        status: "expired",
        settledAt: Date.now(),
        error: "expired while the server was down",
      });
      return "dropped";
    }
    current =
      (await updatePending(e.deps.converse, current.envelope.id, { deadlineAt })) ?? current;
  }
  if ((current.deadlineAt ?? 0) <= Date.now()) {
    await expire(e, current.envelope.id);
    return "expired";
  }
  armDeadline(e, current);
  void deliver(e, current).catch(logged);
  return "redelivered";
};

export const recover = async (e: Engine): Promise<RecoveryReport> => {
  const counts = { redelivered: 0, expired: 0, rewoken: 0 };
  for (const entry of await readEntries(e.deps.converse)) {
    try {
      if (entry.status === "pending") {
        const outcome = await resumePending(e, entry);
        if (outcome !== "dropped") counts[outcome] += 1;
      } else if (entry.senderNotified === false && !isExternal(entry.envelope.from)) {
        const text = await owedText(e, entry);
        if (text === undefined) continue;
        await notifySender(e, entry, text);
        counts.rewoken += 1;
      }
    } catch (cause) {
      logged(cause);
    }
  }
  return counts;
};
