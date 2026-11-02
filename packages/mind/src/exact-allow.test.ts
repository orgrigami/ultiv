/**
 * bash's beyond-VM targets' "Always allow this exact command":
 * `bash@host:=<script>` / `bash@node:<id>:=<script>` approve that one script
 * on that one target, character for character, and nothing else. Globs,
 * prefixes and extra fields never match; Jev never decides a host/node call,
 * and yolo is unchanged. The migrated legacy form (`bash_host:=`) keeps
 * approving its exact script.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  legacyExactScriptOf,
  matchAutoApprove,
  MAX_EXACT_SCRIPT_CHARS,
  mayAutoApprove,
  parseTargetExactEntry,
  targetExactEntry,
  validAutoApproveEntry,
} from "./auto-approve.ts";
import { openMind } from "./entity.ts";
import { jevMayDecide } from "./jev-gate.ts";

const call = (input: unknown, name = "bash") => ({ callId: "c1", name, input });
const kindOf = (entries: readonly string[], input: unknown, name = "bash") =>
  matchAutoApprove(entries, call(input, name)).kind;

describe("exact bash target entries", () => {
  it("match only the identical script on the entry's own target", () => {
    const entries = [targetExactEntry({ kind: "host" }, "git status")];
    expect(entries).toEqual(["bash@host:=git status"]);
    expect(kindOf(entries, { script: "git status", target: "host" })).toBe("exact");
    for (const other of [
      "git status ",
      " git status",
      "git",
      "git status && rm -rf /",
      "GIT STATUS",
    ])
      expect(kindOf(entries, { script: other, target: "host" }), other).toBe("none");
  });

  it("never glob: wildcards in the stored script are literal", () => {
    const entries = [targetExactEntry({ kind: "host" }, "ls *")];
    expect(kindOf(entries, { script: "ls *", target: "host" })).toBe("exact");
    expect(kindOf(entries, { script: "ls secrets", target: "host" })).toBe("none");
  });

  it("match a multi-line or chained script only when it is identical", () => {
    const script = "cd /tmp && ls\necho done";
    expect(kindOf([targetExactEntry({ kind: "host" }, script)], { script, target: "host" })).toBe(
      "exact",
    );
    expect(
      kindOf([targetExactEntry({ kind: "host" }, script)], {
        script: `${script}\nrm -rf x`,
        target: "host",
      }),
    ).toBe("none");
  });

  it("need the input to be exactly { script, target }", () => {
    const entries = [targetExactEntry({ kind: "host" }, "ls")];
    expect(kindOf(entries, { script: "ls", target: "host", extra: "x" })).toBe("none");
    expect(kindOf(entries, { command: "ls", target: "host" })).toBe("none");
    expect(kindOf(entries, "ls")).toBe("none");
  });

  it("a host rule never approves the same script in the VM, or on a node", () => {
    const entries = [targetExactEntry({ kind: "host" }, "ls")];
    expect(kindOf(entries, { script: "ls" })).toBe("none");
    expect(kindOf(entries, { script: "ls", target: "vm" })).toBe("none");
    expect(kindOf(entries, { script: "ls", target: "node" })).toBe("none");
  });

  it("node entries pin the node by id; other nodes and unnamed calls stay gated", () => {
    const entries = [targetExactEntry({ kind: "node", nodeId: "node-x" }, "ls")];
    expect(entries).toEqual(["bash@node:node-x:=ls"]);
    expect(kindOf(entries, { script: "ls", target: "node", node: "node-x" })).toBe("exact");
    expect(kindOf(entries, { script: "ls", target: "node", node: "node-y" })).toBe("none");
    expect(kindOf(entries, { script: "ls", target: "node" })).toBe("none");
    // A resolver (the registry-backed view) maps the call's node name — or
    // the unnamed single paired node — to its stored id.
    const withResolver = (input: unknown) =>
      matchAutoApprove(entries, call(input), (name) =>
        name === null || name === "build-box" ? "node-x" : undefined,
      ).kind;
    expect(withResolver({ script: "ls", target: "node", node: "build-box" })).toBe("exact");
    expect(withResolver({ script: "ls", target: "node" })).toBe("exact");
    expect(
      matchAutoApprove(entries, call({ script: "ls", target: "node" }), () => "node-y").kind,
    ).toBe("none");
  });

  it("don't apply to other tools, and legacy entries stay inert", () => {
    expect(kindOf(["bash@host:=ls"], { script: "ls", target: "host" }, "bash_host")).toBe("none");
    expect(kindOf(["bash_host:git *"], { script: "git status", target: "host" })).toBe("none");
    expect(kindOf(["bash_host:git status"], { script: "git status", target: "host" })).toBe("none");
    // Legacy exact form never matches (it is migrated at boot, not honored).
    expect(kindOf(["bash_host:=ls"], { script: "ls", target: "host" })).toBe("none");
    expect(legacyExactScriptOf("bash_host:=ls")).toEqual({ script: "ls" });
    expect(legacyExactScriptOf("bash@host:=ls")).toBeUndefined();
  });

  it("parse back into their target and script", () => {
    expect(parseTargetExactEntry("bash@host:=git status")).toEqual({
      target: { kind: "host" },
      script: "git status",
    });
    expect(parseTargetExactEntry("bash@node:node-x:=make test")).toEqual({
      target: { kind: "node", nodeId: "node-x" },
      script: "make test",
    });
    expect(parseTargetExactEntry("bash:=git status")).toBeUndefined();
    expect(parseTargetExactEntry("bash@git:status")).toBeUndefined();
  });

  it("are approved by the gate predicate and pass the write-time check", () => {
    const long = `echo ${"*?".repeat(40)}`;
    expect(validAutoApproveEntry(targetExactEntry({ kind: "host" }, long))).toBe(true);
    expect(validAutoApproveEntry(targetExactEntry({ kind: "node", nodeId: "node-x" }, long))).toBe(
      true,
    );
    expect(
      mayAutoApprove(
        [targetExactEntry({ kind: "host" }, "rm -rf build")],
        call({ script: "rm -rf build", target: "host" }),
      ),
    ).toBe(true);
    expect(
      mayAutoApprove(
        [targetExactEntry({ kind: "host" }, "rm -rf build")],
        call({ script: "rm -rf /", target: "host" }),
      ),
    ).toBe(false);
    // The legacy form stays valid storage (until boot migrates it).
    expect(validAutoApproveEntry("bash_host:=ls -la")).toBe(true);
  });

  it("leave Jev out of bash beyond the VM", () => {
    expect(jevMayDecide("bash", { script: "ls", target: "host" })).toBe(false);
    expect(jevMayDecide("bash", { script: "ls", target: "node" })).toBe(false);
    expect(jevMayDecide("bash", { script: "ls" })).toBe(true);
  });
});

describe("allowTool for bash beyond the VM", () => {
  it("saves the exact script pinned to the target, never a bare grant or pattern", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const bot = await profiles.create("owner-a", { name: "Host", onboard: false });
    expect(
      await profiles.allowTool("owner-a", bot.id, "bash", { script: "ls -la", target: "host" }),
    ).toEqual(["bash@host:=ls -la"]);
    // Saving the same script twice keeps one rule.
    await profiles.allowTool("owner-a", bot.id, "bash", { script: "ls -la", target: "host" });
    expect((await profiles.get("owner-a", bot.id))?.policies.autoApprove).toEqual([
      "bash@host:=ls -la",
    ]);
    for (const input of [
      { script: "", target: "host" },
      { script: "ls", target: "host", extra: 1 },
      { command: "ls", target: "host" },
      { script: "x".repeat(MAX_EXACT_SCRIPT_CHARS + 1), target: "host" },
      // An unnamed node call cannot be pinned without the resolver: gated.
      { script: "ls", target: "node" },
    ])
      expect(await profiles.allowTool("owner-a", bot.id, "bash", input)).toEqual([]);
    // A long (but allowed) script round-trips through a policies patch, as
    // the Access tab sends when it removes another rule.
    const long = `printf '%s\\n' ${"word ".repeat(300)}`.slice(0, MAX_EXACT_SCRIPT_CHARS);
    await profiles.allowTool("owner-a", bot.id, "bash", { script: long, target: "host" });
    const policies = (await profiles.get("owner-a", bot.id))?.policies;
    if (policies === undefined) throw new Error("bot is gone");
    const kept = policies.autoApprove.filter((entry) => entry !== "bash@host:=ls -la");
    const updated = await profiles.update("owner-a", bot.id, {
      policies: { ...policies, autoApprove: kept },
    });
    expect(updated.policies.autoApprove).toEqual([targetExactEntry({ kind: "host" }, long)]);
    await handle.close();
  });

  it("a bare-grant offer on a vm card stays vm-only: the host call is not covered", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const bot = await profiles.create("owner-a", { name: "Host", onboard: false });
    // "Always allow" on a vm-target card saves the bare tool name — which the
    // matcher defines to cover the vm target only.
    expect(await profiles.allowTool("owner-a", bot.id, "bash", { script: "ls" })).toEqual(["bash"]);
    const entries = (await profiles.get("owner-a", bot.id))?.policies.autoApprove ?? [];
    expect(kindOf(entries, { script: "ls" })).toBe("bare");
    expect(kindOf(entries, { script: "ls", target: "host" })).toBe("none");
    expect(kindOf(entries, { script: "ls", target: "node" })).toBe("none");
    await handle.close();
  });
});
