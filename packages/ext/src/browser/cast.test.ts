/**
 * The cast hub against a FAKE streaming backend: the driver protocol lines
 * become frames and events, acts ride stdin, a dead process closes every
 * subscriber, and the idle grace keeps a cast alive through a viewer switch
 * but not forever. The real driver needs chromium; it is exercised by the
 * opt-in real-VM suite (shell/real-vm-cast.test.ts).
 */
import { describe, expect, it } from "vite-plus/test";
import type { ShellBackend, ShellStream } from "../shell/backend.ts";
import { castSessions, type CastEvent } from "./cast.ts";

/** A scriptable stand-in for the in-VM cast process's stdio. */
const fakeStream = (): {
  readonly stream: ShellStream;
  readonly push: (line: string) => void;
  readonly pushErr: (text: string) => void;
  readonly exit: (code: number) => void;
  readonly written: readonly string[];
  readonly stopped: () => boolean;
} => {
  const chunkers: ((chunk: { stdout: boolean; data: Uint8Array }) => void)[] = [];
  const exiters: ((code: number) => void)[] = [];
  const writes: string[] = [];
  let stopped = false;
  const push = (line: string): void => {
    for (const emit of chunkers) {
      emit({ stdout: true, data: new Uint8Array(Buffer.from(`${line}\n`)) });
    }
  };
  const pushErr = (text: string): void => {
    for (const emit of chunkers) {
      emit({ stdout: false, data: new Uint8Array(Buffer.from(text)) });
    }
  };
  return {
    push,
    pushErr,
    exit: (code) => {
      for (const exit of exiters) exit(code);
    },
    get written() {
      return writes;
    },
    stopped: () => stopped,
    stream: {
      onChunk: (listener) => chunkers.push(listener),
      onExit: (listener) => exiters.push(listener),
      write: async (data) => {
        writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      },
      stop: async () => {
        stopped = true;
      },
    },
  };
};

const FRAME =
  '{"t":"frame","id":"f1","data":"/9j/4AAQ","w":1280,"h":800,' +
  '"url":"https://example.test/signin","title":"Sign in"}';

const rig = (idleMs = 8_000) => {
  const process = fakeStream();
  const started: string[] = [];
  const backend: ShellBackend = {
    prepare: async () => undefined,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    listFiles: async () => [],
    readFile: async () => new Uint8Array(),
    stream: async (script) => {
      started.push(script);
      return process.stream;
    },
  };
  const casts = castSessions({ resolveOf: async () => ({ backend }), idleMs });
  return { casts, process, started };
};

const collect = (): { events: CastEvent[]; seen: () => readonly CastEvent[] } => {
  const events: CastEvent[] = [];
  return { events, seen: () => events };
};

describe("the cast hub (fake stream)", () => {
  it("starts the cast driver and turns its lines into events", async () => {
    const { casts, process, started } = rig();
    const session = await casts.for("conv-1");
    expect(started).toHaveLength(1);
    const { events, seen } = collect();
    const off = session.subscribe((event) => events.push(event));
    process.push('{"t":"ready","w":1280,"h":800}');
    process.push(FRAME);
    expect(seen().map((event) => event.kind)).toEqual(["ready", "frame"]);
    const frame = seen()[1];
    if (frame?.kind !== "frame") throw new Error("no frame");
    expect(frame.frame.mime).toBe("image/jpeg");
    expect(frame.frame.url).toBe("https://example.test/signin");
    expect(session.frame?.id).toBe("f1");
    // A late viewer paints instantly: the current frame arrives first.
    const late = collect();
    const offLate = session.subscribe((event) => late.events.push(event));
    expect(late.seen()[0]?.kind).toBe("frame");
    off();
    offLate();
  });

  it("writes acts to the driver's stdin and refuses them once dead", async () => {
    const { casts, process } = rig();
    const session = await casts.for("conv-1");
    await session.act({ a: "tap", x: 10, y: 20, id: "f1" });
    await session.act({ a: "type", text: "hi" });
    expect(process.written).toEqual([
      '{"a":"tap","x":10,"y":20,"id":"f1"}\n',
      '{"a":"type","text":"hi"}\n',
    ]);
    process.exit(0);
    await expect(session.act({ a: "reload" })).rejects.toThrow("no longer live");
  });

  it("closes every subscriber when the process dies, with the stderr tail as the reason", async () => {
    const { casts, process } = rig();
    const session = await casts.for("conv-1");
    const { events, seen } = collect();
    session.subscribe((event) => events.push(event));
    process.pushErr("boom");
    process.exit(1);
    expect(seen().at(-1)).toMatchObject({
      kind: "closed",
      reason: expect.stringContaining("boom"),
    });
  });

  it("ends at once on a fatal driver line", async () => {
    const { casts, process } = rig();
    const session = await casts.for("conv-1");
    const { events, seen } = collect();
    session.subscribe((event) => events.push(event));
    process.push('{"t":"fatal","error":"chromium did not start"}');
    expect(seen().at(-1)).toMatchObject({
      kind: "closed",
      reason: "chromium did not start",
    });
    expect(process.stopped()).toBe(true);
  });

  it("lingers through a viewer switch, stops after the idle grace", async () => {
    const { casts, process } = rig(30);
    const first = await casts.for("conv-1");
    const second = await casts.for("conv-1");
    // Two viewers on ONE process.
    expect(process.stopped()).toBe(false);
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(process.stopped()).toBe(false);
    second.release();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(process.stopped()).toBe(true);
    // A fresh viewer after the grace starts a NEW process.
    const again = await casts.for("conv-1");
    expect(again.frame).toBeNull();
  });

  it("stop() ends the cast for everyone (a finished takeover)", async () => {
    const { casts, process } = rig();
    const session = await casts.for("conv-1");
    const { events, seen } = collect();
    session.subscribe((event) => events.push(event));
    await casts.stop("conv-1");
    expect(process.stopped()).toBe(true);
    expect(seen().at(-1)).toMatchObject({ kind: "closed", reason: "the takeover ended" });
  });

  it("refuses to cast on a backend that cannot stream", async () => {
    const backend: ShellBackend = {
      prepare: async () => undefined,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      listFiles: async () => [],
      readFile: async () => new Uint8Array(),
    };
    const casts = castSessions({ resolveOf: async () => ({ backend }) });
    await expect(casts.for("conv-1")).rejects.toThrow("cannot stream");
  });

  it("two viewers arriving at once share ONE driver (no second launch on the same browser)", async () => {
    const { casts, started } = rig();
    const [a, b] = await Promise.all([casts.for("conv-1"), casts.for("conv-1")]);
    expect(started).toHaveLength(1);
    a.release();
    b.release();
  });

  it("a stop while the driver launches ends that launch as it lands", async () => {
    const { casts, process } = rig();
    const viewer = casts.for("conv-1");
    await casts.stop("conv-1");
    const session = await viewer;
    expect(process.stopped()).toBe(true);
    await expect(session.act({ a: "reload" })).rejects.toThrow("no longer live");
  });
});
