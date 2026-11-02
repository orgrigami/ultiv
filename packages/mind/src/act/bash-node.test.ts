/**
 * Slice 4, phase 6: the merged bash tool's `node` target end to end on a
 * real mind, against a FAKE node dial (the loopback agent dial has its own
 * suite in apps/server). The gate assertions are the load-bearing ones: a
 * bare `bash` entry and a pattern never approve a node call — only the
 * exact `bash@node:<id>:=` entry does, and it must match the next identical
 * call by RESOLVING the name the call gives (the registry-backed NodeIdOf).
 * The host-access switch refuses a node call in yolo; an unresolvable node
 * answers the structured owner-actionable error.
 */
import { describe, expect, it, afterAll } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { targetExactEntry } from "../auto-approve.ts";
import { pairNode } from "../nodes/nodes.ts";
import { openMind } from "../entity.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bash-node-"));
// Effect snapshots process.env at first use: test env is set at module load.
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["BOT_FILES_DIR"] = join(scratch, "bot-files");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["MODELS_DEV_URL"] = "off";
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface DialCall {
  readonly nodeId: string;
  readonly script: string;
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
}

/** Waits for the conversation's card (the gate parked the call). */
const waitPending = async (env: {
  handle: { mind: { approvals: { pendingFor: (cid: string) => readonly unknown[] } } };
  cid: string;
}): Promise<void> => {
  const start = Date.now();
  while (env.handle.mind.approvals.pendingFor(env.cid).length === 0) {
    if (Date.now() - start > 5_000) throw new Error("the call never parked on a card");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

type BashTool = {
  execute: (
    a: never,
    b: never,
    c: never,
  ) => Promise<{
    isError?: boolean;
    output: { text: string }[];
    structuredOutput?: Record<string, unknown>;
  }>;
};

/** A mind with a fake node dial: records the exec frames, answers `stdout`. */
const setup = async (options: {
  readonly hostAccess?: boolean;
  readonly mode?: "manual" | "yolo";
  readonly answer?: (
    call: DialCall,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}) => {
  const calls: DialCall[] = [];
  const hostAccess = options.hostAccess;
  const authz = hostAccess !== undefined ? { hostAccess: async () => hostAccess } : undefined;
  const handle = await openMind({
    storage: new MemoryStorage(),
    ...(authz !== undefined ? { authz } : {}),
    nodeExec: (nodeId, request) => {
      calls.push({
        nodeId,
        script: request.script,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
      });
      return (options.answer ?? (async () => ({ stdout: "ok", stderr: "", exitCode: 0 })))(
        calls[calls.length - 1]!,
      );
    },
  });
  const { profiles, org, converse } = handle.mind;
  await org.ensureOrg("owner-a", "Org A", true);
  const bot = await profiles.create("owner-a", { name: "Kestrel", onboard: false });
  await profiles.update("owner-a", bot.id, {
    hostAccess: options.hostAccess === undefined ? true : options.hostAccess !== false,
    policies: { ...bot.policies, approvalMode: options.mode ?? "manual", autoApprove: [] },
  });
  const chat = await profiles.ensureMain("owner-a", bot.id);
  const row = await profiles.rowOf(chat.id);
  const key = row !== undefined ? await profiles.keyOfRow(row) : "";
  const cid = String(await Effect.runPromise(converse.conversationIdOf(key as never)));
  const bashTool = handle.mind.act
    .extension()
    .tools?.find((entry) => entry.name === "bash") as unknown as BashTool | undefined;
  if (bashTool === undefined) throw new Error("bash is not registered");
  return {
    handle,
    calls,
    cid,
    pair: (name: string) => pairNode(converse, "owner-a", { name, roots: ["/tmp"] }),
    allow: async (entries: readonly string[]): Promise<void> => {
      const current = (await profiles.get("owner-a", bot.id)) ?? bot;
      await profiles.update("owner-a", bot.id, {
        hostAccess: true,
        policies: { ...current.policies, autoApprove: [...entries] },
      });
    },
    call: (input: Record<string, unknown>): ReturnType<BashTool["execute"]> =>
      bashTool.execute(input as never, { conversationId: cid, callId: "h1" } as never, {} as never),
  };
};

describe("the bash node target on a real mind", () => {
  it("an unresolvable node answers the structured owner-actionable error", async () => {
    const env = await setup({ mode: "yolo" });
    const result = await env.call({ script: "echo hi", target: "node" });
    expect(result.isError).toBe(true);
    expect(result.output[0]?.text).toContain("no node is paired");
    expect(result.output[0]?.text).toContain("Settings");
    expect(env.calls).toEqual([]);
    await env.handle.close();
  });

  it("a paired node runs the script; the result says which node; audit carries target+node", async () => {
    const env = await setup({
      mode: "yolo",
      answer: async () => ({ stdout: "hi\n", stderr: "", exitCode: 0 }),
    });
    const paired = await env.pair("node-x");
    const result = await env.call({ script: "echo hi", target: "node" });
    expect(result.isError).toBeUndefined();
    expect(result.output[0]?.text).toContain("hi");
    expect(result.output[0]?.text).toContain("(ran on node node-x)");
    expect(result.structuredOutput).toMatchObject({ target: "node", node: "node-x" });
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]?.nodeId).toBe(paired.node.id);
    // The default cwd is the node's first allowed root.
    expect(env.calls[0]?.cwd).toBe("/tmp");
    expect(env.calls[0]?.timeoutMs).toBeGreaterThan(0);
    // The audit line answers "where did this run" as a lookup (the LAST bash
    // line: earlier refused calls also leave lines, without a node).
    const bash = [...env.handle.mind.audit.tail(20)]
      .reverse()
      .find((event) => event.kind === "tool_call" && event.name === "bash" && event.ok === true);
    expect(bash).toBeDefined();
    expect(bash?.bashTarget).toEqual({ target: "node", node: paired.node.id });
    await env.handle.close();
  });

  it("only the exact node entry approves: bare and pattern never cover a node call", async () => {
    const env = await setup({ mode: "manual" });
    await env.pair("node-x");
    await env.allow(["bash", "bash:echo *"]);
    const parked = env.call({ script: "echo hi", target: "node" });
    await waitPending(env);
    expect(env.calls).toEqual([]); // bare and pattern never cover a node call
    env.handle.mind.approvals.decide(env.cid, "h1", false);
    const result = await parked;
    expect(result.isError).toBe(true); // the denial reads as a refusal
    expect(env.handle.mind.approvals.pendingFor(env.cid)).toHaveLength(0);
    await env.handle.close();
  });

  it("the exact node entry approves the next identical call by resolving the name", async () => {
    const env = await setup({
      mode: "manual",
      answer: async (call) => ({ stdout: `ran:${call.script.length}`, stderr: "", exitCode: 0 }),
    });
    const paired = await env.pair("node-x");
    const script = "echo hi";
    // Saved exactly as allowTool saves it: the stored id, not the name.
    await env.allow([targetExactEntry({ kind: "node", nodeId: paired.node.id }, script)]);
    const result = await env.call({ script, target: "node", node: "node-x" });
    expect(env.calls).toHaveLength(1); // auto-approved: the dial ran, no card
    expect(env.handle.mind.approvals.pendingFor(env.cid)).toHaveLength(0);
    expect(result.output[0]?.text).toContain("(ran on node node-x)");
    // The unnamed call resolves to the single paired node just the same.
    await env.call({ script, target: "node" });
    expect(env.calls).toHaveLength(2);
    // A different script never matches the exact entry: it parks on a card.
    const parked = env.call({ script: "echo other", target: "node", node: "node-x" });
    await waitPending(env);
    expect(env.calls).toHaveLength(2);
    env.handle.mind.approvals.decide(env.cid, "h1", false);
    await parked;
    await env.handle.close();
  });

  it("the switch refuses a node call in yolo, end to end", async () => {
    const env = await setup({ mode: "yolo", hostAccess: false });
    await env.pair("node-x");
    const result = await env.call({ script: "echo hi", target: "node" });
    expect(result.isError).toBe(true);
    expect(result.output[0]?.text).toContain("does not have access to this computer");
    expect(env.calls).toEqual([]);
    expect(env.handle.mind.approvals.pendingFor(env.cid)).toEqual([]);
    await env.handle.close();
  });
});
