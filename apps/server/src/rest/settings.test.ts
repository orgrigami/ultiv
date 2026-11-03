import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import type { RouteArgs } from "./types.ts";
import { settingsRoutes } from "./settings.ts";

// One keyless local provider from an overlay, offline: a LIVE catalog for the
// PUT validation to accept and refuse against.
const scratch = mkdtempSync(join(tmpdir(), "spriessen-settings-"));
process.env.MODELS_DEV_URL = "off";
process.env.MODELS_DEV_CACHE = join(scratch, "models-dev.json");
process.env.MODELS_OVERLAY = join(scratch, "models.local.json");
process.env.KENARI_MODELS_CACHE = join(scratch, "kenari-models.json");
process.env.SPRIESSEN_PROVIDERS = "smoke-local";
delete process.env.SPRIESSEN_MODEL;
writeFileSync(
  process.env.MODELS_OVERLAY,
  JSON.stringify({
    "smoke-local": {
      name: "Smoke Local",
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:9/v1",
      env: [],
      models: {
        tiny: { id: "tiny", name: "Tiny", tool_call: true, limit: { context: 8192, output: 1024 } },
      },
    },
  }),
);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Minimal RouteArgs over a real offline mind; captures the JSON response. */
const routeArgs = (
  mind: Awaited<ReturnType<typeof openMind>>["mind"],
  opts: { path: string; method?: string; body?: unknown },
): { args: RouteArgs; status: () => number; body: () => any } => {
  let captured: { status: number; body: unknown } | undefined;
  return {
    args: {
      mind,
      scheduler: {} as RouteArgs["scheduler"],
      req: { method: opts.method ?? "GET" } as RouteArgs["req"],
      res: {} as RouteArgs["res"],
      url: new URL(`http://localhost${opts.path}`),
      owner: "harry",
      path: opts.path,
      json: (status, body) => {
        captured = { status, body };
      },
      readJson: async <T>() => (opts.body ?? {}) as T,
      readBody: async () => Buffer.from(JSON.stringify(opts.body ?? {})),
    },
    status: () => captured?.status ?? 0,
    body: () => captured?.body,
  };
};

describe("GET/PUT /api/settings/model", () => {
  it("GET carries the workspace default labelled by source; PUT stores over it", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    // SPRIESSEN_MODEL is unset in this run: both tiers empty → no default.
    const fresh = routeArgs(handle.mind, { path: "/api/settings/model" });
    expect(await settingsRoutes(fresh.args)).toBe(true);
    expect(fresh.status()).toBe(200);
    expect(fresh.body()).toEqual({ defaultModel: null });

    // PUT stores; GET labels it "db".
    const put = routeArgs(handle.mind, {
      path: "/api/settings/model",
      method: "PUT",
      body: { ref: "smoke-local/tiny", effort: "high" },
    });
    expect(await settingsRoutes(put.args)).toBe(true);
    expect(put.status()).toBe(200);
    expect(put.body()).toEqual({
      defaultModel: { ref: "smoke-local/tiny", effort: "high", source: "db" },
    });
    const reread = routeArgs(handle.mind, { path: "/api/settings/model" });
    expect(await settingsRoutes(reread.args)).toBe(true);
    expect(reread.body()).toEqual({
      defaultModel: { ref: "smoke-local/tiny", effort: "high", source: "db" },
    });

    // PUT null clears: the stored default is gone (env stays unset here).
    const clear = routeArgs(handle.mind, {
      path: "/api/settings/model",
      method: "PUT",
      body: null,
    });
    expect(await settingsRoutes(clear.args)).toBe(true);
    expect(clear.body()).toEqual({ defaultModel: null });
    await handle.close();
  });

  it("PUT refuses a ref outside the live catalog", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const refused = routeArgs(handle.mind, {
      path: "/api/settings/model",
      method: "PUT",
      body: { ref: "nowhere/nothing" },
    });
    expect(await settingsRoutes(refused.args)).toBe(true);
    expect(refused.status()).toBe(409);
    expect((refused.body() as { error: string }).error).toContain("nowhere/nothing");
    // And nothing was stored.
    const reread = routeArgs(handle.mind, { path: "/api/settings/model" });
    expect(await settingsRoutes(reread.args)).toBe(true);
    expect(reread.body()).toEqual({ defaultModel: null });
    await handle.close();
  });

  it("answers only /api/settings/model", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    expect(await settingsRoutes(routeArgs(handle.mind, { path: "/api/settings" }).args)).toBe(
      false,
    );
    expect(
      await settingsRoutes(
        routeArgs(handle.mind, { path: "/api/settings/model", method: "DELETE" }).args,
      ),
    ).toBe(false);
    await handle.close();
  });
});
