/**
 * "Needs you": the short list of things only the owner can settle. Five
 * kinds, in this order: approvals waiting now, work the engine parked after
 * too many restarts in a row (with a Retry button), tasks that failed in the
 * last day, routines that escalated in the last week, and memory tidy
 * suggestions (one row per bot). Pure, so the screen and the badge count agree and the
 * rules are testable. Failed tasks and escalations can be dismissed; the
 * others leave the list when they are settled.
 */
import { adoptLegacyKey } from "./stored-key.ts";
import type { AuditEvent, ProfileInfo, TaskRow } from "@spreissen/contracts";
import type { PendingApprovalRow } from "./api";

export const FAILED_TASK_WINDOW_MS = 24 * 3_600_000;
export const ESCALATION_WINDOW_MS = 7 * 24 * 3_600_000;
/** A short list, not a feed. */
export const NEEDS_YOU_LIMIT = 12;

/** What GET /api/needs-you adds to the client's own polls. */
export interface NeedsYouExtra {
  tidy: { profile: string; open: number }[];
  escalations: AuditEvent[];
  chats: Record<string, string>;
  /** Engine tasks parked by the restart limit (older servers leave it out). */
  parked?: ParkedRow[];
}

/** A parked engine task: cut off by restarts too many times in a row; Retry runs it again. */
export interface ParkedRow {
  taskId: string;
  kind: string;
  profile: string;
  conversationId: string;
  sessionId: string | null;
}

export type NeedsKind = "approval" | "parked" | "failed-task" | "escalation" | "tidy";

/** Where a row leads: a chat (by session or by bot) or a Crew profile tab. */
export type NeedsTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "bot-chat"; botId: string }
  | { kind: "profile"; botId: string; tab: "routines" | "memory" };

export interface NeedsItem {
  /** Stable across polls; also the dismiss key. */
  id: string;
  kind: NeedsKind;
  botId: string;
  botName: string;
  title: string;
  detail: string | null;
  at: number | null;
  target: NeedsTarget;
  dismissable: boolean;
  /** The waiting call itself, so the approval can be settled right here. */
  approval?: PendingApprovalRow | undefined;
  /** A parked task's id, for its Retry button. */
  retryTaskId?: string | undefined;
}

const RANK: Record<NeedsKind, number> = {
  approval: 0,
  parked: 1,
  "failed-task": 2,
  escalation: 3,
  tidy: 4,
};

