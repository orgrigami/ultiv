/**
 * What the wordmark shows about the link to the server: nothing while it is
 * up (the normal case needs no badge), a quiet dot while connecting, and a
 * warning with a word once it is lost.
 */
export type LinkBadge = {
  readonly kind: "pending" | "error";
  readonly tone: "muted" | "signal";
  readonly title: string;
  /** Shown beside the dot; none while merely connecting. */
  readonly label: string | null;
};

export function linkBadge(phase: "connecting" | "live" | "lost"): LinkBadge | null {
  if (phase === "live") return null;
  if (phase === "connecting") {
    return { kind: "pending", tone: "muted", title: "Connecting", label: null };
  }
  return {
    kind: "error",
    tone: "signal",
    title: "Disconnected from the server",
    label: "disconnected",
  };
}
