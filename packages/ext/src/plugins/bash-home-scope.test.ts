/**
 * One VM per home (phase 4 slice 2): the sandbox scope moves from the bot to
 * the bot's HOME (its department, or the org). Two bots of one home share a
 * VM, each in its own folder that `prepare` wipes alone; different homes get
 * different VM names; without a home-scope resolver the per-bot behaviour of
 * older embedders is unchanged. The local backend stands in for the VM: one
 * host dir per guest root, all under one shared "disk".
 */
import { describe, expect, it, afterAll } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashPlugin, homeWorldOf, localShellBackend } from "./bash.ts";
import { scopeHash, sandboxNameOf } from "../shell/sandbox-backend.ts";
import {
  createScopeHolder,
  type HomeScope,
  type ScopeHolder,
  type ScopeResolver,
} from "./vault.ts";
import { listArtifacts } from "./artifacts.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bash-home-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const api = (conversationId: string) => ({ conversationId }) as never;

const holderWith = (
  scopes: Record<string, { owner: string; profile: string }>,
  homes: Record<string, HomeScope | undefined>,
): ScopeHolder => {
  const holder = createScopeHolder();
  const resolver: ScopeResolver = {
    scopeOf: (conversationId) => scopes[conversationId],
    homeScopeOf: async (conversationId) => homes[conversationId],
  };
  holder.set(resolver);
  return holder;
};

const toolOf = (plugin: ReturnType<typeof bashPlugin>, name: string) => {
  const capability = plugin.capabilities.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === name,
  );
  if (capability?.kind !== "tool") throw new Error(`missing ${name} tool`);
  return capability.tool;
};

describe("homeWorldOf (the pure bot dir + home scope -> VM mapping)", () => {
  const root = join(scratch, "root");
  const botDir = (owner: string, profile: string): string => join(root, owner, profile);

  it("without a home scope, the bot's dir names the VM and the workspace is /home", () => {
    const dir = botDir("owner-a", "bot-1");
    expect(homeWorldOf(dir, undefined)).toEqual({ vmDir: dir, guestRoot: "/home" });
  });

  it("two bots of one home share the VM, each in its own folder", () => {
    const home: HomeScope = { dir: join(root, "owner-a", "_home", "dept-x"), sharedGid: 10001 };
    const first = homeWorldOf(botDir("owner-a", "bot-1"), home);
    const second = homeWorldOf(botDir("owner-a", "bot-2"), home);
    expect(first.vmDir).toBe(home.dir);
    expect(second.vmDir).toBe(home.dir);
    expect(first.guestRoot).toBe("/home/bot-1");
    expect(second.guestRoot).toBe("/home/bot-2");
    expect(first.sharedGid).toBe(10001);
  });

  it("org and departments name different VMs; org bots share the org VM", () => {
    const org: HomeScope = { dir: join(root, "owner-a", "_home", "org") };
    const dept: HomeScope = { dir: join(root, "owner-a", "_home", "dept-x") };
    const other: HomeScope = { dir: join(root, "owner-a", "_home", "dept-y") };
    const names = [org, dept, other].map((home) => sandboxNameOf(homeWorldOf("d/b", home).vmDir));
    expect(new Set(names).size).toBe(3);
    // An org with no departments: every (org) bot runs in the one org VM.
    expect(sandboxNameOf(homeWorldOf(botDir("owner-a", "a"), org).vmDir)).toBe(
      sandboxNameOf(homeWorldOf(botDir("owner-a", "b"), org).vmDir),
    );
    expect(names[0]?.startsWith("ultiv-")).toBe(true);
  });

  it("an unsafe or reserved bot id falls back to an opaque folder hash", () => {
    const home: HomeScope = { dir: "/h/_home/org" };
    expect(homeWorldOf("/h/owner-a/shared", home).guestRoot).toBe(
      `/home/${scopeHash("/h/owner-a/shared")}`,
    );
    expect(homeWorldOf("/h/owner-a/bad name", home).guestRoot).toBe(
      `/home/${scopeHash("/h/owner-a/bad name")}`,
    );
    expect(homeWorldOf("/h/owner-a/bot-1", home).guestRoot).toBe("/home/bot-1");
  });
});

