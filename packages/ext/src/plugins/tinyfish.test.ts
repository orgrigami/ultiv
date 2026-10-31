import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { invoke } from "../connector.ts";
import { tinyfishConfigured, tinyfishConnector, webFetchTool, webSearchTool } from "./tinyfish.ts";

// Effect 4's env provider snapshots process.env at first use, so the key the
// connector reads is set at module load — never mid-test. Fetch is stubbed
// per-test, so nothing here touches the network.
process.env.TINYFISH_API_KEY ??= "unit-test-key";

type RecordedCall = { input: unknown; init: RequestInit | undefined };

const calls: RecordedCall[] = [];
const responses: Array<() => Response> = [];
let restore: () => void = () => {};

beforeEach(() => {
  calls.length = 0;
  responses.length = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("no stubbed response queued");
    return next();
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
});

afterEach(() => restore());

describe("tinyfish connector", () => {
  it("configures from the environment and exposes read-only web tools", () => {
    expect(tinyfishConfigured()).toBe(true);
    expect(webSearchTool.name).toBe("web_search");
    expect(webFetchTool.name).toBe("web_fetch");
    expect([webSearchTool, webFetchTool].every((tool) => tool.gated !== true)).toBe(true);
  });

  it("rejects schema-invalid input before any request", async () => {
    const badQuery = await Effect.runPromise(
      Effect.match(invoke(tinyfishConnector, "search", { query: 42 }), {
        onSuccess: () => true as const,
        onFailure: () => false as const,
      }),
    );
    expect(badQuery).toBe(false);
    const badUrls = await Effect.runPromise(
      Effect.match(invoke(tinyfishConnector, "fetch", { urls: [] }), {
        onSuccess: () => true as const,
        onFailure: () => false as const,
      }),
    );
    expect(badUrls).toBe(false);
  });

  it("maps search results, drops url-less rows, and sends the key", async () => {
    responses.push(() =>
      Response.json({
        query: "q",
        results: [
          {
            position: 1,
            site_name: "effect.website",
            snippet: "s",
            title: "T",
            url: "https://a.dev/x",
          },
          { position: 2, snippet: "no link", title: "skip me" },
        ],
      }),
    );
    const result = await Effect.runPromise(invoke(tinyfishConnector, "search", { query: "q" }));
    expect(result).toEqual({
      results: [{ title: "T", url: "https://a.dev/x", snippet: "s", site: "effect.website" }],
    });
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).not.toBe("");
  });

  it("fails externally on a non-2xx search", async () => {
    responses.push(() => new Response("denied", { status: 403 }));
    const outcome = await Effect.runPromise(
      Effect.match(invoke(tinyfishConnector, "search", { query: "q" }), {
        onSuccess: () => "unexpected success",
        onFailure: (error) =>
          error._tag === "spreissen/External" ? String(error.cause) : error._tag,
      }),
    );
    expect(outcome).toContain("403");
  });

  it("maps fetch pages, truncates long text, and carries per-URL errors", async () => {
    responses.push(() =>
      Response.json({
        results: [
          {
            url: "https://a.dev/",
            final_url: "https://a.dev/final",
            title: "A",
            text: "x".repeat(25_000),
          },
        ],
        errors: [{ url: "https://b.dev/", error: "boom" }],
      }),
    );
    const result = (await Effect.runPromise(
      invoke(tinyfishConnector, "fetch", { urls: ["https://a.dev/", "https://b.dev/"] }),
    )) as { pages: Array<{ url: string; content: string; truncated?: boolean; error?: string }> };
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.url).toBe("https://a.dev/final");
    expect(result.pages[0]?.truncated).toBe(true);
    expect(result.pages[0]?.content).toHaveLength(20_000);
    expect(result.pages[1]?.error).toBe("boom");
  });
});

describe("tinyfish tools", () => {
  it("return structured results through invoke", async () => {
    responses.push(() =>
      Response.json({ results: [{ title: "T", url: "https://a.dev/", snippet: "s" }] }),
    );
    const result = await webSearchTool.execute({ query: "q" }, {} as never, {} as never);
    expect(result.isError).toBeUndefined();
    expect(result.structuredOutput).toEqual({
      results: [{ title: "T", url: "https://a.dev/", snippet: "s" }],
    });
  });

  it("surface failures as error results, not throws", async () => {
    responses.push(() => new Response("denied", { status: 401 }));
    const result = await webSearchTool.execute({ query: "q" }, {} as never, {} as never);
    expect(result.isError).toBe(true);
    const block = result.output?.[0] as { type: string; text: string } | undefined;
    expect(block?.text).toContain("401");
  });
});
