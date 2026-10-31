/**
 * The server refuses state changes that another origin could send without
 * a CORS preflight (no content type, form types, text/plain). Every write
 * the client makes must therefore name a type, bodyless ones included.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "./api.ts";

const typeOf = (init: RequestInit | undefined): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.["content-type"];

const stubFetch = (reply: unknown) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("write requests name their content type", () => {
  it("a bodyless POST still sends application/json", async () => {
    const calls = stubFetch({ ok: true });
    await api.setMain("bot-x");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(typeOf(calls[0]?.init)).toBe("application/json");
  });

  it("an upload sends raw bytes as application/octet-stream, the real type in the query", async () => {
    const calls = stubFetch({ id: "a" });
    await api.artifactUpload(new Blob(["hi"], { type: "text/plain" }), "note.txt");
    expect(typeOf(calls[0]?.init)).toBe("application/octet-stream");
    expect(calls[0]?.url).toContain("mime=text%2Fplain");
  });
});
