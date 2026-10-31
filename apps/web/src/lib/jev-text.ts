/**
 * Jev's gate decisions as inline chat notices. The note prefixes mirror
 * packages/mind/src/jev-gate.ts (SPLIT_PREFIX, DESTRUCTIVE_PREFIX).
 */
import type { AuditEvent } from "@spreissen/contracts";

export type JevKind = "approved" | "denied" | "split" | "destructive";

export interface JevNotice {
  readonly kind: JevKind;
  readonly title: string;
  readonly reason: string;
}

const SPLIT = "too complex to judge: split into smaller steps";
const DESTRUCTIVE = "destructive and not justified by the request";

const TITLES: Record<JevKind, string> = {
  approved: "Jev approved",
  denied: "Jev denied",
  split: "Jev asked to split",
  destructive: "Jev blocked (destructive, not asked for)",
};

/** One adjudication audit event as a notice; null when it is not a decision. */
export function jevNotice(event: AuditEvent): JevNotice | null {
  if (event.kind !== "adjudication" || event.ok === null) return null;
  const text = event.error ?? "";
  const kind: JevKind = event.ok
    ? "approved"
    : text.startsWith(SPLIT)
      ? "split"
      : text.startsWith(DESTRUCTIVE)
        ? "destructive"
        : "denied";
  const reason = text
    .replace(SPLIT, "")
    .replace(/^destructive and not justified by the request: explain why or ask the user first/, "")
    .replace(/^\s*—\s*/, "")
    .trim();
  return { kind, title: `${TITLES[kind]}: ${event.name ?? "a tool"}`, reason };
}

/** Notices by tool call id (the latest decision per call wins). */
export function jevNotices(events: readonly AuditEvent[]): ReadonlyMap<string, JevNotice> {
  const out = new Map<string, JevNotice>();
  for (const event of events) {
    const notice = jevNotice(event);
    if (notice !== null && event.callId !== null) out.set(event.callId, notice);
  }
  return out;
}
