import { describe, expect, it, afterAll } from "vite-plus/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashPlugin, localShellBackend } from "./bash.ts";
import { listArtifacts, readArtifact } from "../plugins/artifacts.ts";

const dir = mkdtempSync(join(tmpdir(), "spreissen-bash-"));
const api = { conversationId: "conv-1" } as never;

const toolOf = (plugin: ReturnType<typeof bashPlugin>, name: string) => {
  const capability = plugin.capabilities.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === name,
  );
  if (capability?.kind !== "tool") throw new Error(`missing ${name} tool`);
  return capability.tool;
};

const wrap = (dir: string) =>
  bashPlugin({ root: dir, backend: (_d, home) => localShellBackend(home) });

describe("bash tool (durable workspace, shell backend)", () => {
  it("runs scripts, persists files as artifacts, and carries cwd", async () => {
    const plugin = wrap(dir);
    const bash = toolOf(plugin, "bash");
    expect(bash.gated).toBe(true);

    const write = await bash.execute(
      { script: 'echo "hello durable" > greeting.txt && mkdir -p src && date > src/when.txt' },
      api,
      {} as never,
    );
    expect(write.isError).toBeUndefined();

    // The file is a real artifact in the store.
    const list = listArtifacts(dir);
    const greeting = list.find((info) => info.name === "greeting.txt");
    expect(greeting).toBeDefined();
    const found = readArtifact(dir, (greeting as { id: string }).id);
    expect(found?.text.trim()).toBe("hello durable");

    // A SECOND tool call — and a fresh plugin — sees the files.
    const read = await bash.execute({ script: "cat greeting.txt" }, api, {} as never);
    expect(read.structuredOutput).toMatchObject({ stdout: "hello durable\n", exitCode: 0 });

    const reborn = wrap(dir);
    const again = await toolOf(reborn, "bash").execute(
      { script: "cat greeting.txt" },
      api,
      {} as never,
    );
    expect(again.structuredOutput).toMatchObject({ stdout: "hello durable\n" });

    // cd carries over between calls on the same session.
    await bash.execute({ script: "cd src" }, api, {} as never);
    const pwd = await bash.execute({ script: "pwd" }, api, {} as never);
    expect(pwd.structuredOutput).toMatchObject({ stdout: "/home/src\n" });
  });

  it("reports failures as errors and truncates huge output", async () => {
    const plugin = wrap(dir);
    const bash = toolOf(plugin, "bash");
    const missing = await bash.execute({ script: "cat /nope.txt" }, api, {} as never);
    // A failing COMMAND is not a failing tool: the exit code and stderr carry it.
    expect(missing.isError).toBeUndefined();
    expect(missing.structuredOutput).toMatchObject({ exitCode: 1 });
    expect(((missing.output ?? [])[0] as { text: string }).text).toContain("stderr");

    const big = await bash.execute({ script: "seq 1 100000" }, api, {} as never);
    expect(big.isError).toBeUndefined();
    const text = ((big.output ?? [])[0] as { text: string }).text;
    expect(text).toContain("truncated");
  });

  it("syncs deletions: a removed workspace file leaves the artifact store", async () => {
    const plugin = wrap(dir);
    const bash = toolOf(plugin, "bash");
    const before = listArtifacts(dir).find((info) => info.name === "greeting.txt");
    expect(before).toBeDefined();
    const removed = await bash.execute({ script: "rm greeting.txt" }, api, {} as never);
    expect(removed.isError).toBeUndefined();
    expect(removed.structuredOutput).toMatchObject({ exitCode: 0 });
    const after = listArtifacts(dir).find((info) => info.name === "greeting.txt");
    expect(after).toBeUndefined();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("bash_host tool (privileged shell)", () => {
  const hostDir = mkdtempSync(join(tmpdir(), "spreissen-host-"));
  it("runs on the real host and carries cwd", async () => {
    const plugin = wrap(hostDir);
    const host = toolOf(plugin, "bash_host");
    expect(host.gated).toBe(true);

    const ran = await host.execute({ script: "echo hi-from-host" }, api, {} as never);
    expect(ran.isError).toBeUndefined();
    expect(ran.structuredOutput).toMatchObject({ stdout: "hi-from-host\n", exitCode: 0 });

    // cwd defaults to the server user's home; cd carries over between calls.
    const cd = await host.execute({ script: `cd "${hostDir}"` }, api, {} as never);
    expect(cd.isError).toBeUndefined();
    const pwd = await host.execute({ script: "pwd" }, api, {} as never);
    // bash reports the resolved physical path on macOS (/var → /private/var).
    expect(pwd.structuredOutput).toMatchObject({ stdout: `${realpathSync(hostDir)}\n` });
  });

  it("reports failing commands via exit code and stderr", async () => {
    const plugin = wrap(hostDir);
    const host = toolOf(plugin, "bash_host");
    const failed = await host.execute({ script: "ls /definitely-not-here-xyz" }, api, {} as never);
    expect(failed.isError).toBeUndefined();
    // BSD ls exits 1 on a missing path, GNU ls exits 2: any non-zero proves the failure surfaced.
    expect((failed.structuredOutput as { exitCode: number }).exitCode).toBeGreaterThan(0);
    expect(((failed.output ?? [])[0] as { text: string }).text).toContain("stderr");
  });

  afterAll(() => rmSync(hostDir, { recursive: true, force: true }));
});
