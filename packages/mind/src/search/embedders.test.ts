/**
 * Where embeddings come from: a catalog provider's own endpoint and key
 * (kenari, OpenRouter, Google's OpenAI-compatible path, Mistral's /v1; never
 * Anthropic), any OpenAI-compatible URL, or Ollama — against a fake
 * OpenAI-shaped server end to end; the remote rule (tool results stay off a
 * third party's server); and configuration that cannot be read turning the
 * leg off rather than the app.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { createCatalog } from "../providers/models.ts";
import { embeddingEndpointOf } from "../providers/embedding-endpoint.ts";
import type { CatalogProvider } from "../providers/catalog.ts";
import { openSearchDb } from "./db.ts";
import { messageSearch } from "./messages.ts";
import { embedderFromEnv, embedsTools, isLocalUrl } from "./embedders.ts";
import type { Embedder } from "./vectors.ts";

let server: Server;
let base = "";
const seen: { path: string; auth: string | undefined; body: { model: string; input: string[] } }[] =
  [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; input: string[] };
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      if (body.model === "broken") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "bad key sk-secret-echo" }));
        return;
      }
      // Answer out of order: the client must sort by index.
      const data = body.input.map((text, index) => ({ index, embedding: [text.length, index, 1] }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: data.reverse() }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const provider = (overrides: Partial<CatalogProvider>): CatalogProvider => ({
  id: "kenari",
  name: "Kenari",
  env: ["KENARI_API_KEY"],
  npm: "@ai-sdk/openai-compatible",
  api: "https://kenari.id/v1",
  models: {},
  ...overrides,
});
const keyed = (name: string) =>
  name === "KENARI_API_KEY" || name.endsWith("_API_KEY") ? "k-1" : undefined;

describe("a provider's embedding endpoint", () => {
  it("uses the endpoint and key the provider's chat models use", () => {
    expect(embeddingEndpointOf(provider({}), keyed, null)).toEqual({
      provider: "kenari",
      baseUrl: "https://kenari.id/v1",
      apiKey: "k-1",
    });
    const google = provider({
      id: "google",
      name: "Google",
      env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      npm: "@ai-sdk/google",
      api: undefined as never,
    });
    expect(embeddingEndpointOf(google, keyed, null)).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
    const mistral = provider({
      id: "mistral",
      name: "Mistral",
      env: ["MISTRAL_API_KEY"],
      npm: "@ai-sdk/mistral",
      api: undefined as never,
    });
    expect(embeddingEndpointOf(mistral, keyed, null)).toMatchObject({
      baseUrl: "https://api.mistral.ai/v1",
    });
  });

  it("says why when a provider cannot embed", () => {
    const anthropic = provider({
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic",
    });
    expect(embeddingEndpointOf(anthropic, keyed, null)).toMatchObject({
      problem: expect.stringContaining("no embedding API"),
    });
    expect(embeddingEndpointOf(provider({}), () => undefined, null)).toMatchObject({
      problem: expect.stringContaining("KENARI_API_KEY"),
    });
    // A keyless local server listed in SPRIESSEN_PROVIDERS needs no key.
    const local = provider({
      id: "lmstudio",
      name: "LM Studio",
      env: [],
      api: "http://127.0.0.1:1234/v1",
    });
    expect(embeddingEndpointOf(local, () => undefined, new Set(["lmstudio"]))).toMatchObject({
      apiKey: undefined,
    });
  });
});

describe("embedders", () => {
  it("embeds through a catalog provider end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spriessen-embed-"));
    writeFileSync(
      join(dir, "models.local.json"),
      JSON.stringify({
        gateway: {
          name: "Gateway",
          npm: "@ai-sdk/openai-compatible",
          api: `${base}/v1`,
          env: ["GATEWAY_API_KEY"],
          models: {},
        },
      }),
    );
    const catalog = await createCatalog({
      url: null,
      cachePath: join(dir, "models-dev.json"),
      overlayPath: join(dir, "models.local.json"),
      ttlMs: 1,
      kenariUrl: null,
      kenariCachePath: join(dir, "kenari.json"),
      kenariTtlMs: 1,
      env: (name) => (name === "GATEWAY_API_KEY" ? "gk-9" : undefined),
      allow: null,
      preferred: null,
      concurrency: 1,
      checkEveryMs: 0,
    });
    const env = (name: string) =>
      name === "MEMORY_EMBEDDINGS" ? "gateway/text-embed-small" : undefined;
    const embedder = embedderFromEnv(env, (id) => catalog.embeddingEndpointOf(id));
    expect(embedder?.model).toBe("gateway:text-embed-small");
    expect(embedder?.remote()).toBe(false);
    const vectors = await embedder?.embed(["hello", "bye"]);
    expect(vectors?.map((vector) => [...vector])).toEqual([
      [5, 0, 1],
      [3, 1, 1],
    ]);
    const last = seen.at(-1);
    expect(last?.path).toBe("/v1/embeddings");
    expect(last?.auth).toBe("Bearer gk-9");
    expect(last?.body.model).toBe("text-embed-small");
    catalog.close();
  });

  it("reads every configuration, and turns the leg off on one it cannot read", () => {
    const envOf = (values: Record<string, string>) => (name: string) => values[name];
    expect(embedderFromEnv(envOf({}))).toBeUndefined();
    expect(embedderFromEnv(envOf({ MEMORY_EMBEDDINGS: "off" }))).toBeUndefined();
    expect(embedderFromEnv(envOf({ MEMORY_EMBEDDINGS: "ollama" }))?.model).toBe(
      "ollama:embeddinggemma",
    );
    expect(embedderFromEnv(envOf({ MEMORY_EMBEDDINGS: "openai-compatible" }))).toBeUndefined();
    const compatible = embedderFromEnv(
      envOf({
        MEMORY_EMBEDDINGS: "openai-compatible",
        EMBEDDING_URL: "https://api.example.com/v1",
        EMBEDDING_MODEL: "e5",
      }),
    );
    expect(compatible?.model).toBe("openai-compatible:e5");
    expect(compatible?.remote()).toBe(true);
    expect(
      embedderFromEnv(envOf({ MEMORY_EMBEDDINGS: "kenari/x" }), () => ({ problem: "no" }))?.model,
    ).toBe("kenari:x");
    expect(embedderFromEnv(envOf({ MEMORY_EMBEDDINGS: "maybe" }))).toBeUndefined();
  });

  it("refuses with the status only, never the endpoint's echo", async () => {
    const embedder = embedderFromEnv(
      (name) =>
        ({
          MEMORY_EMBEDDINGS: "openai-compatible",
          EMBEDDING_URL: `${base}/v1`,
          EMBEDDING_MODEL: "broken",
        })[name],
    );
    await expect(embedder?.embed(["x"])).rejects.toThrow(/answered 401$/);
  });

  it("tells the owner's own network from a third party", () => {
    for (const url of [
      "http://127.0.0.1:11434",
      "http://localhost:1234/v1",
      "http://[::1]:8080",
      "http://192.168.1.9:11434",
      "http://10.0.0.2",
      "http://100.101.102.103:11434",
      "https://mac.tail1234.ts.net/v1",
      "http://nas.local:11434",
    ]) {
      expect(isLocalUrl(url), url).toBe(true);
    }
    for (const url of [
      "https://kenari.id/v1",
      "https://openrouter.ai/api/v1",
      "http://8.8.8.8",
      "not a url",
    ]) {
      expect(isLocalUrl(url), url).toBe(false);
    }
  });
});

describe("the remote rule", () => {
  it("never sends tool results to a remote embedder", async () => {
    const sent: string[] = [];
    const remote: Embedder = {
      model: "remote:m",
      remote: () => true,
      embed: async (texts) => {
        sent.push(...texts);
        return texts.map(() => Float32Array.from([1, 0]));
      },
    };
    expect(embedsTools(remote, () => undefined)).toBe(false);
    expect(
      embedsTools(remote, (name) => (name === "EMBEDDING_INCLUDE_TOOLS" ? "on" : undefined)),
    ).toBe(true);
    const messages = messageSearch(openSearchDb(":memory:"), remote);
    const entry = (id: number, kind: string, text: string) =>
      ({
        id,
        conversationId: 1,
        kind,
        model: [{ role: "x", content: [{ type: "text", text }], timestamp: 9 }],
      }) as never;
    await messages.sync(
      { owner: "o", profile: "p" },
      [{ conversation: "c", session: "s" }],
      async (_c, after) =>
        after === 0
          ? [
              entry(1, "pi.user", "plan the garden"),
              entry(2, "pi.tool-result", "PRIVATE MAIL BODY"),
            ]
          : [],
    );
    await messages.search({ owner: "o", profile: "p", query: "garden", limit: 5 });
    expect(sent).toContain("plan the garden");
    expect(sent.some((text) => text.includes("PRIVATE MAIL"))).toBe(false);
  });
});

describe("a mind with meaning search on", () => {
  it("embeds through the configured endpoint and reports how it went", async () => {
    const saved = { ...process.env };
    process.env.MEMORY_EMBEDDINGS = "openai-compatible";
    process.env.EMBEDDING_URL = `${base}/v1`;
    process.env.EMBEDDING_MODEL = "mind-embed";
    try {
      const handle = await openMind({ storage: new MemoryStorage() });
      const { mind } = handle;
      expect(mind.meaning()).toMatchObject({
        model: "openai-compatible:mind-embed",
        remote: false,
        lastOkAt: null,
      });
      const bot = await mind.profiles.create("o", { name: "B", onboard: false });
      await mind.memory.writeV2({
        owner: "o",
        profileId: bot.id,
        scope: "profile",
        writer: bot.id,
        text: "Harry's garden has tomatoes",
      });
      const before = seen.length;
      await mind.memory.recallV2("o", bot.id, { query: "what grows at home" });
      expect(seen.slice(before).some((call) => call.body.model === "mind-embed")).toBe(true);
      expect(mind.meaning().lastOkAt).not.toBeNull();
      await handle.close();
    } finally {
      for (const key of ["MEMORY_EMBEDDINGS", "EMBEDDING_URL", "EMBEDDING_MODEL"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
