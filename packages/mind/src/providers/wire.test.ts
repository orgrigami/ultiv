import { describe, expect, it } from "vite-plus/test";
import { mergeOverlay, parseCatalog, type CatalogProvider } from "./catalog.ts";
import { normalizeRef, parseRef, specOf } from "./refs.ts";
import { enabled, expandUrl, modelOf, providerOf } from "./wire.ts";

/** A models.dev-shaped fixture: one gateway, one first-party SDK provider, one aggregator. */
const RAW = {
  kenari: {
    id: "kenari",
    env: ["KENARI_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://kenari.id/v1",
    name: "Kenari",
    models: {
      "deepseek-v4-1-flash": {
        id: "deepseek-v4-1-flash",
        name: "DeepSeek V4.1 Flash",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_000_000, output: 384_000 },
        cost: { input: 0.157, output: 0.314, cache_read: 0.0037 },
      },
      "glm-5-3-flash": {
        id: "glm-5-3-flash",
        name: "GLM-5.3-Flash",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        tool_call: true,
        limit: { context: 1_000_000, output: 131_072 },
      },
      "nano-banana": {
        id: "nano-banana",
        name: "Nano Banana",
        type: "image",
        tool_call: false,
        limit: { context: 32_000, output: 8_000 },
      },
      "old-model": {
        id: "old-model",
        name: "Old",
        status: "deprecated",
        tool_call: true,
        limit: { context: 32_000, output: 8_000 },
      },
      broken: { id: "broken", name: "No limits" },
    },
  },
  anthropic: {
    id: "anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    name: "Anthropic",
    models: {
      "claude-x": {
        id: "claude-x",
        name: "Claude X",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }],
        tool_call: true,
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
  gateway: {
    id: "gateway",
    env: ["GATEWAY_ACCOUNT_ID", "GATEWAY_API_TOKEN"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://gw.example/${GATEWAY_ACCOUNT_ID}/v1",
    name: "Gateway",
    models: {
      "anthropic/claude-x": {
        id: "anthropic/claude-x",
        name: "Claude X via gateway",
        reasoning: true,
        reasoning_options: [],
        tool_call: true,
        limit: { context: 200_000, output: 64_000 },
        provider: { npm: "@ai-sdk/anthropic", api: "https://gw.example/anthropic/v1" },
      },
    },
  },
  bedrock: { id: "bedrock", env: ["AWS_KEY"], npm: "@ai-sdk/amazon-bedrock", models: {} },
  junk: "not a provider",
};

const catalog = parseCatalog(RAW);
const kenari = catalog.kenari as CatalogProvider;
const env = (values: Record<string, string>) => (name: string) => values[name];

describe("parseCatalog", () => {
  it("keeps parseable providers and models, drops the rest", () => {
    expect(Object.keys(catalog).sort()).toEqual(["anthropic", "bedrock", "gateway", "kenari"]);
    expect(Object.keys(kenari.models)).not.toContain("broken");
    expect(kenari.models["deepseek-v4-1-flash"]?.cost.cacheRead).toBe(0.0037);
  });

  it("merges an overlay: new models on a known provider, whole new providers", () => {
    const merged = mergeOverlay(catalog, {
      kenari: {
        models: {
          "minimax-m3-1-flash": {
            name: "MiniMax M3.1 Flash",
            tool_call: true,
            limit: { context: 1_000_000, output: 512_000 },
          },
        },
      },
      local: { npm: "@ai-sdk/openai-compatible", api: "http://127.0.0.1:1234/v1", models: {} },
    });
    expect(Object.keys(merged.kenari?.models ?? {})).toContain("minimax-m3-1-flash");
    expect(Object.keys(merged.kenari?.models ?? {})).toContain("deepseek-v4-1-flash");
    expect(merged.kenari?.api).toBe("https://kenari.id/v1");
    expect(merged.local?.api).toBe("http://127.0.0.1:1234/v1");
  });
});

describe("modelOf", () => {
  it("wires chat models and skips image, deprecated and unsupported entries", () => {
    const ids = Object.values(kenari.models).flatMap((model) => {
      const wired = modelOf(kenari, model, env({}));
      return wired !== undefined ? [wired.id] : [];
    });
    expect(ids.sort()).toEqual(["deepseek-v4-1-flash", "glm-5-3-flash"]);
  });

  it("offers each model its own efforts, lowest as the default", () => {
    const spec = (id: string) => {
      const model = kenari.models[id];
      const wired = model !== undefined ? modelOf(kenari, model, env({})) : undefined;
      return wired !== undefined ? specOf(wired, "Kenari") : undefined;
    };
    expect(spec("deepseek-v4-1-flash")).toMatchObject({
      ref: "kenari/deepseek-v4-1-flash",
      efforts: ["off", "low", "high", "max"],
      defaultEffort: "off",
    });
    expect(spec("glm-5-3-flash")).toMatchObject({
      efforts: ["low", "high", "max"],
      defaultEffort: "low",
    });
  });

  it("uses the SDK's default endpoint and strips the /v1 Anthropic adds itself", () => {
    const anthropic = catalog.anthropic as CatalogProvider;
    const claude = modelOf(anthropic, anthropic.models["claude-x"]!, env({}));
    expect(claude).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    const gateway = catalog.gateway as CatalogProvider;
    const routed = modelOf(gateway, gateway.models["anthropic/claude-x"]!, env({}));
    expect(routed).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://gw.example/anthropic",
    });
    // A reasoning model with no listed control offers no effort at all.
    expect(routed !== undefined ? specOf(routed, "Gateway").efforts : null).toEqual([]);
  });

  it("expands ${VAR} endpoints and gives up when a part is unset", () => {
    expect(expandUrl("https://gw/${A}/v1/", env({ A: "acct" }))).toBe("https://gw/acct/v1");
    expect(expandUrl("https://gw/${A}/v1", env({}))).toBeUndefined();
  });
});

