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
