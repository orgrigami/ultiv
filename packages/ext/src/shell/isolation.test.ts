/**
 * Cross-home isolation (phase 4 slice 5), unit level, ext side: the command
 * surface cannot name another home's VM. The tools' schemas carry only the
 * script, the ShellBackend every command rides has no VM-targeting method,
 * and each home's VM name is derived from its own scope dir alone. Real-VM
 * behaviour is probed separately (var/probe, not committed).
 */
import { describe, expect, it } from "vite-plus/test";
import { bashPlugin } from "../plugins/bash.ts";
import { sandboxShellBackend, sandboxNameOf } from "./sandbox-backend.ts";
import type { ShellBackend } from "./backend.ts";
import type { HomeScope } from "../plugins/vault.ts";

const toolOf = (plugin: ReturnType<typeof bashPlugin>, name: string) => {
  const capability = plugin.capabilities.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === name,
  );
  if (capability?.kind !== "tool") throw new Error(`missing ${name} tool`);
  return capability.tool;
};

const propertyNames = (tool: ReturnType<typeof toolOf>): string[] =>
  Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});

const bashPluginTool = (name: "bash"): string[] => propertyNames(toolOf(bashPlugin(), name));

describe("no tool parameter opens another home's VM", () => {
  it("bash takes exactly a script and an optional target — no vm, home or department argument", () => {
    expect(bashPluginTool("bash")).toEqual(["script", "target"]);
  });
});

describe("no command path targets a VM by name", () => {
  it("the ShellBackend surface is prepare/exec/listFiles/readFile — none takes a VM", () => {
    // Every command, whatever the home, rides this interface; the VM is
    // bound in the closure at construction (options.name), never per call.
    const backend: ShellBackend = sandboxShellBackend({ name: "ultiv-unittest" })("/staging");
    expect(Object.keys(backend).sort()).toEqual([
      "exec",
      "listFiles",
      "needsPrepare",
      "prepare",
      "readFile",
    ]);
    expect(backend.needsPrepare?.length).toBe(0); // no target either
    expect(backend.exec.length).toBe(3); // script, cwd, timeout — no target
  });

  it("a home's VM name comes from its own scope dir alone, and homes never collide", () => {
    const root = "/data/owner-a/_home";
    const homes: readonly HomeScope[] = [
      { dir: `${root}/org` },
      { dir: `${root}/dept-x` },
      { dir: `${root}/dept-y` },
    ];
    const names = homes.map((home) => sandboxNameOf(home.dir));
    expect(new Set(names).size).toBe(homes.length);
    for (const name of names) expect(name.startsWith("ultiv-")).toBe(true);
    // Re-deriving is stable: the same home always reaches the same VM.
    expect(homes.map((home) => sandboxNameOf(home.dir))).toEqual(names);
  });
});