describe("providerOf", () => {
  it("registers a provider only when one of its keys is set", () => {
    expect(enabled(kenari, { env: env({}), allow: null })).toBe(false);
    expect(enabled(kenari, { env: env({ KENARI_API_KEY: "k" }), allow: null })).toBe(true);
    // The allowlist narrows even a configured provider.
    const allow = new Set(["anthropic"]);
    expect(enabled(kenari, { env: env({ KENARI_API_KEY: "k" }), allow })).toBe(false);
  });

  it("reads the key from the key-shaped env var, not URL parts", () => {
    const gateway = catalog.gateway as CatalogProvider;
    expect(enabled(gateway, { env: env({ GATEWAY_ACCOUNT_ID: "a" }), allow: null })).toBe(false);
    const wired = providerOf(gateway, {
      env: env({ GATEWAY_ACCOUNT_ID: "a", GATEWAY_API_TOKEN: "t" }),
      allow: null,
    });
    expect(wired?.getModels().map((model) => model.id)).toEqual(["anthropic/claude-x"]);
  });

  it("skips providers whose wire format the mind does not speak", () => {
    const bedrock = catalog.bedrock as CatalogProvider;
    expect(providerOf(bedrock, { env: env({ AWS_KEY: "k" }), allow: null })).toBeUndefined();
  });

  it("serves a keyless provider only when the owner allowlists it", () => {
    const local = parseCatalog({
      local: {
        npm: "@ai-sdk/openai-compatible",
        api: "http://127.0.0.1:1234/v1",
        env: [],
        models: { tiny: { tool_call: true, limit: { context: 8192, output: 1024 } } },
      },
    }).local as CatalogProvider;
    expect(providerOf(local, { env: env({}), allow: null })).toBeUndefined();
    expect(providerOf(local, { env: env({}), allow: new Set(["local"]) })?.id).toBe("local");
  });
});

describe("refs", () => {
  it("splits at the first slash; bare legacy ids were kenari's", () => {
    expect(parseRef("openrouter/anthropic/claude-x")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-x",
    });
    expect(normalizeRef("glm-5-3-flash")).toBe("kenari/glm-5-3-flash");
    expect(normalizeRef("kenari/glm-5-3-flash")).toBe("kenari/glm-5-3-flash");
  });
});
