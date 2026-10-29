import { describe, expect, it } from "vite-plus/test";
import { parseCatalog, type Catalog } from "./catalog.ts";
import { applyKenari, kenariModelOf, parseKenariListing } from "./kenari.ts";

const chat = (overrides: Record<string, unknown> = {}) => ({
  id: "glm-5-3",
  name: "GLM",
  endpoints: ["chat"],
  modalities: { input: ["text"], output: ["text"] },
  context_length: 200_000,
  max_output_tokens: 32_768,
  tool_call: true,
  ...overrides,
});

describe("kenariModelOf", () => {
  it("maps a chat entry with flat reasoning options into a catalog model", () => {
    const model = kenariModelOf(chat({ reasoning_options: ["none", "low", "high", "max"] }));
    expect(model).toMatchObject({
      id: "glm-5-3",
      reasoning: true,
      reasoningOptions: [{ type: "effort", values: ["none", "low", "high", "max"] }],
      toolCall: true,
      context: 200_000,
      maxOutput: 32_768,
      input: ["text"],
      output: ["text"],
    });
  });

  it("reads a bare reasoning toggle and infers reasoning from it", () => {
    const model = kenariModelOf(chat({ reasoning_toggle: true }));
    expect(model?.reasoning).toBe(true);
    expect(model?.reasoningOptions).toEqual([{ type: "toggle" }]);
  });

  it("labels non-chat kinds and retires sunset entries", () => {
    const image = kenariModelOf(
      chat({ id: "gpt-image-2", endpoints: ["images"], tool_call: false }),
    );
    expect(image?.type).toBe("image");
    const sunset = kenariModelOf(chat({ id: "old", sunset_at: "2026-01-01" }));
    expect(sunset?.status).toBe("deprecated");
  });

  it("drops entries without an id or a context window", () => {
    expect(kenariModelOf(chat({ id: "" }))).toBeUndefined();
    expect(kenariModelOf(chat({ context_length: 0 }))).toBeUndefined();
    expect(kenariModelOf("nope")).toBeUndefined();
  });
});

describe("applyKenari", () => {
  const base: Catalog = parseCatalog({
    kenari: {
      env: ["KENARI_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://kenari.id/v1",
      models: {
        "glm-5-3": {
          name: "GLM",
          tool_call: true,
          limit: { context: 128_000 },
          cost: { input: 0.1 },
        },
        retired: { name: "Retired", tool_call: true, limit: { context: 128_000 } },
      },
    },
  });

  it("replaces the model set, keeping models.dev USD costs for shared ids", () => {
    const listing = parseKenariListing({
      data: [
        chat({ id: "glm-5-3" }),
        chat({ id: "claude-opus-5-5", name: "Opus", reasoning: true }),
      ],
    });
    const merged = applyKenari(base, listing);
    const models = merged.kenari?.models ?? {};
    expect(Object.keys(models).sort()).toEqual(["claude-opus-5-5", "glm-5-3"]);
    // models.dev prices survive for the shared id; the live-only one is unpriced.
    expect(models["glm-5-3"]?.cost).toMatchObject({ input: 0.1 });
    expect(models["claude-opus-5-5"]?.cost).toMatchObject({ input: 0 });
  });

  it("leaves the catalog untouched without a listing, an empty one, or no kenari", () => {
    expect(applyKenari(base, undefined)).toBe(base);
    expect(applyKenari(base, {})).toBe(base);
    const empty = parseCatalog({});
    expect(applyKenari(empty, parseKenariListing({ data: [chat()] }))).toBe(empty);
  });
});
