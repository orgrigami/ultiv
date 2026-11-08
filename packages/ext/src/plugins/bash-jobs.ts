/**
 * Background shell jobs: `bash` with `background: true` answers at once with
 * a job id while the script keeps running (the exec continues in-process; it
 * is not detached inside the VM, so nothing outlives the server's own
 * view of it). When it ends, the host (the mind) wakes the conversation with
 * the result, so a long build or test run never holds the bot's turn and the
 * owner's next message is read at the next step instead of after the command.
 * A restart ends every job; the host tells each conversation its job was
 * lost and to check what it changed before running it again.
 *
 * Rules: at most MAX_JOBS_PER_CONVERSATION at once, each capped at
 * JOB_TIMEOUT_MS; a background job never moves the foreground working
 * directory; while a job runs in a VM workspace, a call that would reload
 * that workspace (files changed outside the VM) waits its turn by refusing,
 * so the reload can never wipe the job's files under it.
 */
import { randomUUID } from "node:crypto";
import type { BashTarget } from "@spriessen/contracts";

export const MAX_JOBS_PER_CONVERSATION = 3;
export const JOB_TIMEOUT_MS = 30 * 60_000;
/** Output a job's wake carries; the rest stays in the job's files. */
const WAKE_OUTPUT_CHARS = 4_000;

export type BashJob = {
  readonly id: string;
  readonly conversationId: string;
  readonly target: BashTarget;
  /** The script's first line, for the owner's eyes. */
  readonly title: string;
  readonly startedAt: number;
};

/** What the mind does with jobs: keep a durable record, and wake on the result. */
export interface BashJobHost {
  /** A job started (recorded durably so a restart can report it lost). */
  readonly started: (job: BashJob) => void;
  /** A job ended: wake its conversation with this text, once. */
  readonly finished: (job: BashJob, text: string) => void;
  /**
   * A job was STOPPED with its conversation's work tree: its record is
   * cleared and NOTHING is woken — a result for work the owner cancelled
   * would start a new turn on a stopped conversation.
   */
  readonly stopped: (job: BashJob) => void;
}

/** A background job's stop handle: its abort signal, and whether the stop was a kill. */
export interface TrackedJob {
  readonly signal: AbortSignal;
  /** True exactly once after a kill took the job (the finished wake is suppressed). */
  readonly cancelled: () => boolean;
}

/**
 * Kill switch for background jobs, shared between the bash plugin (which
 * tracks each job's abort signal) and the work-tree stop (which kills every
 * job a stopped conversation started). The processes die where the runtime
 * allows; everywhere else the 30-minute cap bounds them and the wake is
 * suppressed either way.
 */
export class JobKiller {
  private readonly jobs = new Map<
    string,
    { readonly job: BashJob; readonly control: AbortController; killed: boolean }
  >();

  /** Track one starting job; pass `tracked.signal` into its exec. */
  track(job: BashJob): TrackedJob {
    const entry = { job, control: new AbortController(), killed: false };
    this.jobs.set(job.id, entry);
    return {
      signal: entry.control.signal,
      cancelled: () => entry.killed,
    };
  }

  /** Forget a finished job (its exec settled on its own). */
  release(jobId: string): void {
    this.jobs.delete(jobId);
  }

  /** Kill every job started by these conversations; how many were killed. */
  killConversations(conversations: readonly string[]): number {
    const ids = new Set(conversations);
    let killed = 0;
    for (const [id, entry] of this.jobs) {
      if (!ids.has(entry.job.conversationId)) continue;
      entry.killed = true;
      entry.control.abort();
      this.jobs.delete(id);
      killed += 1;
    }
    return killed;
  }
}

/** Running jobs by conversation, and by VM workspace dir. */
export class JobBoard {
  private readonly byConversation = new Map<string, Set<string>>();
  private readonly byDir = new Map<string, number>();

  count(conversationId: string): number {
    return this.byConversation.get(conversationId)?.size ?? 0;
  }

  /** Jobs running in this VM workspace now. */
  inDir(dir: string): number {
    return this.byDir.get(dir) ?? 0;
  }

  add(job: BashJob, dir: string | null): void {
    const set = this.byConversation.get(job.conversationId) ?? new Set<string>();
    set.add(job.id);
    this.byConversation.set(job.conversationId, set);
    if (dir !== null) this.byDir.set(dir, (this.byDir.get(dir) ?? 0) + 1);
  }

  remove(job: BashJob, dir: string | null): void {
    const set = this.byConversation.get(job.conversationId);
    set?.delete(job.id);
    if (set?.size === 0) this.byConversation.delete(job.conversationId);
    if (dir !== null) {
      const left = (this.byDir.get(dir) ?? 1) - 1;
      if (left > 0) this.byDir.set(dir, left);
      else this.byDir.delete(dir);
    }
  }
}

export const newJob = (conversationId: string, target: BashTarget, script: string): BashJob => {
  const first = script.split("\n").find((line) => line.trim() !== "") ?? "";
  return {
    id: randomUUID().slice(0, 8),
    conversationId,
    target,
    title: first.trim().slice(0, 80),
    startedAt: Date.now(),
  };
};

/** The wake a finished job sends its conversation: a bracketed, automated input. */
export const jobFinishedText = (job: BashJob, output: string, exitCode: number): string => {
  const body =
    output.length > WAKE_OUTPUT_CHARS
      ? `${output.slice(0, WAKE_OUTPUT_CHARS)}\n… [truncated ${output.length - WAKE_OUTPUT_CHARS} chars]`
      : output;
  return `[job ${job.id} finished] exit ${exitCode}: ${job.title}\n\n${body}`;
};

/** The wake for a job a restart cut off (its result is unknown). */
export const jobLostText = (job: Pick<BashJob, "id" | "title">): string =>
  `[job ${job.id} lost] ${job.title}\n\nThe server restarted while this background job ran, so ` +
  "its result is unknown. Check what it changed before running it again.";

/** The tool's immediate answer to a background call. */
export const jobStartedReply = (job: BashJob) => ({
  output: [
    {
      type: "text" as const,
      text:
        `job ${job.id} started in the background (up to ${JOB_TIMEOUT_MS / 60_000} min). ` +
        "Keep working or end your turn: you are woken with its result. Do not poll it.",
    },
  ],
  structuredOutput: { stdout: "", stderr: "", exitCode: 0, target: job.target, job: job.id },
});

export const tooManyJobs = () => ({
  output: [
    {
      type: "text" as const,
      text:
        `not started: ${MAX_JOBS_PER_CONVERSATION} background jobs are already running here. ` +
        "Wait for one to finish (you are woken when it does).",
    },
  ],
  isError: true as const,
});

export const jobsUnavailable = () => ({
  output: [
    {
      type: "text" as const,
      text: "not started: background jobs are not available here; run it in the foreground.",
    },
  ],
  isError: true as const,
});

/** A foreground call that would reload a VM workspace a job is still using. */
export const reloadWhileJob = () => ({
  output: [
    {
      type: "text" as const,
      text:
        "not run: files in your workspace changed outside the VM while a background job is " +
        "still running there, and reloading now could wipe its work. Wait for the job to " +
        "finish (you are woken when it does), then run this again.",
    },
  ],
  isError: true as const,
});
