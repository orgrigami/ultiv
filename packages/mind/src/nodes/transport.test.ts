/**
 * The node transport (server side of the /agent dial), unit-tested with
 * fake connections: execs only run while a dial is live, a request's timeout
 * bounds it, a closed or dropped dial rejects its pending execs at once (a
 * dead agent is a structured error, never a hang), a second dial replaces
 * the first, and a ping answers pong. The server waits NODE_EXEC_GRACE_MS
 * past the agent's own timeout (so the agent's partial answer wins), an
 * aborted turn cancels the script on the node, and a roots change reaches a
 * live dial.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  NODE_EXEC_GRACE_MS,
  type NodeAgentInbound,
  type NodeAgentOutbound,
} from "@spriessen/contracts";
import { createNodeTransport, type NodeConn } from "./transport.ts";

/** A fake agent dial: records the frames sent to it, reports how often it closed. */
const fakeConn = (): NodeConn & {
  closes: number;
  frames: NodeAgentOutbound[];
} => {
  const conn = {
    closes: 0,
    frames: [] as NodeAgentOutbound[],
    send: (message: NodeAgentOutbound) => {
      conn.frames.push(message);
    },
    close: () => {
      conn.closes += 1;
    },
  };
  return conn;
};

/** The exec frame a fake agent answers with a result (or an error). */
const answer = (
  transport: ReturnType<typeof createNodeTransport>,
  nodeId: string,
  frames: readonly NodeAgentOutbound[],
  result: { stdout: string; exitCode: number },
): void => {
  const exec = frames.find((frame) => frame.type === "exec");
  if (exec === undefined || exec.type !== "exec") throw new Error("no exec frame was sent");
  transport.receive(nodeId, { type: "result", id: exec.id, stderr: "", ...result });
};

