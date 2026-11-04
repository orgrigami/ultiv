import { describe, expect, it } from "vite-plus/test";
import { meaningLine } from "./meaning-text.ts";

const when = (at: number) => `t${at}`;
const on = {
  model: "kenari:emb",
  remote: true,
  tools: false,
  lastOkAt: null,
  lastError: null,
  lastErrorAt: null,
};

describe("meaning search line", () => {
  it("says words only when off", () => {
    expect(meaningLine(undefined, when).title).toBe("Memory search by words");
    expect(meaningLine({ ...on, model: null }, when).detail).toContain("MEMORY_EMBEDDINGS");
  });

  it("says where texts go, and that tool results stay when remote", () => {
    const line = meaningLine({ ...on, lastOkAt: 5 }, when);
    expect(line.title).toBe("Memory search by words and meaning");
    expect(line.detail).toContain("off this machine");
    expect(line.detail).toContain("tool results stay here");
    expect(line.detail).toContain("Last worked t5");
    expect(meaningLine({ ...on, remote: false }, when).detail).toContain("your own machine");
  });

  it("warns while the last call failed, and clears once one works", () => {
    const failing = meaningLine(
      { ...on, lastOkAt: 1, lastError: "the embedding endpoint answered 401", lastErrorAt: 2 },
      when,
    );
    expect(failing.warn).toBe(true);
    expect(failing.detail).toContain("answered 401");
    expect(meaningLine({ ...on, lastOkAt: 3, lastError: "x", lastErrorAt: 2 }, when).warn).toBe(
      false,
    );
  });
});