describe("bash stays in the bot's own home VM (no cross-VM target)", () => {
  it("the tool schema ships no target parameter", () => {
    const bash = toolOf(bashPlugin({ root: join(scratch, "schema") }), "bash");
    const properties = (bash.parameters as { properties?: Record<string, unknown> }).properties;
    expect(properties && "target" in properties).toBe(false);
  });

  it("a target-shaped extra argument never leaves the bot's own home VM", async () => {
    const root = join(scratch, "no-target");
    const disk = join(scratch, "no-target-disk");
    const home: HomeScope = { dir: join(root, "owner-a", "_home", "dept-x"), sharedGid: 10001 };
    const asked: (string | undefined)[] = [];
    const holder = createScopeHolder();
    holder.set({
      scopeOf: () => ({ owner: "owner-a", profile: "bot-1" }),
      homeScopeOf: async (_conversationId: string, target?: string) => {
        asked.push(target);
        return home;
      },
    });
    const bash = toolOf(
      bashPlugin({
        root,
        holder,
        backend: (_d, _s, guestRoot) => localShellBackend(join(disk, guestRoot), guestRoot),
      }),
      "bash",
    );
    const ran = await bash.execute(
      { script: "pwd", target: "dept-y" } as never,
      api("conv-1"),
      {} as never,
    );
    // The resolver was asked for the bot's OWN home only — no target was
    // forwarded, so the command ran in the home VM at the bot's own folder.
    expect(asked).toEqual([undefined]);
    expect(ran.structuredOutput).toMatchObject({ stdout: "/home/bot-1\n", exitCode: 0 });
  });
});

describe("bash in a shared home VM (local backend standing in for the VM disk)", () => {
  it("two department bots colocate; prepare for one leaves the other's folder", async () => {
    const root = join(scratch, "shared");
    // One "VM disk": each guest root maps to its own host dir beneath it.
    const disk = join(scratch, "vm-disk");
    const home: HomeScope = { dir: join(root, "owner-a", "_home", "dept-x"), sharedGid: 10001 };
    const plugin = bashPlugin({
      root,
      holder: holderWith(
        {
          "conv-1": { owner: "owner-a", profile: "bot-1" },
          "conv-2": { owner: "owner-a", profile: "bot-2" },
        },
        { "conv-1": home, "conv-2": home },
      ),
      backend: (_dir, _staging, guestRoot) => localShellBackend(join(disk, guestRoot), guestRoot),
    });
    const bash = toolOf(plugin, "bash");

    // Bot 1 writes a file; bot 2's session (and its prepare) comes after.
    const write = await bash.execute({ script: "echo one > a.txt" }, api("conv-1"), {} as never);
    expect(write.isError).toBeUndefined();

    // Bot 2 sees bot 1's folder (same VM), and its own prepare kept it.
    const read = await bash.execute(
      { script: "cat ../bot-1/a.txt && echo two > b.txt" },
      api("conv-2"),
      {} as never,
    );
    expect(read.structuredOutput).toMatchObject({ stdout: "one\n", exitCode: 0 });

    // ...and bot 1 sees bot 2's file and its own, after bot 2's prepare.
    const back = await bash.execute(
      { script: "cat a.txt && cat ../bot-2/b.txt" },
      api("conv-1"),
      {} as never,
    );
    expect(back.structuredOutput).toMatchObject({ stdout: "one\ntwo\n", exitCode: 0 });

    // Each bot's workspace root is its own folder: pwd starts there.
    const pwd = await bash.execute({ script: "pwd" }, api("conv-2"), {} as never);
    expect(pwd.structuredOutput).toMatchObject({ stdout: "/home/bot-2\n" });

    // Files still sync back to each bot's OWN artifact partition.
    const artifacts = listArtifacts(join(root, "owner-a", "bot-1"));
    expect(artifacts.some((info) => info.name === "a.txt")).toBe(true);
  });

  it("without a home scope the workspace is all of /home, as before", async () => {
    const root = join(scratch, "fallback");
    const seen: { dir: string; guestRoot: string }[] = [];
    const plugin = bashPlugin({
      root,
      holder: holderWith({ "conv-1": { owner: "owner-a", profile: "bot-1" } }, {}),
      backend: (dir, _staging, guestRoot) => {
        seen.push({ dir, guestRoot });
        return localShellBackend(join(scratch, "fallback-disk"), guestRoot);
      },
    });
    const bash = toolOf(plugin, "bash");
    const ran = await bash.execute({ script: "echo hi > note.txt" }, api("conv-1"), {} as never);
    expect(ran.isError).toBeUndefined();
    expect(seen).toEqual([{ dir: join(root, "owner-a", "bot-1"), guestRoot: "/home" }]);
    const pwd = await bash.execute({ script: "pwd" }, api("conv-1"), {} as never);
    expect(pwd.structuredOutput).toMatchObject({ stdout: "/home\n" });
  });
});
