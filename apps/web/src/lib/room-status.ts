/**
 * A bot-to-bot message's delivery state in plain words: a short label, plus
 * the reason the server recorded when it adds anything. A delivered message
 * shows nothing.
 */
import type { RoomLine } from "./api.ts";

export type DeliveryNote = {
  readonly label: string;
  /** Why, in a sentence; null when the label already says it all. */
  readonly reason: string | null;
  readonly tone: "muted" | "error";
};

/** Reasons the mailbox writes itself, reworded for the owner. */
const KNOWN_REASONS: Record<string, string | null> = {
  "recipient has no message tool":
    "The other bot can't reply: the message tool is off in its tool settings.",
  "cancelled by the owner": null,
  "expired while the server was down": "The server was down when the time ran out.",
};

const sentence = (text: string): string => {
  const trimmed = text.trim();
  const capped = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
};

/**
 * The recorded error as a readable sentence, or null. Rows written before
 * the server kept owner-worded errors can hold a bare tag
 * ("spriessen/External") or "[object Object]" — those say nothing, so they
 * are dropped rather than shown.
 */
export function reasonOf(error: string | null | undefined): string | null {
  if (error === null || error === undefined) return null;
  const text = error.replace(/^(Error|TypeError|[A-Za-z]+Error):\s*/, "").trim();
  if (text === "" || text === "[object Object]" || /^[\w-]+\/[\w-]+$/.test(text)) return null;
  if (text in KNOWN_REASONS) return KNOWN_REASONS[text] ?? null;
  // Anything else is already owner-worded and scrubbed by the server.
  return sentence(text);
}

export function deliveryNote(line: Pick<RoomLine, "status" | "error">): DeliveryNote | null {
  const reason = reasonOf(line.error);
  switch (line.status) {
    case "pending":
      return reason === null
        ? { label: "Waiting for a reply", reason: null, tone: "muted" }
        : { label: "Delivery failed, trying again", reason, tone: "muted" };
    case "failed":
    case "dead":
      return { label: "Couldn't be delivered", reason, tone: "error" };
    case "expired":
      return { label: "Timed out without a reply", reason, tone: "error" };
    case "cancelled":
      return { label: "Cancelled before a reply", reason, tone: "muted" };
    default:
      return null;
  }
}
