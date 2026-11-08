/**
 * Background jobs on the local shell backend: the call answers at once with
 * a job id, the result reaches the host once the script ends, the files it
 * wrote are synced into the durable tree, the foreground working directory
 * never moves, and the per-conversation cap holds.
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArtifacts } from "./artifacts.ts";
import { bashPlugin, localShellBackend } from "./bash.ts";
import { JobKiller, MAX_JOBS_PER_CONVERSATION, type BashJob } from "./bash-jobs.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bash-jobs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const rig = (name: string) => {
  const dir = join(scratch, name);
  const started: BashJob[] = [];
  const finished: { job: BashJob; text: string }[] = [];
  const stopped: BashJob[] = [];
  let done!: () => void;
  const settled = new Promise<void>((resolve) => (done = resolve));
  const plugin = bashPlugin({
    root: dir,
    backend: (_d, home) => localShellBackend(home),
    jobs: {
      started: (job) => started.push(job),
      finished: (job, text) => {
        finished.push({ job, text });
        done();
      },
      stopped: (job) => {
        stopped.push(job);
        done();
      },
    },
  });
  const capability = plugin.capabilities.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === "bash",
  );
  if (capability?.kind !== "tool") throw new Error("no bash tool");
  return { dir, bash: capability.tool, started, finished, stopped, settled };
};

const api = { conversationId: "conv-1" } as never;
const text = (reply: { output?: readonly { type: string; text?: string }[] }) =>
  (reply.output ?? []).map((part) => part.text ?? "").join("\n");

describe("bash background jobs", () => {
  it("answers at once and wakes the host with the result; files are synced", async () => {
    const r = rig("one");
    const reply = await r.bash.execute(
      { script: "sleep 0.2\necho built > out.txt\ncd /tmp\necho done", background: true },
      api,
      {} as never,
    );
    expect(text(reply)).toContain("started in the background");
    expect(r.started).toHaveLength(1);
    expect(r.finished).toHaveLength(0);
    await r.settled;
    expect(r.finished[0]?.text).toMatch(/^\[job \S+ finished\] exit 0: sleep 0\.2/);
    expect(r.finished[0]?.text).toContain("done");
    expect(listArtifacts(r.dir).some((info) => info.name === "out.txt")).toBe(true);
    // The job's `cd` never moved the foreground working directory.
    const pwd = await r.bash.execute({ script: "pwd" }, api, {} as never);
    expect(text(pwd)).not.toContain("/tmp");
  });

  it("caps the jobs running at once in one conversation", async () => {
    const r = rig("cap");
    for (let n = 0; n < MAX_JOBS_PER_CONVERSATION; n += 1) {
      const reply = await r.bash.execute(
        { script: "sleep 0.3", background: true },
        api,
        {} as never,
      );
      expect(reply.isError).toBeUndefined();
    }
    const over = await r.bash.execute({ script: "sleep 0.3", background: true }, api, {} as never);
    expect(over.isError).toBe(true);
    expect(text(over)).toContain("already running");
    await r.settled;
  });

  it("is refused where no host wires jobs", async () => {
    const plugin = bashPlugin({
      root: join(scratch, "none"),
      backend: (_d, home) => localShellBackend(home),
    });
    const capability = plugin.capabilities.find((c) => c.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no bash tool");
    const reply = await capability.tool.execute(
      { script: "echo hi", background: true },
      api,
      {} as never,
    );
    expect(reply.isError).toBe(true);
  });

  it("a work-tree stop kills the job and wakes nobody", async () => {
    const killer = new JobKiller();
    const dir = join(scratch, "killed");
    const started: BashJob[] = [];
    const finished: { job: BashJob; text: string }[] = [];
    const stopped: BashJob[] = [];
    let done!: () => void;
    const settled = new Promise<void>((resolve) => (done = resolve));
    const plugin = bashPlugin({
      root: dir,
      backend: (_d, home) => localShellBackend(home),
      jobKiller: killer,
      jobs: {
        started: (job) => started.push(job),
        finished: (job, text) => {
          finished.push({ job, text });
          done();
        },
        stopped: (job) => {
          stopped.push(job);
          done();
        },
      },
    });
    const capability = plugin.capabilities.find((c) => c.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no bash tool");
    const before = Date.now();
    await capability.tool.execute(
      { script: "sleep 30\necho never", background: true },
      api,
      {} as never,
    );
    expect(started).toHaveLength(1);
    expect(killer.killConversations(["conv-1"])).toBe(1);
    await settled;
    // Stopped within seconds (killed), not the 30-minute cap, and the
    // conversation is never woken with a result for cancelled work.
    expect(stopped).toHaveLength(1);
    expect(finished).toHaveLength(0);
    expect(Date.now() - before).toBeLessThan(10_000);
    // A second kill for that conversation finds nothing.
    expect(killer.killConversations(["conv-1"])).toBe(0);
  });
});
