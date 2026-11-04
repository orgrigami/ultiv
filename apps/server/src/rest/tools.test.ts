import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import type { ToolCatalogEntry } from "@spriessen/contracts";
import type { RouteArgs } from "./types.ts";
import { toolRoutes } from "./tools.ts";

/** Minimal RouteArgs over a real offline mind; captures the JSON response. */
const routeArgs = (
  mind: Awaited<ReturnType<typeof openMind>>["mind"],
  opts: { path: string; method?: string },
): { args: RouteArgs; status: () => number; body: () => unknown } => {
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
      readJson: async <T>() => ({}) as T,
      readBody: async () => Buffer.from("{}"),
    },
    status: () => captured?.status ?? 0,
    body: () => captured?.body,
  };
};

describe("GET /api/tools", () => {
  it("serves the tool catalog: names with one-line descriptions, one row per name", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { args, status, body } = routeArgs(handle.mind, { path: "/api/tools" });
    expect(await toolRoutes(args)).toBe(true);
    expect(status()).toBe(200);
    const catalog = body() as ToolCatalogEntry[];
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    // Names are unique; every row carries a non-empty description.
    const names = catalog.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of catalog) {
      expect(tool.description).not.toContain("\n");
    }
    // The union reaches the late installs (org mutations) and the act's own tools.
    const byName = new Map(catalog.map((tool) => [tool.name, tool.description]));
    expect(byName.get("bot_create")).toBeTruthy();
    expect(byName.get("departments_list")).toBeTruthy();
    await handle.close();
  });

  it("answers only GET /api/tools", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    expect(
      await toolRoutes(routeArgs(handle.mind, { path: "/api/tools", method: "POST" }).args),
    ).toBe(false);
    expect(await toolRoutes(routeArgs(handle.mind, { path: "/api/tool" }).args)).toBe(false);
    await handle.close();
  });
});
