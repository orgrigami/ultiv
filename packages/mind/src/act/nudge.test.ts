/**
 * The background-work nudge: appends at the threshold, once per cooldown,
 * and stays quiet on errors, empty outputs, and when the gate says no.
 */
import { describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { TASK_NUDGE, withTaskNudge, type NudgeGate } from "./nudge.ts";

const tool = (): ToolRegistration<typeof Params> => ({
  name: "web_fetch",
  description: "reads a page",
  parameters: Type.Object({}),
  execute: async () => ({ output: [{ type: "text" as const, text: "page body" }] }),
});
const Params = Type.Object({});

const api = { conversationId: "conv-1" } as never;
const gate = (allowed = true): NudgeGate => ({
  maySpawn: async () => allowed,
});

const texts = (result: { output?: ReadonlyArray<unknown> }): string =>
  (result.output ?? [])
    .map((block) => (block as { text?: string }).text ?? "")
    .join(" ")
    .trim();

describe("withTaskNudge", () => {
  it("stays quiet while the stretch is short and quick", async () => {
    let at = 0;
    const wrapped = withTaskNudge(tool(), gate(), () => at);
    for (let i = 0; i < 5; i += 1) {
      at += 1000;
      const result = await wrapped.execute({}, api, undefined as never);
      expect(texts(result)).toBe("page body");
    }
  });

  it("appends once the stretch crosses the call threshold", async () => {
    let at = 0;
    const wrapped = withTaskNudge(tool(), gate(), () => at);
    for (let i = 0; i < 7; i += 1) {
      at += 1000;
      await wrapped.execute({}, api, undefined as never);
    }
    at += 1000;
    const result = await wrapped.execute({}, api, undefined as never);
    expect(texts(result)).toBe(`page body ${TASK_NUDGE}`);
  });

  it("one slow call is evidence on its own", async () => {
    let at = 0;
    const slowTool: ToolRegistration<typeof Params> = {
      ...tool(),
      execute: async () => {
        at += 31_000; // the call itself burns half a minute
        return { output: [{ type: "text" as const, text: "page body" }] };
      },
    };
    const wrapped = withTaskNudge(slowTool, gate(), () => at);
    const result = await wrapped.execute({}, api, undefined as never);
    expect(texts(result)).toContain("task_spawn");
  });

  it("respects the cooldown: the next stretch stays quiet", async () => {
    let at = 0;
    const wrapped = withTaskNudge(tool(), gate(), () => at);
    for (let i = 0; i < 8; i += 1) {
      at += 1000;
      await wrapped.execute({}, api, undefined as never);
    }
    at += 11 * 60_000;
    let result: { output?: ReadonlyArray<unknown> } = {};
    for (let i = 0; i < 8; i += 1) {
      at += 1000;
      result = await wrapped.execute({}, api, undefined as never);
      if (i < 7) expect(texts(result)).toBe("page body");
    }
    // The second stretch reaches the threshold after the cooldown expired.
    expect(texts(result)).toBe(`page body ${TASK_NUDGE}`);
  });

  it("does not count stretches separated by a quiet gap", async () => {
    let at = 0;
    const wrapped = withTaskNudge(tool(), gate(), () => at);
    for (let i = 0; i < 5; i += 1) {
      at += 1000;
      await wrapped.execute({}, api, undefined as never);
    }
    // A long pause: an older stretch ages out of the window entirely.
    at += 6 * 60_000;
    for (let i = 0; i < 5; i += 1) {
      at += 1000;
      const result = await wrapped.execute({}, api, undefined as never);
      expect(texts(result)).toBe("page body");
    }
  });

  it("stays silent when the gate refuses", async () => {
    let at = 0;
    const wrapped = withTaskNudge(tool(), gate(false), () => at);
    for (let i = 0; i < 8; i += 1) {
      at += 1000;
      const result = await wrapped.execute({}, api, undefined as never);
      expect(texts(result)).toBe("page body");
    }
  });

  it("never nudges on an error result", async () => {
    let at = 0;
    const failing: ToolRegistration<typeof Params> = {
      ...tool(),
      execute: async () => ({ output: [{ type: "text" as const, text: "boom" }], isError: true }),
    };
    const wrapped = withTaskNudge(failing, gate(), () => at);
    for (let i = 0; i < 8; i += 1) {
      at += 1000;
      const result = await wrapped.execute({}, api, undefined as never);
      expect(texts(result)).toBe("boom");
    }
  });

  it("keeps structuredOutput and other fields intact", async () => {
    let at = 0;
    const rich: ToolRegistration<typeof Params> = {
      ...tool(),
      execute: async () => ({
        output: [{ type: "text" as const, text: "ok" }],
        structuredOutput: { id: "t1", status: "done" },
      }),
    };
    const wrapped = withTaskNudge(rich, gate(), () => at);
    for (let i = 0; i < 8; i += 1) {
      at += 1000;
      await wrapped.execute({}, api, undefined as never);
    }
    at += 1000;
    const result = await wrapped.execute({}, api, undefined as never);
    if (!("structuredOutput" in result) || result.structuredOutput === undefined) {
      throw new Error("structuredOutput lost");
    }
    expect(result.structuredOutput).toEqual({ id: "t1", status: "done" });
  });
});
