/**
 * The projection of a durable conversation into renderable steps: committed
 * transcript entries plus the in-flight generation partial (`pi.live`).
 * A pure function of the conversation view — every surface of the mind
 * renders through this. Shape: `@spreissen/contracts` TranscriptEntry.
 */
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { AttachmentRef, TranscriptEntry } from "@spreissen/contracts";
import { TASK_UPDATE_KIND } from "../tasks/notify.ts";
import { TURN_NOTICE_KIND } from "./deadlines.ts";

export type Step = TranscriptEntry;

/** The app entry kind an owner input with attachments is placed as. */
export const INPUT_ENTRY_KIND = "ultiv.input";
/** The reference-line block an input's attachments append; display text cuts here. */
export const ATTACHMENTS_MARK = "\n\nAttached artifacts:";

/** Attachment refs an `ultiv.input` entry carries; junk data yields none. */
function attachmentRefsOf(data: unknown): readonly AttachmentRef[] | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const raw = (data as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return undefined;
  const refs: AttachmentRef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as { id?: unknown; name?: unknown; mime?: unknown; bytes?: unknown };
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.mime !== "string"
    ) {
      continue;
    }
    refs.push({
      id: row.id,
      name: row.name,
      mime: row.mime,
      ...(typeof row.bytes === "number" ? { bytes: row.bytes } : {}),
    });
  }
  return refs;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => String((block as { text?: string }).text ?? "")).join("");
  }
  return JSON.stringify(content);
}

interface ToolResult {
  readonly content: unknown;
  readonly isError: boolean;
  readonly durationMs: number | null;
  readonly details?: unknown;
}

/** toolCallId -> committed result, paired into the toolCall steps below. */
function toolResultsOf(entries: readonly EntryRecord[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const entry of entries) {
    for (const message of (entry.model ?? []) as readonly unknown[]) {
      const record = message as {
        role?: string;
        toolCallId?: unknown;
        content?: unknown;
        isError?: boolean;
        durationMs?: unknown;
        details?: unknown;
      };
      if (record.role !== "toolResult" || record.toolCallId === undefined) continue;
      results.set(String(record.toolCallId), {
        content: record.content,
        isError: record.isError === true,
        durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
        ...(record.details === undefined ? {} : { details: record.details }),
      });
    }
  }
  return results;
}

/** Committed entries -> steps; tool results surface through the paired call's collapsible. */
function committedSteps(entries: readonly EntryRecord[], results: Map<string, ToolResult>): Step[] {
  const out: Step[] = [];
  for (const entry of entries) {
    if (entry.kind === TASK_UPDATE_KIND) {
      // A task's progress line (notify_owner): passive, shown as a note.
      const data = (entry.data ?? {}) as { taskId?: unknown; text?: unknown; at?: unknown };
      const at = typeof data.at === "number" ? data.at : Date.now();
      const text = `[task ${String(data.taskId)} update] ${String(data.text ?? "")}`;
      out.push({ id: entry.id * 100, kind: "note", at, text });
      continue;
    }
    if (entry.kind === TURN_NOTICE_KIND) {
      // A turn deadline stopped the run: the reason, as a note in the chat.
      const data = (entry.data ?? {}) as { text?: unknown; at?: unknown };
      const at = typeof data.at === "number" ? data.at : Date.now();
      out.push({ id: entry.id * 100, kind: "note", at, text: String(data.text ?? "") });
      continue;
    }
    for (const message of (entry.model ?? []) as readonly unknown[]) {
      messageSteps(
        message,
        entry.id,
        results,
        entry.kind === INPUT_ENTRY_KIND ? attachmentRefsOf(entry.data) : undefined,
        out,
      );
    }
  }
  return out;
}

type MessageRecord = {
  role?: string;
  content?: unknown;
  timestamp?: unknown;
  stopReason?: unknown;
};

