/**
 * Redirect now: the owner's explicit, non-default interrupt. Steer (the
 * default) waits for the next tool boundary; Redirect stops the running turn
 * at the nearest SAFE point and starts a new one with the owner's message.
 *
 * Safe point, given what pi-durable offers (run-task abort, no
 * "stop after this round"):
 * - model streaming, no tool running → abort now; the partial reply stays in
 *   the transcript as an interrupted (stopReason "aborted") assistant message;
 * - a tool round running → let it finish (bounded by a grace period) so a
 *   half-run tool is never cut mid-effect, then abort the next generation;
 *   after the grace, abort anyway (pi-durable records an `aborted` result);
 * - a tool waiting on an approval card → deny the card (as Stop does) so the
 *   tool unwinds with a denial instead of holding the turn.
 * Queued messages stay queued (unlike Stop) and are placed with the redirect.
 */
import type {
  Conversation,
  InputEntry,
  LiveState,
  Submission,
  UserInput,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { ApprovalsService } from "../approvals.ts";
import type { ConverseService } from "./converse.ts";

export type RedirectStep = "submit" | "abort" | "drain" | "deny";

/** Default bound on waiting for a running tool round before aborting it. */
export const REDIRECT_TOOL_GRACE_MS = 15_000;

/** What the redirect does next, from the live run state. Pure. */
export const redirectStep = (
  live: LiveState | undefined,
  approvalsWaiting: number,
  graceLeft: boolean,
): RedirectStep => {
  if (live?.run === undefined) return "submit";
  if (approvalsWaiting > 0) return "deny";
  const running = (live.tools ?? []).some((slot) => slot.status !== "done");
  return running && graceLeft ? "drain" : "abort";
};

export type RedirectDeps = {
  readonly converse: Pick<ConverseService, "liveOf" | "abortRun" | "submit">;
  readonly approvals: Pick<ApprovalsService, "pendingFor" | "decide">;
  readonly graceMs?: number;
  readonly pollMs?: number;
};

export type RedirectResult = {
  readonly submission: Submission;
  /** Whether a running turn was cut (false: the bot was idle or finished meanwhile). */
  readonly interrupted: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Stop the running turn at the nearest safe point, then submit `content` as a new turn. */
export const redirectTurn = async (
  deps: RedirectDeps,
  conversation: Conversation,
  content: UserInput,
  entry?: InputEntry,
): Promise<RedirectResult> => {
  const id = String(conversation.id);
  const deadline = Date.now() + (deps.graceMs ?? REDIRECT_TOOL_GRACE_MS);
  let interrupted = false;
  for (;;) {
    const live = await Effect.runPromise(deps.converse.liveOf(conversation));
    const pending = deps.approvals.pendingFor(id);
    const step = redirectStep(live, pending.length, Date.now() < deadline);
    if (step === "submit") break;
    if (step === "deny") {
      for (const request of pending) {
        deps.approvals.decide(
          id,
          request.callId,
          false,
          "the owner redirected - see their new message",
        );
      }
    } else if (step === "abort") {
      interrupted = (await Effect.runPromise(deps.converse.abortRun(conversation))) === "aborted";
      continue;
    }
    await sleep(deps.pollMs ?? 100);
  }
  // Steer covers a turn some other input started between the abort and now.
  const submission = await Effect.runPromise(
    deps.converse.submit(conversation, content, "steer", undefined, entry),
  );
  return { submission, interrupted };
};
