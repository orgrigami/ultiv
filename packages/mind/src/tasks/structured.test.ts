/**
 * Structured task results: schema checks, reading JSON out of a reply, the
 * one repair turn, and what the parent reads when the task settles.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { TaskInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { parseJsonReply } from "../json-reply.ts";
import { checkResult, resultSchemaProblem, settleStructured } from "./structured.ts";
import { wakeTextOf } from "./wake.ts";

const schema = {
  type: "object",
  properties: { price: { type: "number" }, shop: { type: "string" } },
  required: ["price"],
};

/** A converse whose repair turn answers with `reply`; records the prompts. */
const fakeConverse = (reply: string) => {
  const prompts: string[] = [];
  const converse = {
    turn: (_conversation: unknown, prompt: string) => {
      prompts.push(prompt);
      return Effect.succeed({ text: reply });
    },
  } as unknown as ConverseService;
  return { converse, prompts };
};

const row = (over: Partial<TaskInfo>): TaskInfo => ({
  id: "t1",
  sessionId: "s",
  owner: "agent",
  conversationId: "c",
  prompt: "p",
  status: "done",
  result: null,
  error: null,
  createdAt: 0,
  finishedAt: 1,
  ...over,
});

describe("structured results", () => {
  it("refuses schemas that are not usable", () => {
    expect(resultSchemaProblem(schema)).toBeNull();
    expect(resultSchemaProblem("object")).toMatch(/JSON Schema object/);
    expect(resultSchemaProblem({ description: "x" })).toMatch(/needs a type/);
    expect(resultSchemaProblem({ type: "string", enum: ["x".repeat(9_000)] })).toMatch(/too large/);
  });

  it("reads JSON from fences, prose and arrays", () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Here it is: {"a":1} done')).toEqual({ a: 1 });
    expect(parseJsonReply("[1,2]")).toEqual([1, 2]);
    expect(parseJsonReply("no json here")).toBeUndefined();
  });

  it("names what is wrong with an off-schema reply", () => {
    expect(checkResult(schema, '{"price": 3}')).toEqual({ ok: true, value: { price: 3 } });
    const off = checkResult(schema, '{"price": "3"}');
    expect(off.ok).toBe(false);
    expect(off.ok ? "" : off.reason).toContain("/price");
    expect(checkResult(schema, "sorry")).toEqual({ ok: false, reason: "the reply is not JSON" });
  });

  it("accepts a matching reply without a repair turn", async () => {
    const { converse, prompts } = fakeConverse("unused");
    const out = await settleStructured(converse, {} as never, schema, '{"price": 3}');
    expect(out.structured).toEqual({ price: 3 });
    expect(JSON.parse(out.result)).toEqual({ price: 3 });
    expect(prompts).toEqual([]);
  });

  it("repairs once, and keeps the raw reply when the repair also misses", async () => {
    const fixed = fakeConverse('{"price": 4, "shop": "A"}');
    const repaired = await settleStructured(fixed.converse, {} as never, schema, "about 4");
    expect(repaired.structured).toEqual({ price: 4, shop: "A" });
    expect(fixed.prompts[0]).toContain("[result check]");
    const stuck = fakeConverse("still prose");
    const missed = await settleStructured(stuck.converse, {} as never, schema, "about 4");
    expect(missed).toEqual({ result: "still prose", structured: null });
  });

  it("wakes the parent with a JSON block, or says the format was missed", () => {
    const ok = wakeTextOf(row({ resultSchema: schema, structured: { price: 3 }, result: "{}" }));
    expect(ok).toContain('```json\n{\n  "price": 3\n}\n```');
    const missed = wakeTextOf(row({ resultSchema: schema, structured: null, result: "prose" }));
    expect(missed).toContain("did not match the requested format");
    expect(missed).toContain("prose");
    expect(wakeTextOf(row({ result: "plain" }))).toBe("[task t1 finished]\n\nplain");
  });
});