/** One committed model message -> steps (user input or note, or the assistant's blocks). */
function messageSteps(
  message: unknown,
  entryId: number,
  results: Map<string, ToolResult>,
  refs: readonly AttachmentRef[] | undefined,
  out: Step[],
): void {
  const record = message as MessageRecord;
  if (record.role === "toolResult" || record.role === "system") return;
  const at = typeof record.timestamp === "number" ? record.timestamp : Date.now();
  const blocks = Array.isArray(record.content)
    ? (record.content as readonly unknown[])
    : [{ type: "text", text: textOf(record.content) }];
  if (record.role === "user") {
    userStep(blocks, entryId * 100, at, refs, out);
    return;
  }
  // Stop or Redirect now cut this reply short: pi-durable kept the partial.
  const interrupted = record.stopReason === "aborted";
  const before = out.length;
  let blockIndex = 0;
  for (const block of blocks) {
    const id = entryId * 100 + blockIndex++;
    const kind = (block as { type?: string }).type;
    if (kind === "thinking") {
      const text = String((block as { thinking?: unknown }).thinking ?? "").trim();
      if (text !== "") out.push({ id, kind: "thinking", at, text });
    } else if (kind === "toolCall") {
      out.push(callStep(block, id, at, results));
    } else if (kind === "text") {
      const text = String((block as { text?: unknown }).text ?? "").trim();
      if (text === "") continue;
      out.push(
        interrupted
          ? { id, kind: "output", at, text, streaming: false, interrupted: true }
          : { id, kind: "output", at, text, streaming: false },
      );
    }
  }
  // Cut while still thinking: an empty marker keeps the interruption visible.
  if (interrupted && !out.slice(before).some((step) => step.kind === "output")) {
    out.push({
      id: entryId * 100 + 99,
      kind: "output",
      at,
      text: "",
      streaming: false,
      interrupted: true,
    });
  }
}

/**
 * A user message. Bracketed inputs are machinery, not things the user typed.
 * The onboarding seed is dropped outright; relays and room wakes render as
 * muted notes. The model still sees all of them. Display text joins every
 * text block (image blocks may follow) and cuts the attachment reference
 * block — the entry's attachment refs render as chips instead.
 */
