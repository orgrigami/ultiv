import type { Ctx, Host } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, LiveState } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Effect } from "effect";
import {
  EffortSchema,
  ModelIdSchema,
  Session,
  SessionConversationIdSchema,
  SessionErrorSchema,
  PendingApprovalSchema,
  PhaseSchema,
  QueuedInputSchema,
  TranscriptSchema,
  UsageSummarySchema,
  type ThinkingLevel,
} from "@spreissen/contracts";
import { projectTranscript, usageOf, type MindService } from "@spreissen/mind";
import { ownerOf, type Principal } from "./identity.ts";
import { approveMethod, controlMethods, inputMethod } from "./session-methods.ts";
import { InFlight, queuedOf, safeChange, sameQueue, type SessionCells } from "./session-turns.ts";

/** The `pi.live` conversation doc from a structural view, typed. */
function liveOf(view: ConversationView): LiveState | undefined {
  return view.docs["pi.live"] as LiveState | undefined;
}

type SelfOf = Parameters<Parameters<Host<Principal>["serve"]>[1]>[2];

/** The Session object's state cells, all starting empty (hydration publishes after attach). */
function sessionCells(self: SelfOf): SessionCells {
  return {
    transcript: self.state("transcript", TranscriptSchema, []),
    phase: self.state("phase", PhaseSchema, "idle"),
    lastError: self.state("lastError", SessionErrorSchema, null),
    pending: self.state("pending", PendingApprovalSchema, null),
    usage: self.state("usage", UsageSummarySchema, {
      input: 0,
      output: 0,
      cacheRead: 0,
      reasoning: null,
      totalTokens: 0,
    }),
    model: self.state("model", ModelIdSchema, null),
    effort: self.state("effort", EffortSchema, null),
    conversationId: self.state("conversationId", SessionConversationIdSchema, null),
    queued: self.state("queued", Type.Array(QueuedInputSchema), []),
  };
}

/**
 * Live replay: every committed publication of the durable transcript
 * re-projects the cells, whoever wrote it (turns, tasks, tools). Then the
 * approval poll surfaces tool calls waiting for the owner's decision.
 */
async function hydrate(
  mind: MindService,
  chat: Conversation,
  cells: SessionCells,
  ctx: Ctx<Principal>,
  remember: (view: ConversationView) => void,
): Promise<void> {
  const view = await chat.viewState(BACKGROUND_CONTEXT);
  // Let the client's attach settle before the first hydration publish.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  const apply = (value: ConversationView) => {
    remember(value);
    safeChange(cells.transcript, ctx, () =>
      projectTranscript(value.entries, liveOf(value), cells.phase.value === "working"),
    );
    const usage = usageOf(value.entries);
    if (usage !== undefined) safeChange(cells.usage, ctx, () => usage);
    const queued = queuedOf(value);
    if (!sameQueue(queued, cells.queued.value)) safeChange(cells.queued, ctx, () => queued);
  };
  const unsubscribe = view.subscribe((value) => apply(value));
  if (view.value !== undefined) apply(view.value);
  // Reflect the conversation's durable model/effort selection. Both reads may
  // land after a shutdown closed the harness; a failed read is not an error.
  const selection = await Effect.runPromise(mind.converse.agentOf(chat)).catch(() => undefined);
  if (selection !== undefined) {
    safeChange(cells.model, ctx, () => selection.model);
    safeChange(cells.effort, ctx, () => selection.effort as ThinkingLevel | null);
  }
  safeChange(cells.conversationId, ctx, () => String(chat.id));
  // Detach on abort, or the attached view outlives the object and hangs
  // graceful shutdown (node --watch restarts wait forever).
  ctx.signal.addEventListener("abort", () => unsubscribe(), { once: true });
  const id = String(chat.id);
  while (!ctx.signal.aborted) {
    const [waiting] = mind.approvals.pendingFor(id);
    safeChange(cells.pending, ctx, () =>
      waiting === undefined
        ? null
        : {
            callId: waiting.callId,
            name: waiting.name,
            input: waiting.input,
            reason: waiting.reason ?? null,
          },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/** Registers per-session Session objects: state is a live projection of the durable transcript. */
export function serveSession(host: Host<Principal>, mind: MindService): void {
  host.serve(
    Session,
    (input, principal, self) => {
      const owner = ownerOf(principal);
      // The registry row decides the scope (profile, DM pair); unknown ids
      // land under the default profile — pre-profile ids keep their legacy
      // mapping through keyForSession.
      const conversation = mind.profiles
        .keyForSession(owner, input.id)
        .then((key) => Effect.runPromise(mind.converse.ensure(key)));
      // Sync empty starts: a publication racing the client's subscribe
      // handshake trips chord's ack window over the wire (see AGENTS.md).
      const cells = sessionCells(self);
      const conversationId = conversation.then((chat) => String(chat.id));
      let lastView: ConversationView | undefined;
      self.task(async (ctx) =>
        hydrate(mind, await conversation, cells, ctx, (view) => (lastView = view)),
      );
      // Phase transitions re-project once more, so the streaming flag
      // clears when the turn ends even if no publication followed.
      self.on("reproject", cells.phase, (phase, ctx) => {
        const view = lastView;
        if (view === undefined) return;
        safeChange(cells.transcript, ctx, () =>
          projectTranscript(view.entries, liveOf(view), phase === "working"),
        );
      });
      const scope = {
        host,
        mind,
        owner,
        sessionId: input.id,
        conversation,
        conversationId,
        cells,
        inFlight: new InFlight(),
      };
      return {
        variant: "default",
        ...cells,
        ...controlMethods(scope),
        approve: approveMethod(scope),
        input: inputMethod(scope),
      };
    },
    // Hold the object (and its replay) briefly after the last reference so a
    // navigation mid-turn does not dispose it out from under the background turn.
    { linger: 60_000 },
  );
}
