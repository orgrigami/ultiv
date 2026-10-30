/**
 * Approval broker between gated tool executions (harness background) and the
 * surface that shows them to the user. Keyed by conversation id — both sides
 * know it: tools get it from `ToolExecutionApi`, the object from the
 * conversation it created.
 *
 * Placement rule: approval gates ACTS, never ASKS. A tool that only consults
 * or computes (Jev scores, picks, ratings; search; fetch) is a READ — gating
 * it interrupts the loop while protecting nothing, because the act that uses
 * the result stays ungated. Wrap the side-effecting tool (send, write, pay,
 * delete) with `withApproval` instead; leave reads clean.
 */
import { Context, Deferred, Duration, Effect, Exit, Layer } from "effect";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import type { ProfileApprovalMode } from "@ultiv/contracts";

export interface ApprovalRequest {
  readonly callId: string;
  readonly name: string;
  /** What the tool is for (its registration description) — context for the judges. */
  readonly description?: string;
  readonly input: unknown;
}

/** The adjudication helper's verdict: the gate's outcome for one call. */
export type Adjudication = "approve" | "deny" | "human";

/**
 * Jev-as-gate thresholds: a probability this sure approves, this doubtful
 * denies, and anything between is handed back to the owner (pending path).
 */
export const APPROVE_AT = 0.8;
export const DENY_BELOW = 0.2;

/**
 * Pure gate: given the profile's approval mode, whether the Decide faculty is
 * configured, and Jev's probability, who answers the gate. 'yolo' never
 * reaches here (autoApprove already returned), 'manual' and an unavailable
 * faculty are always the owner's call.
 */
export const adjudicationOf = (
  mode: ProfileApprovalMode,
  decideAvailable: boolean,
  probability: number,
): Adjudication => {
  if (mode !== "jev" || !decideAvailable) return "human";
  if (probability >= APPROVE_AT) return "approve";
  if (probability < DENY_BELOW) return "deny";
  return "human";
};

/**
 * How long the gate waits for the adjudicate hook (Jev) before giving up and
 * parking the normal owner card. No card is pending during the call, so this
 * is what keeps a hung judge from stalling the gate.
 */
export const ADJUDICATE_TIMEOUT = Duration.seconds(8);

/** The verdict an adjudicate hook returns: approve, deny, or — with neither — an opinion the owner's card shows. */
export interface AdjudicationVerdict {
  /** undefined = no decision (the opinion in `note` rides the pending card); true/false decide outright. */
  readonly approved?: boolean;
  /** A deny note (via `noteFor`) or, with no decision, the reason the owner is being asked. */
  readonly note?: string;
}

/** Late-wired policy hooks: per-profile auto-approve, Jev adjudication, timeout escalation. */
export interface ApprovalsHooks {
  /** Return true to approve without waiting (policies.autoApprove). */
  readonly autoApprove?: (conversationId: string, request: ApprovalRequest) => boolean;
  /**
   * Ask a delegated judge (Jev) before parking the gate. True approves, false
   * denies immediately (the note rides `noteFor` to the tool's denial
   * message), undefined falls through to the owner-pending path. A failure is
   * treated as no verdict.
   */
  readonly adjudicate?: (
    conversationId: string,
    request: ApprovalRequest,
  ) => Effect.Effect<AdjudicationVerdict | undefined, unknown>;
  /** Called when the wait timed out (policies.approvalTimeout escalation). */
  readonly onExpire?: (conversationId: string, request: ApprovalRequest) => void;
  /**
   * Asked once when a call parks on the owner: returns the one-line reason the
   * approval card shows (why the bot is doing this). Optional and best-effort —
   * a failure or slowness just means a card without a reason.
   */
  readonly describe?: (
    conversationId: string,
    request: ApprovalRequest,
  ) => Promise<string | undefined>;
}

/** A call parked on the owner; `reason` fills in async (Jev's opinion, then the model's). */
interface PendingEntry {
  readonly conversationId: string;
  readonly request: ApprovalRequest;
  reason?: string;
}

/** What surfaces read: the waiting call plus whatever reason is known. */
export type PendingCall = ApprovalRequest & { readonly reason?: string };

/** Options a gated tool may pass with its request. */
export interface RequestOptions {
  /** The wait before the call auto-denies; the default suits one-click cards. */
  readonly timeout?: Duration.Duration;
  /**
   * The owner answers this one, whatever the profile says: auto-approve rules
   * and the Jev judge are skipped. For acts that mint new actors (a bot
   * creating a bot): delegation must not decide its own scope.
   */
  readonly owner?: boolean;
}

