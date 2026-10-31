/**
 * Turn deadlines (D4): a model call that sends nothing, or a turn that runs
 * too long, ends with a visible note instead of a silent hang.
 *
 * - First token: each model request must stream something (text, reasoning
 *   or a tool call) within `firstTokenMs` (default 60 s). Each request of a
 *   turn gets its own window (a turn makes one request per tool round), and
 *   so does each durable retry attempt.
 * - Whole turn: a run, from its first request to its answer, ends after
 *   `turnMs` (default 15 min). Time a tool spends waiting on an approval card
 *   does not count: the approval has its own timeout.
 *
 * Both are per bot (`policies.firstTokenDeadlineSec`, `policies.turnDeadlineMin`;
 * null or absent = the defaults) so a slow reasoning model can get more room.
 *
 * A hit aborts the run the way Redirect now does (the partial reply stays,
 * marked interrupted; queued messages stay queued, never auto-sent), then
 * writes a passive notice entry the transcript shows as a note. The abort is
 * not a model error, so pi-durable's retry policy never retries it: the
 * deadline is the real bound. The watcher starts from a `beforeRequest`
 * hook, so every model request (chat, task, routine, mailbox, a run that
 * recovered after a restart) is covered without touching the submit paths.
 */
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Conversation, LiveState } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { ProfilePolicies } from "@spreissen/contracts";
import type { ConverseService } from "./converse.ts";

/** D4 defaults. */
export const DEFAULT_FIRST_TOKEN_MS = 60_000;
export const DEFAULT_TURN_MS = 15 * 60_000;

/** Per-bot bounds the profile patch accepts (seconds / minutes). */
export const DEADLINE_BOUNDS = {
  firstTokenSec: { min: 10, max: 1_800 },
  turnMin: { min: 1, max: 720 },
} as const;

/** The passive entry a deadline hit writes (stored kinds keep the `ultiv.` prefix). */
export const TURN_NOTICE_KIND = "ultiv.turn-notice";

export type DeadlineLimits = { readonly firstTokenMs: number; readonly turnMs: number };

export type DeadlineHit = { readonly kind: "first-token" | "turn"; readonly limitMs: number };

/** What the watcher remembers about one conversation's current run. */
export type DeadlineTrack = {
  /** The run's identity: its first input submission (stable across tool rounds). */
  readonly run: string;
  /** When the run's clock started, shifted forward by paused (approval) time. */
  readonly runAt: number;
  /** The request attempt waiting for its first token, if any. */
  readonly request: string | undefined;
  readonly requestAt: number;
  readonly lastAt: number;
};

/** A bot's limits from its policies; absent or null fields mean the defaults. */
export const limitsOf = (
  policies: Pick<ProfilePolicies, "firstTokenDeadlineSec" | "turnDeadlineMin"> | undefined,
): DeadlineLimits => ({
  firstTokenMs:
    typeof policies?.firstTokenDeadlineSec === "number"
      ? policies.firstTokenDeadlineSec * 1_000
      : DEFAULT_FIRST_TOKEN_MS,
  turnMs:
    typeof policies?.turnDeadlineMin === "number"
      ? policies.turnDeadlineMin * 60_000
      : DEFAULT_TURN_MS,
});

/**
 * One watcher tick, pure: the next track and a hit when a deadline passed.
 * `paused` (an approval card is waiting) stops both clocks for that tick.
 */
export const deadlineStep = (
  track: DeadlineTrack | undefined,
  live: LiveState | undefined,
  now: number,
  limits: DeadlineLimits,
  paused: boolean,
): { readonly track: DeadlineTrack | undefined; readonly hit?: DeadlineHit } => {
  const run = live?.run;
  if (run === undefined) return { track: undefined };
  const runKey = String(run.inputs[0] ?? `task:${String(run.taskId)}`);
  const same = track !== undefined && track.run === runKey;
  const shift = same && paused ? now - track.lastAt : 0;
  const runAt = same ? track.runAt + shift : now;
  let request = same ? track.request : undefined;
  let requestAt = same ? track.requestAt + shift : now;
  const generation = live?.generation;
  // Waiting on a first token: a request is out and nothing has streamed yet
  // (a durable retry's backoff sleep and a deferred poll are not waits).
  const waiting =
    generation !== undefined &&
    generation.message === undefined &&
    generation.retry === undefined &&
    generation.deferred === undefined;
  if (waiting) {
    const key = `${String(run.taskId)}:${String(generation.attempt)}`;
    if (request !== key) {
      request = key;
      requestAt = now;
    }
  } else request = undefined;
  const next: DeadlineTrack = { run: runKey, runAt, request, requestAt, lastAt: now };
  if (waiting && now - requestAt >= limits.firstTokenMs) {
    return { track: next, hit: { kind: "first-token", limitMs: limits.firstTokenMs } };
  }
  if (now - runAt >= limits.turnMs) {
    return { track: next, hit: { kind: "turn", limitMs: limits.turnMs } };
  }
  return { track: next };
};

