/**
 * One exec on the node, against a real `/bin/bash`: the answer comes when
 * bash exits even while a background job holds the pipes, a timeout kills
 * the whole process group (nothing the script started survives) and still
 * answers with the partial output and exit 124, kill() does the same for a
 * cancel, the pairing token never reaches the script's environment or the
 * answer, and UTF-8 survives chunk borders.
 */
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { runScript, scriptEnv, scrub } from "./run-script.ts";

const cwd = tmpdir();
const marker = (): string =>
  `spriessen-probe-${process.pid}-${Math.random().toString(36).slice(2)}`;

/** Is a `sleep <seconds>` with this marker in its environment still running? */
const survivors = (tag: string): number => {
  const out = execFileSync("/bin/bash", [
    "-c",
    `grep -l ${tag} /proc/[0-9]*/environ 2>/dev/null | wc -l`,
  ]);
  return Number(String(out).trim());
};

describe("runScript", () => {
  it("answers when bash exits, not when a background job lets go of the pipes", async () => {
    const tag = marker();
    const started = Date.now();
    const run = runScript({ script: `TAG=${tag} sleep 5 & echo started`, cwd, timeoutMs: 10_000 });
    const result = await run.result;
    expect(result.stdout).toBe("started\n");
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    run.kill(); // the background job ends with the group
  });

  it("a timeout kills the whole group and still answers with partial output", async () => {
    const tag = marker();
    const run = runScript({
      script: `echo partial; export TAG=${tag}; sleep 30 & sleep 30; true`,
      cwd,
      timeoutMs: 300,
    });
    const result = await run.result;
    expect(result.stdout).toBe("partial\n");
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("killed after 300ms");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(survivors(tag)).toBe(0);
  });

  it("kill() ends every process the script started", async () => {
    const tag = marker();
    const run = runScript({ script: `export TAG=${tag}; sleep 30; true`, cwd, timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    run.kill();
    await run.result;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(survivors(tag)).toBe(0);
  });

  it("never hands the pairing token to the script or back in the answer", async () => {
    process.env["SPRIESSEN_NODE_TOKEN"] = "tok-0123456789abcdef";
    try {
      const run = runScript({
        script: 'echo "env=${SPRIESSEN_NODE_TOKEN:-none}"; echo tok-0123456789abcdef >&2',
        cwd,
        timeoutMs: 5_000,
        secret: "tok-0123456789abcdef",
      });
      const result = await run.result;
      expect(result.stdout).toBe("env=none\n");
      expect(result.stderr).toBe("[redacted]\n");
    } finally {
      delete process.env["SPRIESSEN_NODE_TOKEN"];
    }
  });

  it("decodes UTF-8 split across chunks", async () => {
    // 3-byte characters, written one byte at a time with pauses between.
    const run = runScript({
      script: 'for b in e2 82 ac e2 82 ac; do printf "\\x$b"; sleep 0.02; done',
      cwd,
      timeoutMs: 5_000,
    });
    expect((await run.result).stdout).toBe("€€");
  });

  it("scriptEnv drops the agent's own keys; scrub ignores tiny secrets", () => {
    const env = scriptEnv({
      PATH: "/bin",
      SPRIESSEN_NODE_TOKEN: "x",
      SPRIESSEN_NODE_TOKEN_FILE: "y",
    });
    expect(env).toEqual({ PATH: "/bin" });
    expect(scrub("a short b", "short")).toBe("a short b");
    expect(scrub("x 12345678 y", "12345678")).toBe("x [redacted] y");
  });
});