export interface ApprovalsService {
  /**
   * Called by a gated tool: resolves once the user decides (or the timeout
   * denies). `timeout` overrides the default wait (secure inputs need longer).
   */
  readonly request: (
    conversationId: string,
    callId: string,
    request: ApprovalRequest,
    options?: RequestOptions,
  ) => Effect.Effect<boolean>;
  /**
   * Called by the surface's `approve` method with the user's decision. An
   * optional `note` (a takeover, a reason) rides along and surfaces in the
   * tool's denial message via `noteFor`. An `override` (an editable card's
   * corrected input) rides an approval and replaces the proposed arguments,
   * for tools wrapped with `editable` (see `withApproval`).
   */
  readonly decide: (
    conversationId: string,
    callId: string,
    approved: boolean,
    note?: string,
    override?: unknown,
  ) => void;
  /** The decision note for this call, if any — read-once (the tool consumes it). */
  readonly noteFor: (conversationId: string, callId: string) => string | undefined;
  /** The corrected input an editable card was approved with, if any; read-once. */
  readonly overrideFor: (conversationId: string, callId: string) => unknown | undefined;
  /** Snapshot of what is waiting for this conversation (empty: nothing). */
  readonly pendingFor: (conversationId: string) => readonly PendingCall[];
  /** Every pending approval across conversations — the cross-profile inbox. */
  readonly pendingAll: () => ReadonlyArray<PendingEntry>;
  /**
   * Hear every gate that actually waits on the owner (auto-approved calls
   * never fire). Returns the unsubscribe. The push notifier rides this.
   */
  readonly listen: (fn: (conversationId: string, request: ApprovalRequest) => void) => () => void;
  /** Wire the policy hooks (called once profiles exist). */
  readonly setHooks: (hooks: ApprovalsHooks) => void;
}

export class Approvals extends Context.Service<Approvals, ApprovalsService>()(
  "ultiv/mind/Approvals",
) {}

export const makeApprovals = (
  timeout: Duration.Duration = Duration.seconds(120),
  adjudicateTimeout: Duration.Duration = ADJUDICATE_TIMEOUT,
): ApprovalsService => {
  const pending = new Map<string, PendingEntry>();
  const waiters = new Map<string, Deferred.Deferred<boolean>>();
  const notes = new Map<string, string>();
  const overrides = new Map<string, unknown>();
  let hooks: ApprovalsHooks = {};
  const listeners = new Set<(conversationId: string, request: ApprovalRequest) => void>();
  const key = (conversationId: string, callId: string): string => `${conversationId}:${callId}`;
  const settle = (k: string, approved: boolean): void => {
    const waiter = waiters.get(k);
    if (waiter === undefined) return;
    waiters.delete(k);
    pending.delete(k);
    Deferred.doneUnsafe(waiter, Effect.succeed(approved));
  };
  return {
    listen: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setHooks: (next) => {
      hooks = next;
    },
    request: (conversationId, callId, request, options) =>
      Effect.gen(function* () {
        let opinion: string | undefined;
        const k = key(conversationId, callId);
        notes.delete(k); // a stale note must not leak into this call's denial
        overrides.delete(k);
        // An owner-only gate skips the hooks entirely: delegation never
        // answers an act that mints actors.
        if (options?.owner !== true && hooks.autoApprove?.(conversationId, request) === true) {
          return true;
        }
        if (options?.owner !== true && hooks.adjudicate !== undefined) {
          // A failing or slow judge is no verdict: fall through to the owner.
          const judged = hooks
            .adjudicate(conversationId, request)
            .pipe(Effect.timeout(adjudicateTimeout));
          const verdict = yield* Effect.match(judged, {
            onFailure: () => undefined,
            onSuccess: (found) => found,
          });
          if (verdict !== undefined) {
            if (verdict.approved === true) return true;
            // Denied by the judge: no pending entry, the note rides noteFor.
            if (verdict.approved === false) {
              if (verdict.note !== undefined) notes.set(k, verdict.note);
              return false;
            }
            // No decision, just an opinion: park, and let the card show it.
            opinion = verdict.note;
          }
        }
        const deferred = yield* Deferred.make<boolean>();
        const entry: PendingEntry = {
          conversationId,
          request,
          ...(opinion !== undefined ? { reason: opinion } : {}),
        };
        pending.set(k, entry);
        waiters.set(k, deferred);
        for (const fn of listeners) fn(conversationId, request);
        // The card's reason fills in async: the poll loops re-read pendingFor,
        // so the model's one-liner lands on the card as soon as it exists.
        if (hooks.describe !== undefined && entry.reason === undefined) {
          void hooks
            .describe(conversationId, request)
            .then((reason) => {
              if (pending.get(k) === entry && reason !== undefined) entry.reason = reason;
            })
            .catch(() => {});
        }
        const exit = yield* Effect.exit(
          Deferred.await(deferred).pipe(Effect.timeout(options?.timeout ?? timeout)),
        );
        if (Exit.isFailure(exit)) hooks.onExpire?.(conversationId, request);
        settle(k, Exit.isSuccess(exit));
        return Exit.isSuccess(exit) ? exit.value : false;
      }),
    decide: (conversationId, callId, approved, note, override) => {
      const k = key(conversationId, callId);
      if (note !== undefined && !approved) notes.set(k, note);
      // An override only ever rides an approval, and is stored before the
      // waiter wakes so the tool reads it as soon as the gate opens.
      if (approved && override !== undefined) overrides.set(k, override);
      settle(k, approved);
    },
    noteFor: (conversationId, callId) => {
      const k = key(conversationId, callId);
      const note = notes.get(k);
      notes.delete(k);
      return note;
    },
    overrideFor: (conversationId, callId) => {
      const k = key(conversationId, callId);
      const override = overrides.get(k);
      overrides.delete(k);
      return override;
    },
    pendingFor: (conversationId) => {
      const prefix = `${conversationId}:`;
      return [...pending]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, entry]) => ({
          ...entry.request,
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        }));
    },
    pendingAll: () => [...pending.values()],
  };
};

