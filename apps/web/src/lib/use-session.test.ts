/**
 * A fresh Session object starts empty and publishes its history only after
 * the server loads it; the chat must keep what it shows (or its skeleton)
 * until then, never flash "new chat" or blank on a reconnect.
 */
import { describe, expect, it } from "vite-plus/test";
import type { SessionRef } from "./chord.ts";
import { bindLoadedCells } from "./use-session.ts";

/** A cell like chord's: subscribe hears the current value at once, then changes. */
const cell = <T>(initial: T) => {
  let value = initial;
  const listeners = new Set<(next: T) => void>();
  return {
    subscribe: (fn: (next: T) => void) => {
      listeners.add(fn);
      fn(value);
      return () => listeners.delete(fn);
    },
    set: (next: T) => {
      value = next;
      for (const fn of listeners) fn(next);
    },
  };
};

const fakeSession = () => {
  const cells = {
    transcript: cell<unknown[]>([]),
    queued: cell<unknown[]>([]),
    conversationId: cell<string | null>(null),
  };
  return { cells, ref: cells as unknown as SessionRef };
};

const recorder = () => {
  const seen = { transcript: [] as unknown[][], queued: [] as unknown[][], loaded: 0, id: "" };
  return {
    seen,
    setters: {
      transcript: (value: unknown[]) => seen.transcript.push(value),
      queued: (value: unknown[]) => seen.queued.push(value),
      conversationId: (value: string) => (seen.id = value),
      loaded: () => (seen.loaded += 1),
    },
  };
};

describe("bindLoadedCells", () => {
  it("holds the empty start back until the server has loaded the chat", () => {
    const { cells, ref } = fakeSession();
    const { seen, setters } = recorder();
    bindLoadedCells(ref, setters as never);
    expect(seen.transcript).toEqual([]);
    cells.transcript.set([{ kind: "user" }, { kind: "assistant" }]);
    expect(seen.transcript).toEqual([]);
    cells.conversationId.set("conv-1");
    expect(seen.transcript).toEqual([[{ kind: "user" }, { kind: "assistant" }]]);
    expect(seen.loaded).toBe(1);
    expect(seen.id).toBe("conv-1");
    // After loading, every publication passes straight through.
    cells.transcript.set([{ kind: "user" }]);
    expect(seen.transcript).toHaveLength(2);
  });

  it("an empty chat that loads empty is loaded and empty", () => {
    const { cells, ref } = fakeSession();
    const { seen, setters } = recorder();
    bindLoadedCells(ref, setters as never);
    cells.conversationId.set("conv-2");
    expect(seen.transcript).toEqual([[]]);
    expect(seen.queued).toEqual([[]]);
    expect(seen.loaded).toBe(1);
  });
});
