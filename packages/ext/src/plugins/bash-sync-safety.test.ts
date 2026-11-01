/**
 * Phase 4 fix 1: the VM → artifact sync never deletes on an untrusted
 * listing. A failed listing (non-zero exit) and a LOST workspace (the VM was
 * recreated under the session — `WorkspaceLostError`) both keep every
 * artifact, and the next call re-prepares the workspace from the store. A
 * changed home world (allowlist, size, VM) drops the cached session.
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashPlugin, localShellBackend } from "./bash.ts";
import { WorkspaceLostError, type ShellBackend } from "../shell/backend.ts";
import { createScopeHolder, type HomeScope } from "./vault.ts";
import { listArtifacts } from "./artifacts.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bash-sync-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const api = { conversationId: "conv-1" } as never;

const toolOf = (plugin: ReturnType<typeof bashPlugin>) => {
  const capability = plugin.capabilities.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === "bash",
  );
  if (capability?.kind !== "tool") throw new Error("missing bash tool");
  return capability.tool;
};

/** A local backend whose listing can be made to fail or report a lost workspace. */
const faulty = (disk: string, guestRoot: string, mode: { fail: "none" | "exit" | "lost" }) => {
  const inner = localShellBackend(join(disk, guestRoot), guestRoot);
  let prepares = 0;
  let lost = false;
  const backend: ShellBackend & { prepares: () => number } = {
    prepare: async (files) => {
      prepares += 1;
      lost = false;
      await inner.prepare(files);
    },
    exec: (script, cwd, timeout) => inner.exec(script, cwd, timeout),
    readFile: (path) => inner.readFile(path),
    listFiles: async () => {
      if (mode.fail === "exit") throw new Error("workspace listing failed (exit 1)");
      if (mode.fail === "lost") {
        lost = true;
        throw new WorkspaceLostError("recreated");
      }
      return inner.listFiles();
    },
    needsPrepare: () => lost,
    prepares: () => prepares,
  };
  return backend;
};

const setup = (name: string, home?: { current: HomeScope }) => {
  const root = join(scratch, name);
  const disk = join(scratch, `${name}-disk`);
  const mode = { fail: "none" as "none" | "exit" | "lost" };
  const made: ReturnType<typeof faulty>[] = [];
  const holder = createScopeHolder();
  holder.set({
    scopeOf: () => ({ owner: "owner-a", profile: "bot-1" }),
    ...(home === undefined ? {} : { homeScopeOf: async () => home.current }),
  });
  const bash = toolOf(
    bashPlugin({
      root,
      holder,
      backend: (_dir, _staging, guestRoot) => {
        const backend = faulty(disk, guestRoot, mode);
        made.push(backend);
        return backend;
      },
    }),
  );
  const files = () =>
    listArtifacts(join(root, "owner-a", "bot-1"))
      .map((artifact) => artifact.name)
      .sort();
  return { bash, mode, made, files };
};

describe("the sync loop never deletes on an untrusted listing", () => {
  it("a failed listing (non-zero exit) keeps every artifact", async () => {
    const { bash, mode, files } = setup("exit");
    await bash.execute({ script: "echo a > a.txt && echo b > b.txt" }, api, {} as never);
    expect(files()).toEqual(["a.txt", "b.txt"]);
    mode.fail = "exit";
    const ran = await bash.execute({ script: "rm a.txt" }, api, {} as never);
    expect(JSON.stringify(ran.structuredOutput)).toContain("workspace sync to artifacts failed");
    expect(files()).toEqual(["a.txt", "b.txt"]);
  });

  it("a lost workspace (recreated VM) keeps every artifact and re-prepares next call", async () => {
    const { bash, mode, made, files } = setup("lost");
    await bash.execute({ script: "echo a > a.txt" }, api, {} as never);
    const backend = made[0];
    if (backend === undefined) throw new Error("no backend");
    const before = backend.prepares();
    mode.fail = "lost";
    await bash.execute({ script: "true" }, api, {} as never);
    expect(files()).toEqual(["a.txt"]);
    mode.fail = "none";
    const again = await bash.execute({ script: "cat a.txt" }, api, {} as never);
    expect(backend.prepares()).toBe(before + 1);
    expect(again.structuredOutput).toMatchObject({ stdout: "a\n", exitCode: 0 });
  });

  it("a changed home world (allowlist) drops the cached session and rebuilds the backend", async () => {
    const dir = join(scratch, "world", "owner-a", "_home", "org");
    const home = { current: { dir, netAllowlist: [] } as HomeScope };
    const { bash, made } = setup("world", home);
    await bash.execute({ script: "true" }, api, {} as never);
    await bash.execute({ script: "true" }, api, {} as never);
    expect(made).toHaveLength(1);
    home.current = { dir, netAllowlist: ["api.example.com"] } as HomeScope;
    await bash.execute({ script: "true" }, api, {} as never);
    expect(made).toHaveLength(2);
  });
});
