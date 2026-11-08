import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import { generateService, type CompletionGateway } from "./generate.ts";

const reply = (text: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "kenari",
    model: "test",
  }) as AssistantMessage;

const models = { getModel: () => ({}) as Model<"openai-completions"> } as unknown as Models;

const gatewayFrom = (
  replies: readonly string[],
): CompletionGateway & { readonly calls: () => number } => {
  let count = 0;
  return {
    complete: async (_model: Model<Api>, _context: Context, _maxTokens: number) => {
      const next = replies[count] ?? replies[0] ?? "";
      count += 1;
      return reply(next);
    },
    calls: () => count,
  };
};

describe("Generate (fake gateway)", () => {
  it("returns the plain completion when no schema is given", async () => {
    const generate = generateService(models, "m", gatewayFrom(["hello world"]));
    expect(await Effect.runPromise(generate.complete({ prompt: "say hi" }))).toBe("hello world");
  });

  it("extracts schema-valid JSON from a fenced reply", async () => {
    const gateway = gatewayFrom(['here you go:\n```json\n{"title":"Hi"}\n```']);
    const generate = generateService(models, "m", gateway);
    const out = await Effect.runPromise(
      generate.extract({ prompt: "title it", schema: obj({ title: str() }, { open: true }) }),
    );
    expect(out.title).toBe("Hi");
  });

  it("repairs once when the first reply is off-schema", async () => {
    const gateway = gatewayFrom(["not json at all", '{"title":"Fixed"}']);
    const generate = generateService(models, "m", gateway);
    const out = await Effect.runPromise(
      generate.extract({ prompt: "title it", schema: obj({ title: str() }, { open: true }) }),
    );
    expect(out.title).toBe("Fixed");
    expect(gateway.calls()).toBe(2);
  });

  it("fails with InvalidInput when both replies are off-schema", async () => {
    const generate = generateService(models, "m", gatewayFrom(["nope", "still nope"]));
    const exit = await Effect.runPromiseExit(
      generate.extract({ prompt: "title it", schema: obj({ title: str() }, { open: true }) }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("InvalidInput");
    }
  });
});
