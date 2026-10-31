/**
 * The host shell's "Always allow this exact command on this computer":
 * `bash_host:=<script>` approves that one script, character for character,
 * and nothing else. Globs, prefixes and extra fields never match; Jev still
 * never decides bash_host and yolo is unchanged.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  exactEntry,
  exactScriptOf,
  matchAutoApprove,
  MAX_EXACT_SCRIPT_CHARS,
  mayAutoApprove,
  validAutoApproveEntry,
} from "./auto-approve.ts";
import { openMind } from "./entity.ts";
import { jevMayDecide } from "./jev-gate.ts";

const call = (input: unknown, name = "bash_host") => ({ callId: "c1", name, input });
const kindOf = (entries: readonly string[], input: unknown, name = "bash_host") =>
  matchAutoApprove(entries, call(input, name)).kind;

describe("exact bash_host entries", () => {
  it("match only the identical script", () => {
    const entries = [exactEntry("bash_host", "git status")];
    expect(entries).toEqual(["bash_host:=git status"]);
    expect(kindOf(entries, { script: "git status" })).toBe("exact");
    for (const other of [
      "git status ",
      " git status",
      "git",
      "git status && rm -rf /",
      "GIT STATUS",
    ])
      expect(kindOf(entries, { script: other }), other).toBe("none");
  });

  it("never glob: wildcards in the stored script are literal", () => {
    const entries = [exactEntry("bash_host", "ls *")];
    expect(kindOf(entries, { script: "ls *" })).toBe("exact");
    expect(kindOf(entries, { script: "ls secrets" })).toBe("none");
  });

  it("match a multi-line or chained script only when it is identical", () => {
    const script = "cd /tmp && ls\necho done";
    expect(kindOf([exactEntry("bash_host", script)], { script })).toBe("exact");
    expect(kindOf([exactEntry("bash_host", script)], { script: `${script}\nrm -rf x` })).toBe(
      "none",
    );
  });

  it("need the input to be exactly { script }", () => {
    const entries = [exactEntry("bash_host", "ls")];
    expect(kindOf(entries, { script: "ls", extra: "x" })).toBe("none");
    expect(kindOf(entries, { command: "ls" })).toBe("none");
    expect(kindOf(entries, "ls")).toBe("none");
  });

  it("don't apply to other tools, and old glob entries stay inert for bash_host", () => {
    expect(kindOf(["bash:=ls"], { script: "ls" }, "bash")).toBe("none");
    expect(exactScriptOf("bash:=ls")).toBeUndefined();
    expect(kindOf(["bash_host:git *"], { script: "git status" })).toBe("none");
    expect(kindOf(["bash_host:git status"], { script: "git status" })).toBe("none");
  });

  it("are approved by the gate predicate and pass the write-time check", () => {
    const long = `echo ${"*?".repeat(40)}`;
    expect(validAutoApproveEntry(exactEntry("bash_host", long))).toBe(true);
    expect(
      mayAutoApprove([exactEntry("bash_host", "rm -rf build")], call({ script: "rm -rf build" })),
    ).toBe(true);
    expect(
      mayAutoApprove([exactEntry("bash_host", "rm -rf build")], call({ script: "rm -rf /" })),
    ).toBe(false);
  });

  it("leave Jev out of bash_host", () => {
    expect(jevMayDecide("bash_host")).toBe(false);
  });
});

describe("allowTool for bash_host", () => {
  it("saves the exact script, never a bare grant or a pattern; refuses odd shapes", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const bot = await profiles.create("owner-a", { name: "Host", onboard: false });
    expect(await profiles.allowTool("owner-a", bot.id, "bash_host", { script: "ls -la" })).toEqual([
      "bash_host:=ls -la",
    ]);
    // Saving the same script twice keeps one rule.
    await profiles.allowTool("owner-a", bot.id, "bash_host", { script: "ls -la" });
    expect((await profiles.get("owner-a", bot.id))?.policies.autoApprove).toEqual([
      "bash_host:=ls -la",
    ]);
    for (const input of [
      { script: "" },
      { script: "ls", extra: 1 },
      { command: "ls" },
      { script: "x".repeat(MAX_EXACT_SCRIPT_CHARS + 1) },
    ])
      expect(await profiles.allowTool("owner-a", bot.id, "bash_host", input)).toEqual([]);
    // A long (but allowed) script round-trips through a policies patch, as
    // the Access tab sends when it removes another rule.
    const long = `printf '%s\\n' ${"word ".repeat(300)}`.slice(0, MAX_EXACT_SCRIPT_CHARS);
    await profiles.allowTool("owner-a", bot.id, "bash_host", { script: long });
    const policies = (await profiles.get("owner-a", bot.id))?.policies;
    if (policies === undefined) throw new Error("bot is gone");
    const kept = policies.autoApprove.filter((entry) => entry !== "bash_host:=ls -la");
    const updated = await profiles.update("owner-a", bot.id, {
      policies: { ...policies, autoApprove: kept },
    });
    expect(updated.policies.autoApprove).toEqual([exactEntry("bash_host", long)]);
    await handle.close();
  });
});
