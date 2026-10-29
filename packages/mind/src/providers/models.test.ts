import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { Fetcher } from "./catalog-cache.ts";
import { createCatalog, type CatalogOptions } from "./models.ts";

const model = (name: string) => ({
  name,
  tool_call: true,
  limit: { context: 128_000, output: 8_000 },
});

const BODY = {
  kenari: {
    env: ["KENARI_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://kenari.id/v1",
    name: "Kenari",
    models: { "deepseek-v4-1-flash": model("DeepSeek"), "glm-5-3-flash": model("GLM") },
  },
  acme: {
    env: ["ACME_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://acme.test/v1",
    name: "Acme",
    models: { "acme-1": model("Acme One") },
  },
};

/** A fake models.dev: counts calls, answers 304 to a matching ETag. */
const fakeFetcher = (body: unknown, etag = '"v1"') => {
  const calls: (string | undefined)[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    const sent = (init.headers as Record<string, string>)["if-none-match"];
    calls.push(sent);
    if (sent === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag } });
  };
  return { fetcher, calls };
};

const failingFetcher: Fetcher = async () => {
  throw new Error("offline");
};

const optionsIn = (dir: string, overrides: Partial<CatalogOptions> = {}): CatalogOptions => ({
  url: "https://models.dev/api.json",
  cachePath: join(dir, "models-dev.json"),
  overlayPath: join(dir, "models.local.json"),
  ttlMs: 24 * 3_600_000,
  env: (name) => (name === "KENARI_API_KEY" ? "k" : undefined),
  allow: null,
  preferred: null,
  concurrency: 2,
  checkEveryMs: 0,
  ...overrides,
});

describe("createCatalog", () => {
  it("first boot fetches models.dev, serves configured providers, and caches the body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultiv-catalog-"));
    const { fetcher, calls } = fakeFetcher(BODY);
    const catalog = await createCatalog(optionsIn(dir, { fetcher }));
    expect(calls).toEqual([undefined]);
    expect(catalog.status()).toMatchObject({ source: "network", providers: ["kenari"], models: 2 });
    expect(catalog.list().map((spec) => spec.ref)).toEqual([
      "kenari/deepseek-v4-1-flash",
      "kenari/glm-5-3-flash",
    ]);
    expect(catalog.models.getModel("kenari", "glm-5-3-flash")?.baseUrl).toBe(
      "https://kenari.id/v1",
    );
    expect(JSON.parse(readFileSync(join(dir, "models-dev.json"), "utf8")).etag).toBe('"v1"');
    catalog.close();
  });

  it("later boots serve the cache offline and revalidate with the ETag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultiv-catalog-"));
    const first = await createCatalog(optionsIn(dir, { fetcher: fakeFetcher(BODY).fetcher }));
    first.close();
    const offline = await createCatalog(optionsIn(dir, { url: null }));
    expect(offline.status()).toMatchObject({ source: "cache", models: 2 });
    offline.close();
    const { fetcher, calls } = fakeFetcher(BODY);
    const revalidating = await createCatalog(optionsIn(dir, { fetcher }));
    const status = await revalidating.refresh(true);
    expect(calls).toContain('"v1"');
    expect(status).toMatchObject({ models: 2, error: null });
    revalidating.close();
  });

  it("a failed refresh keeps what it has and reports the error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultiv-catalog-"));
    const catalog = await createCatalog(optionsIn(dir, { fetcher: failingFetcher }));
    expect(catalog.status()).toMatchObject({ source: "none", models: 0 });
    expect(catalog.status().error).toMatch(/offline/);
    // Nothing listed: the default still names a model, so turns fail loudly by name.
    expect(catalog.defaultRef()).toBe("kenari/deepseek-v4-1-flash");
    catalog.close();
  });

  it("applies the owner's overlay and resolves the default model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultiv-catalog-"));
    writeFileSync(
      join(dir, "models.local.json"),
      JSON.stringify({ kenari: { models: { "minimax-m3-1-flash": model("MiniMax") } } }),
    );
    const catalog = await createCatalog(optionsIn(dir, { fetcher: fakeFetcher(BODY).fetcher }));
    expect(catalog.find("minimax-m3-1-flash")?.ref).toBe("kenari/minimax-m3-1-flash");
    expect(catalog.defaultRef()).toBe("kenari/deepseek-v4-1-flash");
    catalog.close();
    const acmeOnly = await createCatalog(
      optionsIn(dir, { url: null, env: (name) => (name === "ACME_API_KEY" ? "k" : undefined) }),
    );
    // The fallback is not configured here: the first listed model stands in.
    expect(acmeOnly.defaultRef()).toBe("acme/acme-1");
    acmeOnly.close();
    const preferred = await createCatalog(optionsIn(dir, { url: null, preferred: "acme/acme-1" }));
    expect(preferred.defaultRef()).toBe("acme/acme-1");
    preferred.close();
  });
});
