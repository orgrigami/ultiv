/**
 * Background settling of a Session object's admitted inputs. An owner message
 * sent mid-turn steers the running turn (or waits for it, as a follow-up), so
 * several inputs can be in flight at once: the session reads "working" until
 * the last of them settles. A stopped turn or a withdrawn message settles
 * unanswered ("aborted") and is not an error.
 */
import type { Cell, Host } from "@earendil-works/chord";
import { isChordError } from "@earendil-works/chord";
import type {
  Conversation,
  ConversationView,
  InboxState,
  Submission,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type {
  PendingApproval,
  Phase,
  QueuedInput,
  ThinkingLevel,
  TranscriptEntry,
  UsageSummary,
} from "@spreissen/contracts";
import { isStopped, type MindService } from "@spreissen/mind";
import type { Principal } from "./identity.ts";

export type SessionCells = {
  transcript: Cell<TranscriptEntry[]>;
  phase: Cell<Phase>;
  lastError: Cell<string | null>;
  pending: Cell<PendingApproval>;
  usage: Cell<UsageSummary>;
  model: Cell<string | null>;
  effort: Cell<ThinkingLevel | null>;
  conversationId: Cell<string | null>;
  queued: Cell<QueuedInput[]>;
};

/** Cell write that survives object disposal: background turns may outlive the last reference. */
export function safeChange<T>(
  cell: Cell<T>,
  ctx: Parameters<Cell<T>["change"]>[0],
  fn: Parameters<Cell<T>["change"]>[1],
): void {
  try {
    cell.change(ctx, fn);
  } catch (error) {
    console.warn("cell write skipped:", isChordError(error) ? error.code : error);
  }
}

/** How many of this object's inputs are still unsettled; the session goes idle at zero. */
export class InFlight {
  #count = 0;
  start(): void {
    this.#count += 1;
  }
  /** One input settled; true when none is left. */
  finish(): boolean {
    this.#count = Math.max(0, this.#count - 1);
    return this.#count === 0;
  }
}

export type SettleArgs = {
  readonly host: Host<Principal>;
  readonly mind: MindService;
  readonly conversation: Conversation;
  readonly submission: Submission;
  readonly owner: string;
  readonly sessionId: string;
  readonly cells: SessionCells;
  readonly inFlight: InFlight;
  readonly text: string;
};

/** Settles an admitted submission in the background; the transcript projection picks up the turn. */
export function settle(args: SettleArgs): void {
  const { host, mind, conversation, submission, cells, inFlight } = args;
  void host.root(async (ctx) => {
    try {
      const result = await Effect.runPromise(mind.converse.settle(conversation, submission));
      if (result.text.trim() !== "") {
        await mind.profiles.touchSession(args.owner, args.sessionId, {
          at: Date.now(),
          titleSeed: args.text,
        });
      }
      if (inFlight.finish()) safeChange(cells.phase, ctx, () => "idle");
    } catch (error) {
      const last = inFlight.finish();
      if (isStopped(error)) {
        if (last) safeChange(cells.phase, ctx, () => "idle");
        return;
      }
      console.error("agent turn failed:", error);
      safeChange(cells.lastError, ctx, () => String(error));
      safeChange(cells.phase, ctx, () => "error");
    }
  });
}

/** The attachment block `withAttachments` appends; chips show only the typed text. */
const ATTACHMENTS_MARK = "\n\nAttached artifacts:";

/** The plain text of a queued input: a string, or the text blocks of a content array. */
function textOf(content: unknown): string {
  const full =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block: { type?: unknown; text?: unknown }) =>
              block?.type === "text" && typeof block.text === "string" ? block.text : "",
            )
            .join("")
        : "";
  const cut = full.indexOf(ATTACHMENTS_MARK);
  return cut === -1 ? full : full.slice(0, cut);
}

/** Inputs waiting in the engine inbox for the running turn, oldest first (queued writes left out). */
export function queuedOf(view: ConversationView): QueuedInput[] {
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const queued: QueuedInput[] = [];
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") continue;
    queued.push({ id: String(item.id), text: textOf(item.content), mode: item.mode });
  }
  return queued;
}

/** Same queue, same order: skip the publish when nothing changed. */
export function sameQueue(a: readonly QueuedInput[], b: readonly QueuedInput[]): boolean {
  return (
    a.length === b.length && a.every((item, i) => item.id === b[i]?.id && item.mode === b[i]?.mode)
  );
}

/**
 * The chat's Stop, extended to its background tasks: every task this chat
 * spawned that is still running is cancelled quietly (no wake — the owner
 * just stopped this chat). Returns how many were stopped.
 */
export async function stopChatTasks(mind: MindService, conversationId: string): Promise<number> {
  const tasks = await Effect.runPromise(mind.tasks.list());
  let stopped = 0;
  for (const task of tasks) {
    if (task.status !== "running" || task.conversationId !== conversationId) continue;
    if (await Effect.runPromise(mind.tasks.cancel(task.id, { quiet: true }))) stopped += 1;
  }
  return stopped;
}