export const approvalsLayer: Layer.Layer<Approvals> = Layer.succeed(Approvals, makeApprovals());

/** Options a gated tool passes its gate: who answers, and how flexible the card is. */
export interface ApprovalOptions {
  /** Park on the owner every time (skip auto-approve and the Jev judge). */
  readonly owner?: boolean;
  /**
   * The card may come back with a corrected input: an approval whose override
   * replaces the proposed arguments wholesale. Only for tools whose whole
   * input is owner-shaped (a form); never for commands or URLs a model
   * authored, where a swap would approve one thing and run another.
   */
  readonly editable?: boolean;
  /**
   * Refused before any card: return the reason, or undefined to proceed to
   * the gate. A refusal is final for the call: no wait, no owner round-trip.
   */
  readonly guard?: (
    args: unknown,
    api: unknown,
    context: unknown,
  ) => string | undefined | Promise<string | undefined>;
  /** The wait before the parked call auto-denies; the default suits one-click cards. */
  readonly timeout?: Duration.Duration;
}

/**
 * Wrap a side-effecting tool so its execution waits for the user's approval
 * first. This is the ONLY way a tool should gate: one seam, applied at the
 * act. Reads must not be wrapped.
 */
export const withApproval = <TParameters extends TSchema>(
  approvals: ApprovalsService,
  tool: ToolRegistration<TParameters>,
  options?: ApprovalOptions,
): ToolRegistration<TParameters> => ({
  ...tool,
  execute: async (args, api, context) => {
    const conversationId = String(api.conversationId);
    const refused = await options?.guard?.(args, api, context);
    if (refused !== undefined) return textResult(refused);
    const approved = await Effect.runPromise(
      approvals.request(
        conversationId,
        api.callId,
        {
          callId: api.callId,
          name: tool.name,
          ...(tool.description !== "" ? { description: tool.description } : {}),
          input: args,
        },
        {
          ...(options?.owner === true ? { owner: true } : {}),
          ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        },
      ),
    );
    if (!approved) {
      const note = approvals.noteFor(conversationId, api.callId);
      return textResult(
        note ??
          "not approved (the owner denied it, stopped the turn, or did not answer in time) — do not retry; tell the owner what was not done",
      );
    }
    // An editable card may return the input as the owner corrected it; it
    // replaces the proposal wholesale, so the tool validates it like any call.
    const override =
      options?.editable === true ? approvals.overrideFor(conversationId, api.callId) : undefined;
    return tool.execute((override ?? args) as typeof args, api, context);
  },
});

const textResult = (text: string) => ({
  isError: true as const,
  output: [{ type: "text" as const, text }],
});
