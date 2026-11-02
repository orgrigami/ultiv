/**
 * The node agent, end to end over a real loopback WebSocket: the REAL stack
 * on an ephemeral port, the REAL `/agent` endpoint, and a SPAWNED agent
 * process (`node apps/agent/src/main.ts` — the owner's own install story,
 * "run it from a repo checkout"). Covers the slice-3 refusals: wrong token,
 * revocation mid-connection, a cwd outside the registered roots, the output
 * cap, and agent death answering as a structured error, never a hang. The
 * reconnect test drops a live dial and expects the agent's own backoff loop
 * to bring the node back.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { NODE_OUTPUT_CAP, type NodeInfo } from "@spriessen/contracts";
import { pairNode, revokeNode } from "@spriessen/mind";
import WebSocket from "ws";
import { buildStack } from "./main.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-agent-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["MODELS_DEV_URL"] = "off";
// The bot-files dir is SHARED by default (packages/mind/test-env.ts); this
// stack's boot migration scans it, so it gets its own to never race another
// buildStack test's scan of the shared folder.
process.env["BOT_FILES_DIR"] = join(scratch, "bot-files");

const AGENT_MAIN = join(dirname(fileURLToPath(import.meta.url)), "../../agent/src/main.ts");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

let stack: Awaited<ReturnType<typeof buildStack>>;
let port = 0;
let base = "";
const agents: ChildProcess[] = [];

const spawnAgent = (token: string, extra: string[] = []): ChildProcess => {
  const child = spawn(process.execPath, [AGENT_MAIN, "--url", base, "--token", token, ...extra], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", () => undefined); // progress lines stay off the test output
  agents.push(child);
  return child;
};

const waitConnected = async (nodeId: string, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!stack.nodeTransport.connected(nodeId)) {
    if (Date.now() - start > ms) throw new Error(`agent never connected within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const pair = async (name: string, roots: string[]): Promise<NodeInfo & { token: string }> => {
  const paired = await pairNode(stack.mind.converse, "owner-a", { name, roots });
  return { ...paired.node, token: paired.token };
};

beforeAll(async () => {
  stack = await buildStack({
    storage: new MemoryStorage(),
    vault: { dir: join(scratch, "vault") },
  });
  await new Promise<void>((resolve, reject) => {
    stack.http.once("listening", resolve);
    stack.http.once("error", reject);
    stack.http.listen(0, "127.0.0.1");
  });
  const address = stack.http.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const child of agents) child.kill("SIGKILL");
  await stack.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the node agent endpoint", () => {
  it("runs a spawned agent's script end to end", async () => {
    const node = await pair("node-x", ["/tmp"]);
    const child = spawnAgent(node.token);
    await waitConnected(node.id);
    const result = await stack.nodeTransport.exec(node.id, {
      script: "echo hi",
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
    child.kill("SIGKILL");
  });

  it("refuses a wrong pairing token (close 4001, never connected)", async () => {
    await pair("node-bad", ["/tmp"]); // a paired row exists; the token is still wrong
    const outcome = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?token=not-the-token`);
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve(undefined));
    });
    expect(outcome).toBe(4001);
  });

  it("refuses a revoked token mid-connection and rejects its pending execs", async () => {
    const node = await pair("node-r", ["/tmp"]);
    spawnAgent(node.token);
    await waitConnected(node.id);
    // An exec that is still pending when the revoke lands.
    const pending = stack.nodeTransport.exec(node.id, {
      script: "sleep 30",
      timeoutMs: 30_000,
    });
    await revokeNode(stack.mind.converse, node.id).then((ok) => expect(ok).toBe(true));
    // The REST route drops the live dial after a successful revoke (rest/nodes.ts).
    stack.nodes.drop(node.id);
    await expect(pending).rejects.toThrow(/the node was revoked/);
    // The same token can never open a new dial after the revoke.
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${node.token}`);
      ws.on("close", (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on("error", () => resolve());
    });
    await expect(
      stack.nodeTransport.exec(node.id, { script: "echo hi", timeoutMs: 2_000 }),
    ).rejects.toThrow(/not connected/);
  });

  it("refuses a cwd outside the node's registered roots", async () => {
    const node = await pair("node-cwd", ["/tmp"]);
    spawnAgent(node.token);
    await waitConnected(node.id);
    await expect(
      stack.nodeTransport.exec(node.id, {
        script: "echo hi",
        cwd: "/etc",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/outside this node's registered roots/);
    // Inside a root works, and the default cwd is the first root.
    const inside = await stack.nodeTransport.exec(node.id, {
      script: "pwd -P",
      cwd: "/tmp",
      timeoutMs: 10_000,
    });
    expect(inside.stdout.trim()).toBe(realpathSync("/tmp"));
  });

  it("caps each output stream at the bash tool's cap", async () => {
    const node = await pair("node-cap", ["/tmp"]);
    spawnAgent(node.token);
    await waitConnected(node.id);
    const result = await stack.nodeTransport.exec(node.id, {
      script: 'for i in $(seq 1 4000); do echo "0123456789abcdefghij"; done',
      timeoutMs: 15_000,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(NODE_OUTPUT_CAP);
    expect(result.stderr.length).toBeLessThanOrEqual(NODE_OUTPUT_CAP);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("surfaces agent death as a structured error, not a hang", async () => {
    const node = await pair("node-dead", ["/tmp"]);
    const child = spawnAgent(node.token);
    await waitConnected(node.id);
    const pending = stack.nodeTransport.exec(node.id, {
      script: "sleep 30",
      timeoutMs: 30_000,
    });
    const killedAt = Date.now();
    child.kill("SIGKILL");
    const started = Date.now();
    await expect(pending).rejects.toThrow(/the node agent disconnected/);
    expect(Date.now() - started).toBeLessThan(10_000); // far below the 30s timeout
    expect(Date.now()).toBeGreaterThanOrEqual(killedAt);
    await expect(
      stack.nodeTransport.exec(node.id, { script: "echo hi", timeoutMs: 2_000 }),
    ).rejects.toThrow(/not connected/);
  });

  it("reconnects with backoff after the server drops a live dial", async () => {
    const node = await pair("node-live", ["/tmp"]);
    spawnAgent(node.token, ["--backoff-ms", "50"]);
    await waitConnected(node.id);
    stack.nodes.drop(node.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitConnected(node.id, 10_000); // the agent redials on its own
    const result = await stack.nodeTransport.exec(node.id, {
      script: "echo back",
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("back\n");
  });

  it("a full turn: the merged bash tool runs target node on the spawned agent", async () => {
    // The bot works in yolo (a recorded default: node rides the bash_host
    // trust class), the org migration leaves the host-access switch on.
    // A DEDICATED owner: unnamed node resolution needs exactly ONE paired
    // node, and the tests above paired theirs under owner-a.
    const owner = "owner-b";
    const { profiles, converse, act, audit } = stack.mind;
    const bot = await profiles.create(owner, { name: "Kestrel", onboard: false });
    await profiles.update(owner, bot.id, {
      hostAccess: true,
      policies: { ...bot.policies, approvalMode: "yolo", autoApprove: [] },
    });
    const chat = await profiles.ensureMain(owner, bot.id);
    const row = await profiles.rowOf(chat.id);
    const key = row !== undefined ? await profiles.keyOfRow(row) : "";
    const cid = String(await Effect.runPromise(converse.conversationIdOf(key as never)));
    const paired = await pairNode(stack.mind.converse, owner, {
      name: "node-e2e",
      roots: ["/tmp"],
    });
    const node = paired.node;
    spawnAgent(paired.token);
    await waitConnected(node.id);
    const tool = act.extension().tools?.find((entry) => entry.name === "bash") as
      | {
          execute: (
            a: never,
            b: never,
            c: never,
          ) => Promise<{
            isError?: boolean;
            output: { text: string }[];
            structuredOutput?: Record<string, unknown>;
          }>;
        }
      | undefined;
    if (tool === undefined) throw new Error("bash is not registered");
    const result = await tool.execute(
      { script: "echo hi", target: "node" } as never,
      { conversationId: cid, callId: "h1" } as never,
      {} as never,
    );
    expect(result.isError).toBeUndefined();
    expect(result.output[0]?.text).toContain("hi");
    expect(result.output[0]?.text).toContain("(ran on node node-e2e)");
    expect(result.structuredOutput).toMatchObject({ target: "node", node: "node-e2e" });
    // The audit answers "where did this run": target + the resolved node id.
    const line = [...audit.tail(20)]
      .reverse()
      .find((event) => event.kind === "tool_call" && event.name === "bash" && event.ok === true);
    expect(line?.bashTarget).toEqual({ target: "node", node: node.id });
    // A name that resolves to nothing refuses with the structured error.
    const bad = await tool.execute(
      { script: "echo hi", target: "node", node: "nope" } as never,
      { conversationId: cid, callId: "h2" } as never,
      {} as never,
    );
    expect(bad.isError).toBe(true);
    expect(bad.output[0]?.text).toContain("no node is paired");
  });
});