function userStep(
  blocks: readonly unknown[],
  id: number,
  at: number,
  refs: readonly AttachmentRef[] | undefined,
  out: Step[],
): void {
  const full = blocks
    .map((block) => String((block as { text?: unknown } | undefined)?.text ?? ""))
    .join("")
    .trim();
  const text = (full.split(ATTACHMENTS_MARK)[0] ?? "").trim();
  if (text === "" || text.startsWith("[onboarding]")) return;
  if (/^\[(relay|message from|reply from|nack from|owner|cron )/.test(full)) {
    out.push({ id, kind: "note", at, text });
    return;
  }
  out.push({
    id,
    kind: "input",
    at,
    text,
    ...(refs !== undefined && refs.length > 0 ? { attachments: [...refs] } : {}),
  });
}

/** A tool call: `message` renders as a visible outgoing note, others as trace steps. */
function callStep(block: unknown, id: number, at: number, results: Map<string, ToolResult>): Step {
  const name = String((block as { name?: unknown }).name ?? "tool");
  if (name !== "message") {
    return toolStep(block, id, at, results.get(String((block as { id?: unknown }).id ?? id)));
  }
  // The initiator's outgoing message is chat, not plumbing: render it as a
  // visible note ("✉ → who") instead of a collapsed trace.
  const args = (block as { arguments?: Record<string, unknown> }).arguments ?? {};
  const to = String(args.to ?? "unknown");
  const messageKind = String(args.kind ?? "notify");
  const topic = args.topic === undefined ? "" : ` • ${String(args.topic)}`;
  const body = String(args.body ?? "").slice(0, 800);
  return { id, kind: "note", at, text: `✉ → ${to} (${messageKind}${topic})\n\n${body}` };
}

function toolStep(block: unknown, id: number, at: number, result: ToolResult | undefined): Step {
  return {
    id,
    kind: "tool",
    at,
    step: {
      callId: String((block as { id?: unknown }).id ?? id),
      name: String((block as { name?: unknown }).name ?? "tool"),
      status: result === undefined ? "running" : result.isError ? "error" : "done",
      input: (block as { arguments?: unknown }).arguments ?? null,
      output: result === undefined ? null : textOf(result.content).trim(),
      durationMs: result === undefined ? null : result.durationMs,
      ...(result?.details === undefined ? {} : { details: result.details }),
    },
  };
}

/** The in-flight generation partial (negative ids) streams before any entry lands. */
function liveSteps(live: LiveState | undefined, out: Step[]): void {
  const partial = live?.generation?.message as
    | { content?: unknown; timestamp?: unknown }
    | undefined;
  if (partial === undefined) return;
  const at = typeof partial.timestamp === "number" ? partial.timestamp : Date.now();
  const blocks = Array.isArray(partial.content) ? (partial.content as readonly unknown[]) : [];
  let partialIndex = 0;
  for (const block of blocks) {
    const id = -1000 - partialIndex++;
    const kind = (block as { type?: string }).type;
    if (kind === "thinking") {
      const text = String((block as { thinking?: unknown }).thinking ?? "");
      if (text !== "") out.push({ id, kind: "thinking", at, text });
    } else if (kind === "text") {
      const text = String((block as { text?: unknown }).text ?? "");
      const last = out[out.length - 1] as Step | undefined;
      // Skip when the settled entry already carries this text (it is a prefix of it):
      // covers the commit/clear overlap without dropping genuine growth.
      if (text !== "" && !(last?.kind === "output" && last.text.startsWith(text))) {
        out.push({ id, kind: "output", at, text, streaming: true });
      }
    } else if (kind === "toolCall") {
      out.push(toolStep(block, id, at, undefined));
    }
  }
}

/** The newest agent text is streaming while the agent works. */
function markStreaming(out: Step[], working: boolean): Step[] {
  if (!working) return out;
  for (let index = out.length - 1; index >= 0; index--) {
    const entry = out[index] as Step;
    if (entry.kind === "output") {
      out[index] = { ...entry, streaming: true };
      break;
    }
    if (entry.kind !== "thinking") break;
  }
  return out;
}

/** Token spend summed over committed assistant messages (pi-ai `Usage`). Tokens only. */
export interface UsageSummary {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Reasoning tokens, when the provider reports them; null when never reported. */
  readonly reasoning: number | null;
  readonly totalTokens: number;
}

/** Sum the usage recorded on each committed assistant message. */
export function usageOf(entries: readonly EntryRecord[]): UsageSummary | undefined {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let totalTokens = 0;
  let reasoning: number | null = null;
  let seen = false;
  for (const entry of entries) {
    for (const message of (entry.model ?? []) as readonly unknown[]) {
      const usage = (message as { usage?: Record<string, unknown> }).usage;
      if (usage === undefined || usage === null) continue;
      seen = true;
      input += Number(usage.input ?? 0);
      output += Number(usage.output ?? 0);
      cacheRead += Number(usage.cacheRead ?? 0);
      totalTokens += Number(usage.totalTokens ?? 0);
      if (typeof usage.reasoning === "number") {
        reasoning = (reasoning ?? 0) + usage.reasoning;
      }
    }
  }
  return seen ? { input, output, cacheRead, reasoning, totalTokens } : undefined;
}

/** Project the conversation view: committed transcript + live partial + phase. */
export function projectTranscript(
  entries: readonly EntryRecord[],
  live: LiveState | undefined,
  working: boolean,
): Step[] {
  const out = committedSteps(entries, toolResultsOf(entries));
  liveSteps(live, out);
  return markStreaming(out, working);
}