const spoken = (ms: number): string => {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round(ms / 1_000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

/** The note a hit leaves in the chat. */
export const noticeText = (hit: DeadlineHit): string =>
  hit.kind === "first-token"
    ? `⚠ Stopped: the model sent nothing for ${spoken(hit.limitMs)} (first-reply deadline). ` +
      "Send the message again to retry, or give this bot more time in its settings."
    : `⚠ Stopped: this turn ran longer than ${spoken(hit.limitMs)} (turn deadline). ` +
      "Anything it finished is kept above. Send a message to continue, or give this bot " +
      "more time in its settings.";

export type DeadlineDeps = {
  readonly converse: Pick<ConverseService, "open" | "liveOf" | "abortRun" | "write">;
  /** The conversation's bot limits (the defaults when it has no bot). */
  readonly limitsFor: (conversationId: string) => DeadlineLimits;
  /** True while the conversation has an approval card waiting on the owner. */
  readonly paused?: (conversationId: string) => boolean;
  readonly pollMs?: number;
  readonly now?: () => number;
  /** Told about every hit, after the notice landed (logs, audit). */
  readonly onHit?: (conversationId: string, hit: DeadlineHit) => void;
};

export interface TurnDeadlines {
  /** Start watching a conversation's runs; a no-op while it is already watched. */
  readonly watch: (conversationId: string) => void;
  /** Conversations being watched right now (tests). */
  readonly watching: () => readonly string[];
  readonly stop: () => void;
}

const DEFAULT_POLL_MS = 1_000;

/** Watches each conversation while it has a run; stops by itself once it is idle. */
export const turnDeadlines = (deps: DeadlineDeps): TurnDeadlines => {
  // Each watched conversation's wake-up: stop() resolves the pending sleeps.
  const active = new Map<string, (() => void) | null>();
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  let stopped = false;

  const enforce = async (conversation: Conversation, hit: DeadlineHit): Promise<void> => {
    const id = String(conversation.id);
    await Effect.runPromise(deps.converse.abortRun(conversation));
    await Effect.runPromise(
      deps.converse.write(conversation, TURN_NOTICE_KIND, {
        reason: hit.kind,
        limitMs: hit.limitMs,
        at: now(),
        text: noticeText(hit),
      }),
    );
    deps.onHit?.(id, hit);
  };

  const loop = async (id: string): Promise<void> => {
    const conversation = await Effect.runPromise(deps.converse.open(id));
    if (conversation === undefined) return;
    let track: DeadlineTrack | undefined;
    let idleTicks = 0;
    // Two idle reads in a row end the watch: a run can hand over between them.
    while (!stopped && idleTicks < 2) {
      const live = await Effect.runPromise(deps.converse.liveOf(conversation));
      const step = deadlineStep(track, live, now(), deps.limitsFor(id), deps.paused?.(id) ?? false);
      track = step.track;
      idleTicks = live?.run === undefined ? idleTicks + 1 : 0;
      if (step.hit !== undefined) {
        await enforce(conversation, step.hit);
        track = undefined;
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
        active.set(id, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  return {
    watch: (id) => {
      if (stopped || active.has(id)) return;
      active.set(id, null);
      void loop(id)
        .catch((cause) => console.error("turn deadline watch failed:", cause))
        .finally(() => active.delete(id));
    },
    watching: () => [...active.keys()],
    stop: () => {
      stopped = true;
      for (const wake of active.values()) wake?.();
    },
  };
};

/** The registry extension that starts the watch at every model request. */
export const deadlinesExtension = (deadlines: TurnDeadlines) =>
  defineExtension({
    name: "ultius.mind.deadlines",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (_request, api) => {
          deadlines.watch(String(api.conversationId));
          return undefined;
        },
      }),
    ],
  });
