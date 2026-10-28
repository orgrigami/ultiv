/**
 * The Session object's methods over one session's scope: withdraw a queued
 * message, configure model/effort, Stop (interrupt), approvals, and input
 * (steer by default, follow-up, or the explicit Redirect now).
 */
import type { Ctx, Host } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { artifactsDir, readArtifact } from "@ultiv/ext";
import type { SendMode, ThinkingLevel } from "@ultiv/contracts";
import { redirectTurn, stopTurn, type MindService } from "@ultiv/mind";
import type { Principal } from "./identity.ts";
import {
  safeChange,
  settle,
  stopChatTasks,
  type InFlight,
  type SessionCells,
} from "./session-turns.ts";

export type MethodScope = {
  readonly host: Host<Principal>;
  readonly mind: MindService;
  readonly owner: string;
  readonly sessionId: string;
  readonly conversation: Promise<Conversation>;
  readonly conversationId: Promise<string>;
  readonly cells: SessionCells;
  readonly inFlight: InFlight;
};

type C = Ctx<Principal>;

/** withdraw, configure and interrupt (Stop). */
export function controlMethods({ mind, conversation, conversationId, cells }: MethodScope) {
  return {
    withdraw: async ({ id }: { id: string }, ctx: C) => {
      const chat = await conversation;
      const status = await Effect.runPromise(mind.converse.withdraw(chat, id));
      // Whatever the engine says, the chip goes: a withdrawn message left
      // the inbox, and one already placed is part of the turn now.
      safeChange(cells.queued, ctx, (queued) => queued.filter((item) => item.id !== id));
      return { status };
    },
    configure: async (
      { model, effort }: { model: string | null; effort: ThinkingLevel | null },
      ctx: C,
    ) => {
      const chat = await conversation;
      await Effect.runPromise(mind.converse.configure(chat, { model, effort }));
      safeChange(cells.model, ctx, () => model);
      safeChange(cells.effort, ctx, () => effort);
      return { ok: true };
    },
    interrupt: async (input: { tasks?: boolean }, ctx: C) => {
      // Withdraw the queue, abort the turn, deny every waiting approval card.
      await stopTurn(mind.converse, mind.approvals, await conversation);
      const cancelledTasks =
        input.tasks === true ? await stopChatTasks(mind, await conversationId) : 0;
      safeChange(cells.pending, ctx, () => null);
      safeChange(cells.queued, ctx, () => []);
      safeChange(cells.phase, ctx, () => "idle");
      safeChange(cells.lastError, ctx, () => null);
      return { ok: true, cancelledTasks };
    },
  };
}

type ApproveInput = { callId: string; approved: boolean; always?: boolean; takeover?: boolean };

/** Decide a waiting approval card (with "always allow" and "take over"). */
export function approveMethod({ mind, owner, conversationId, cells }: MethodScope) {
  return async ({ callId, approved, always, takeover }: ApproveInput, ctx: C) => {
    const id = await conversationId;
    const waiting = mind.approvals.pendingFor(id).find((r) => r.callId === callId);
    // "Always allow" saves the tool on the profile's autoApprove list;
    // the broker's hook reads policies live, so the next call skips the
    // gate. A failed rule save must not swallow the decision itself, and
    // an EMPTY result (the call stays gated by its pattern) is noted in
    // the audit record so the skipped save is not invisible.
    let stored: string[] | null = null;
    if (approved && always === true && waiting !== undefined) {
      const profile = mind.profiles.profileOf(id);
      if (profile !== undefined) {
        try {
          stored = await mind.profiles.allowTool(owner, profile.id, waiting.name, waiting.input);
        } catch (error) {
          console.warn("always-allow rule save failed:", error);
        }
      }
    }
    const takenOver = !approved && takeover === true;
    mind.approvals.decide(
      id,
      callId,
      approved,
      // "Take over": the owner does this one themselves — the agent is
      // told not to retry, so the turn carries on without nagging.
      takenOver
        ? "the owner is handling this themselves - do not retry; carry on and let them tell you when it is done"
        : undefined,
    );
    const notes = [
      takenOver ? "taken over by the owner" : null,
      stored !== null && stored.length === 0
        ? "always-allow skipped: the call stays gated by its pattern"
        : null,
    ].filter((note) => note !== null);
    mind.audit.record({
      at: Date.now(),
      kind: "approval",
      conversationId: id,
      profile: mind.profiles.profileOf(id)?.id ?? null,
      callId,
      name: waiting?.name ?? null,
      durationMs: null,
      ok: approved,
      error: notes.length === 0 ? null : notes.join("; "),
    });
    safeChange(cells.pending, ctx, () => mind.approvals.pendingFor(id)[0] ?? null);
    return { ok: true, stored: stored ?? null };
  };
}

type InputArgs = { text: string; attachments?: string[]; whenBusy?: SendMode };

/** Owner input: steer by default, follow-up on request, or Redirect now. */
export function inputMethod(scope: MethodScope) {
  const { mind, conversation, cells, inFlight } = scope;
  return async ({ text, attachments, whenBusy }: InputArgs, ctx: C) => {
    inFlight.start();
    cells.phase.change(ctx, () => "working");
    cells.lastError.change(ctx, () => null);
    try {
      // Admit first, in the method: an entry becomes visible through the
      // durable transcript projection only once it is committed to storage.
      const chat = await conversation;
      const content = attachments === undefined ? text : await withAttachments(text, attachments);
      // Redirect now is explicit: stop the running turn at the nearest safe
      // point (its partial stays, marked interrupted), then answer this.
      const submission =
        whenBusy === "redirect"
          ? (await redirectTurn(mind, chat, content)).submission
          : await Effect.runPromise(mind.converse.submit(chat, content, whenBusy ?? "steer"));
      settle({ ...scope, conversation: chat, submission, text });
    } catch (error) {
      inFlight.finish();
      console.error("input failed:", error);
      safeChange(cells.lastError, ctx, () => String(error));
      safeChange(cells.phase, ctx, () => "error");
      throw error;
    }
  };
}

/** The attachment block an input carries: one reference line per artifact id. */
async function withAttachments(text: string, attachments: readonly string[]): Promise<string> {
  const dir = artifactsDir();
  const lines = attachments.map((id) => {
    const found = readArtifact(dir, id);
    if (found === undefined) return `- artifact ${id}: (unknown)`;
    return `- artifact ${found.info.id} "${found.info.name}" (${found.info.mime}): use artifact_read to open it`;
  });
  return `${text}\n\nAttached artifacts:\n${lines.join("\n")}`;
}