describe("the node transport", () => {
  it("refuses an exec with no live dial", async () => {
    const transport = createNodeTransport();
    await expect(transport.exec("node-x", { script: "echo hi", timeoutMs: 1_000 })).rejects.toThrow(
      /not connected/,
    );
  });

  it("answers a ping with a pong and completes an exec round trip", async () => {
    const transport = createNodeTransport();
    const conn = fakeConn();
    transport.connect("node-x", conn);
    transport.receive("node-x", { type: "ping" });
    expect(conn.frames).toContainEqual({ type: "pong" });
    const pending = transport.exec("node-x", {
      script: "echo hi",
      cwd: "/tmp",
      timeoutMs: 5_000,
    });
    const exec = conn.frames.find((frame) => frame.type === "exec");
    expect(exec).toMatchObject({ type: "exec", script: "echo hi", cwd: "/tmp", timeoutMs: 5_000 });
    answer(transport, "node-x", conn.frames, { stdout: "hi\n", exitCode: 0 });
    await expect(pending).resolves.toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });
  });

  it("drops an answer from the wrong node or a stale id", async () => {
    const transport = createNodeTransport();
    const conn = fakeConn();
    transport.connect("node-x", conn);
    transport.connect("node-y", fakeConn());
    const pending = transport.exec("node-x", { script: "echo hi", timeoutMs: 5_000 });
    // Another node claiming node-x's request id changes nothing.
    transport.receive("node-y", {
      type: "result",
      id: "nope",
      stdout: "evil",
      stderr: "",
      exitCode: 0,
    });
    transport.receive("node-x", {
      type: "result",
      id: "still-nope",
      stdout: "x",
      stderr: "",
      exitCode: 0,
    });
    await expect(
      Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 50))]),
    ).resolves.toBeUndefined(); // still pending: the wrong answers were dropped
    answer(transport, "node-x", conn.frames, { stdout: "hi\n", exitCode: 0 });
    await expect(pending).resolves.toMatchObject({ stdout: "hi\n" });
  });

  it("times out an exec that never answers, after the grace, and cancels it", async () => {
    vi.useFakeTimers();
    try {
      const transport = createNodeTransport();
      const conn = fakeConn();
      transport.connect("node-x", conn);
      const pending = transport.exec("node-x", { script: "sleep", timeoutMs: 80 });
      const outcome = pending.then(
        () => "resolved",
        (cause: unknown) => String(cause),
      );
      await vi.advanceTimersByTimeAsync(80 + NODE_EXEC_GRACE_MS - 1);
      expect(conn.frames.some((frame) => frame.type === "cancel")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatch(/did not answer within 80 ms/);
      expect(conn.frames.at(-1)).toMatchObject({ type: "cancel" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the agent's own timeout answer that lands inside the grace", async () => {
    vi.useFakeTimers();
    try {
      const transport = createNodeTransport();
      const conn = fakeConn();
      transport.connect("node-x", conn);
      const pending = transport.exec("node-x", { script: "echo partial; sleep 9", timeoutMs: 80 });
      await vi.advanceTimersByTimeAsync(80 + 300); // the agent killed it and is answering
      answer(transport, "node-x", conn.frames, { stdout: "partial\n", exitCode: 124 });
      await expect(pending).resolves.toMatchObject({ stdout: "partial\n", exitCode: 124 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an aborted turn sends cancel and rejects at once", async () => {
    const transport = createNodeTransport();
    const conn = fakeConn();
    transport.connect("node-x", conn);
    const controller = new AbortController();
    const pending = transport.exec("node-x", {
      script: "sleep 30",
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const exec = conn.frames.find((frame) => frame.type === "exec");
    controller.abort();
    await expect(pending).rejects.toThrow(/the turn was stopped/);
    expect(conn.frames.at(-1)).toEqual({
      type: "cancel",
      id: exec?.type === "exec" ? exec.id : "",
    });
    // A late answer for the cancelled id is dropped, never a crash.
    answer(transport, "node-x", conn.frames, { stdout: "late", exitCode: 0 });
  });

  it("refuses an exec whose turn already stopped, sending nothing", async () => {
    const transport = createNodeTransport();
    const conn = fakeConn();
    transport.connect("node-x", conn);
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.exec("node-x", { script: "x", timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toThrow(/stopped before the script started/);
    expect(conn.frames).toEqual([]);
  });

  it("pushes a roots change to a live dial, and nothing while offline", () => {
    const transport = createNodeTransport();
    transport.pushRoots("node-x", ["/srv"]); // offline: a no-op
    const conn = fakeConn();
    transport.connect("node-x", conn);
    transport.pushRoots("node-x", ["/srv", "/work"]);
    expect(conn.frames).toEqual([{ type: "roots", roots: ["/srv", "/work"] }]);
  });

  it("rejects pending execs the moment a dial disconnects", async () => {
    const transport = createNodeTransport();
    const conn = fakeConn();
    transport.connect("node-x", conn);
    const pending = transport.exec("node-x", { script: "work", timeoutMs: 30_000 });
    transport.disconnect("node-x", conn);
    await expect(pending).rejects.toThrow(/the node agent disconnected/);
  });

  it("a stale dial closing late leaves the live one alone", async () => {
    const transport = createNodeTransport();
    const first = fakeConn();
    const second = fakeConn();
    transport.connect("node-x", first);
    transport.connect("node-x", second); // replaces the first
    expect(first.closes).toBe(1);
    transport.disconnect("node-x", first); // the replaced dial closes late
    expect(transport.connected("node-x")).toBe(true);
    transport.disconnect("node-x", second);
    expect(transport.connected("node-x")).toBe(false);
  });

  it("drop() closes the dial and rejects its pending execs", async () => {
    const transport = createNodeTransport();
    const conn = fakeConn();
    transport.connect("node-x", conn);
    const pending = transport.exec("node-x", { script: "work", timeoutMs: 30_000 });
    transport.drop("node-x");
    expect(conn.closes).toBe(1);
    expect(transport.connected("node-x")).toBe(false);
    await expect(pending).rejects.toThrow(/the node was revoked/);
  });

  it("a malformed or unknown frame type is ignored", () => {
    const transport = createNodeTransport();
    const conn = fakeConn();
    transport.connect("node-x", conn);
    // These cast on purpose: the wire could always carry something new.
    transport.receive("node-x", {
      type: "result",
      id: "gone",
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    transport.receive("node-x", { nonsense: true } as unknown as NodeAgentInbound);
    expect(conn.frames).toEqual([]); // no pong, no crash
  });
});
