/**
 * The node transport (server side of the /agent dial), unit-tested with
 * fake connections: execs only run while a dial is live, a request's timeout
 * bounds it, a closed or dropped dial rejects its pending execs at once (a
 * dead agent is a structured error, never a hang), a second dial replaces
 * the first, and a ping answers pong.
 */
import { describe, expect, it } from "vite-plus/test";
import type { NodeAgentInbound, NodeAgentOutbound } from "@spriessen/contracts";
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

  it("times out an exec that never answers", async () => {
    const transport = createNodeTransport();
    transport.connect("node-x", fakeConn());
    const started = Date.now();
    await expect(transport.exec("node-x", { script: "sleep", timeoutMs: 80 })).rejects.toThrow(
      /did not answer within 80 ms/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
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
