/** Plain-language mailbox delivery status; a delivered message shows nothing. */
export const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for a reply",
  failed: "Couldn't be delivered",
  dead: "Couldn't be delivered (tried 3 times)",
  expired: "Timed out — no reply in time",
  cancelled: "Cancelled",
};
