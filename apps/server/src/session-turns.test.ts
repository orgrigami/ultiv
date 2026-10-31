import { describe, expect, it } from "vite-plus/test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import {
  adoptedPhase,
  idleIfStalled,
  InFlight,
  queuedOf,
  sameQueue,
  stopChatTasks,
} from "./session-turns.ts";

const viewWith = (items: unknown[]): ConversationView =>
  ({ entries: [], docs: { "pi.inbox": { items } } }) as unknown as ConversationView;

describe("queuedOf", () => {
  it("mirrors queued inputs oldest first, without writes or attachment blocks", () => {
    const view = viewWith([
      { id: 7, mode: "steer", content: "also check the weather" },
      { id: 8, mode: "write", entry: {} },
      {
        id: 9,
        mode: "followUp",
        content: [{ type: "text", text: "then this\n\nAttached artifacts:\n- artifact a1" }],
      },
    ]);
    expect(queuedOf(view)).toEqual([
      { id: "7", text: "also check the weather", mode: "steer" },
      { id: "9", text: "then this", mode: "followUp" },
    ]);
  });

  it("is empty with no inbox doc", () => {
    expect(queuedOf({ entries: [], docs: {} } as unknown as ConversationView)).toEqual([]);
  });

  it("compares queues by id and mode", () => {
    const a = [{ id: "1", text: "x", mode: "steer" as const }];
    expect(sameQueue(a, [{ ...a[0]! }])).toBe(true);
    expect(sameQueue(a, [])).toBe(false);
    expect(sameQueue(a, [{ ...a[0]!, mode: "followUp" }])).toBe(false);
  });
});

describe("InFlight", () => {
  it("reads idle only once the last input settles", () => {
    const inFlight = new InFlight();
    inFlight.start();
    inFlight.start();
    expect(inFlight.finish()).toBe(false);
    expect(inFlight.finish()).toBe(true);
    // Never negative: a stray finish still reads idle.
    expect(inFlight.finish()).toBe(true);
  });
});

describe("adoptedPhase", () => {
  it("a run nobody in this session started (resumed after a restart) reads working, then idle", () => {
    expect(adoptedPhase(true, false, "idle")).toBe("working");
    expect(adoptedPhase(true, false, "error")).toBe("working");
    expect(adoptedPhase(true, false, "working")).toBeUndefined();
    expect(adoptedPhase(false, false, "working")).toBe("idle");
    expect(adoptedPhase(false, false, "error")).toBeUndefined();
  });

  it("leaves the phase to this session's own inputs while they are in flight", () => {
    expect(adoptedPhase(true, true, "idle")).toBeUndefined();
    expect(adoptedPhase(false, true, "working")).toBeUndefined();
  });
});

describe("idleIfStalled", () => {
  it("a stop that leaves messages queued with no run reads idle, never working forever", async () => {
    let idle = 0;
    await idleIfStalled(
      async () => false,
      () => idle++,
      1,
    );
    expect(idle).toBe(1);
  });

  it("keeps working when a run follows (Redirect) or the check fails", async () => {
    let idle = 0;
    await idleIfStalled(
      async () => true,
      () => idle++,
      1,
    );
    await idleIfStalled(
      () => Promise.reject(new Error("gone")),
      () => idle++,
      1,
    );
    expect(idle).toBe(0);
  });
});

describe("stopChatTasks", () => {
  it("quietly cancels only this chat's running tasks", async () => {
    const row = (id: string, conversationId: string, status: string) => ({
      id,
      conversationId,
      status,
    });
    const calls: [string, unknown][] = [];
    const mind = {
      tasks: {
        list: () =>
          Effect.succeed([
            row("a", "chat-1", "running"),
            row("b", "chat-1", "done"),
            row("c", "chat-2", "running"),
            row("d", "chat-1", "running"),
          ]),
        cancel: (id: string, options: unknown) => {
          calls.push([id, options]);
          return Effect.succeed(true);
        },
      },
    } as never;
    expect(await stopChatTasks(mind, "chat-1")).toBe(2);
    expect(calls).toEqual([
      ["a", { quiet: true }],
      ["d", { quiet: true }],
    ]);
  });
});