export function needsYouItems(input: {
  approvals: readonly PendingApprovalRow[];
  tasks: readonly TaskRow[];
  extra: NeedsYouExtra | null;
  profiles: readonly ProfileInfo[];
  dismissed: ReadonlySet<string>;
  now: number;
}): NeedsItem[] {
  const bots = new Map(
    input.profiles.filter((bot) => bot.archivedAt === null).map((bot) => [bot.id, bot.name]),
  );
  const items: NeedsItem[] = [];

  for (const row of input.approvals) {
    const name = bots.get(row.profile);
    if (name === undefined) continue;
    const task = input.tasks.find((t) => t.taskConversationId === row.conversationId);
    const sessionId =
      task !== undefined && task.sessionId !== ""
        ? task.sessionId
        : (row.sessionId ?? input.extra?.chats[row.conversationId]);
    items.push({
      id: `approval:${row.conversationId}:${row.callId}`,
      kind: "approval",
      botId: row.profile,
      botName: name,
      title: `${name} wants to run ${row.name}`,
      detail: row.reason,
      at: null,
      target:
        sessionId !== undefined
          ? { kind: "session", sessionId }
          : { kind: "bot-chat", botId: row.profile },
      dismissable: false,
      approval: row,
    });
  }

  for (const row of input.extra?.parked ?? []) {
    const name = bots.get(row.profile);
    if (name === undefined) continue;
    items.push({
      id: `parked:${row.taskId}`,
      kind: "parked",
      botId: row.profile,
      botName: name,
      title: `${name} stopped: a restart cut this work off too many times`,
      detail: "It will not run again by itself. Retry runs it from where it stopped.",
      at: null,
      target:
        row.sessionId !== null
          ? { kind: "session", sessionId: row.sessionId }
          : { kind: "bot-chat", botId: row.profile },
      dismissable: false,
      retryTaskId: row.taskId,
    });
  }

  for (const task of input.tasks) {
    const botId = task.bot?.profileId;
    const name = botId === undefined ? undefined : bots.get(botId);
    if (botId === undefined || name === undefined || task.status !== "failed") continue;
    const at = task.finishedAt ?? task.createdAt;
    if (input.now - at > FAILED_TASK_WINDOW_MS) continue;
    items.push({
      id: `task:${task.id}`,
      kind: "failed-task",
      botId,
      botName: name,
      title: `${task.title ?? task.prompt.slice(0, 60)} failed`,
      detail: task.error,
      at,
      target:
        task.sessionId !== ""
          ? { kind: "session", sessionId: task.sessionId }
          : { kind: "bot-chat", botId },
      dismissable: true,
    });
  }

  for (const event of input.extra?.escalations ?? []) {
    const name = event.profile === null ? undefined : bots.get(event.profile);
    if (event.profile === null || name === undefined || event.kind !== "escalation") continue;
    if (input.now - event.at > ESCALATION_WINDOW_MS) continue;
    items.push({
      id: `escalation:${event.at}:${event.conversationId}:${event.callId ?? ""}`,
      kind: "escalation",
      botId: event.profile,
      botName: name,
      title: `${name} could not finish a routine`,
      detail: event.error ?? event.name,
      at: event.at,
      target: { kind: "profile", botId: event.profile, tab: "routines" },
      dismissable: true,
    });
  }

  for (const row of input.extra?.tidy ?? []) {
    const name = bots.get(row.profile);
    if (name === undefined || row.open <= 0) continue;
    items.push({
      id: `tidy:${row.profile}`,
      kind: "tidy",
      botId: row.profile,
      botName: name,
      title:
        row.open === 1
          ? `1 memory suggestion for ${name}`
          : `${row.open} memory suggestions for ${name}`,
      detail: "Review what to merge, fix or forget.",
      at: null,
      target: { kind: "profile", botId: row.profile, tab: "memory" },
      dismissable: false,
    });
  }

  return items
    .filter((item) => !item.dismissable || !input.dismissed.has(item.id))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.at ?? 0) - (a.at ?? 0))
    .slice(0, NEEDS_YOU_LIMIT);
}

const DISMISSED_KEY = "spreissen.needs-you.dismissed";
const LEGACY_DISMISSED_KEY = "ultiv.needs-you.dismissed";

export function readDismissed(): Set<string> {
  adoptLegacyKey(DISMISSED_KEY, LEGACY_DISMISSED_KEY);
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember a dismissal; keeps the newest 200 so the key never grows unbounded. */
export function writeDismissed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Private mode or a full quota: the dismissal lasts this visit only.
  }
}

/**
 * What needs the owner somewhere other than the chat on screen: this chat's
 * own approvals already show inline, and memory suggestions can wait for the
 * Needs you tab, so neither nags from the chat.
 */
export function needsElsewhere(
  items: readonly NeedsItem[],
  here: { sessionId?: string | undefined; botId?: string | undefined },
): NeedsItem[] {
  return items.filter((item) => {
    if (item.kind === "tidy") return false;
    if (item.kind !== "approval") return true;
    const target = item.target;
    if (target.kind === "session") return target.sessionId !== here.sessionId;
    if (target.kind === "bot-chat") return target.botId !== here.botId;
    return true;
  });
}

/** "Nova wants to run bash" alone, "2 things need you" for more. */
export function needsPillLabel(items: readonly NeedsItem[]): string {
  if (items.length === 1) return items[0]!.title;
  return `${items.length} things need you`;
}
