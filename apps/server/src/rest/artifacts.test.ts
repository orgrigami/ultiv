/**
 * Artifact byte serving: the /meta endpoint, ?dl=1 content disposition and the
 * inline-safety headers (fake RouteArgs over a seeded temp store — no HTTP).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeArtifact } from "@ultiv/ext";
import { artifactRoutes } from "./artifacts.ts";
import type { RouteArgs } from "./types.ts";

let dir = "";

afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string | undefined;
}

const fakeArgs = (
  target: string,
  owner = "owner",
  options: { method?: string; body?: Buffer } = {},
): { args: RouteArgs; json: () => { status: number; body: unknown }; raw: () => RawResponse } => {
  let captured: unknown;
  let capturedStatus = 0;
  const raw: RawResponse = { status: 0, headers: {}, body: undefined };
  // The dispatcher feeds routes url.pathname (query excluded) as `path`.
  const path = new URL(`http://x${target}`).pathname;
  const args = {
    mind: { profiles: { list: async () => [{ id: "p1" }] } },
    req: { method: options.method ?? "GET" } as IncomingMessage,
    res: {
      writeHead: (status: number, headers: Record<string, string>) => {
        raw.status = status;
        raw.headers = headers;
      },
      end: (body: unknown) => {
        raw.body = body as Buffer | string;
      },
    } as unknown as ServerResponse,
    url: new URL(`http://x${target}`),
    owner,
    path,
    json: (status: number, body: unknown) => {
      capturedStatus = status;
      captured = body;
    },
    readJson: async <T>() => undefined as T,
    readBody: async () => options.body ?? Buffer.alloc(0),
  } as unknown as RouteArgs;
  return {
    args,
    json: () => ({ status: capturedStatus, body: captured }),
    raw: () => raw,
  };
};

const get = async (target: string, owner = "owner") => {
  const { args, json, raw } = fakeArgs(target, owner);
  const pathname = new URL(`http://x${target}`).pathname;
  const handled = await artifactRoutes(args, (after) => pathname.slice(after.length));
  return { handled, json: json(), raw: raw() };
};

describe("GET /api/artifacts/:id", () => {
  it("serves raw bytes with nosniff and no disposition", async () => {
    dir = mkdtempSync(join(tmpdir(), "ultiv-rest-artifacts-"));
    const info = writeArtifact(dir, { name: "notes.md", content: "# hi", owner: null });
    process.env["ARTIFACTS_DIR"] = dir;
    const { handled, raw } = await get(`/api/artifacts/${info.id}`);
    expect(handled).toBe(true);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("text/markdown");
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
    expect(raw.headers["content-disposition"]).toBeUndefined();
    expect(String(raw.body)).toBe("# hi");
  });

  it("sets attachment disposition on ?dl=1, with a filename* for unicode names", async () => {
    dir = mkdtempSync(join(tmpdir(), "ultiv-rest-artifacts-"));
    const info = writeArtifact(dir, { name: "résumé final.md", content: "bonjour", owner: null });
    process.env["ARTIFACTS_DIR"] = dir;
    const { raw } = await get(`/api/artifacts/${info.id}?dl=1`);
    expect(raw.headers["content-disposition"]).toBe(
      `attachment; filename="r sum  final.md"; filename*=UTF-8''${encodeURIComponent("résumé final.md")}`,
    );
  });

  it("sandboxes inline html but downloads it on ?dl=1 instead", async () => {
    dir = mkdtempSync(join(tmpdir(), "ultiv-rest-artifacts-"));
    const info = writeArtifact(dir, {
      name: "page.html",
      mime: "text/html",
      content: "<script>1</script>",
      owner: null,
    });
    process.env["ARTIFACTS_DIR"] = dir;
    const inline = await get(`/api/artifacts/${info.id}`);
    expect(inline.raw.headers["content-security-policy"]).toBe("sandbox");
    expect(inline.raw.headers["content-disposition"]).toBeUndefined();
    const dl = await get(`/api/artifacts/${info.id}?dl=1`);
    expect(dl.raw.headers["content-disposition"]).toContain("attachment");
    expect(dl.raw.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("GET /api/artifacts/:id/meta", () => {
  it("returns the sidecar info", async () => {
    dir = mkdtempSync(join(tmpdir(), "ultiv-rest-artifacts-"));
    const info = writeArtifact(dir, { name: "report.md", content: "# r", owner: null });
    process.env["ARTIFACTS_DIR"] = dir;
    const { handled, json } = await get(`/api/artifacts/${info.id}/meta`);
    expect(handled).toBe(true);
    expect(json.status).toBe(200);
    expect(json.body).toMatchObject({ id: info.id, name: "report.md", mime: "text/markdown" });
  });

  it("404s unknown ids and 403s other owners' artifacts", async () => {
    dir = mkdtempSync(join(tmpdir(), "ultiv-rest-artifacts-"));
    const info = writeArtifact(dir, { name: "secret.md", content: "s", owner: "someone" });
    process.env["ARTIFACTS_DIR"] = dir;
    const missing = await get("/api/artifacts/nope/meta");
    expect(missing.json).toMatchObject({ status: 404, body: { error: "unknown artifact" } });
    const foreign = await get(`/api/artifacts/${info.id}/meta`, "someone-else");
    expect(foreign.json).toMatchObject({ status: 403, body: { error: "not your artifact" } });
  });
});

describe("POST /api/artifacts", () => {
  const post = async (target: string, body: Buffer, owner = "owner") => {
    const faked = fakeArgs(target, owner, { method: "POST", body });
    const handled = await artifactRoutes(faked.args, (after) =>
      new URL(`http://x${target}`).pathname.slice(after.length),
    );
    return { handled, json: faked.json() };
  };

  it("stores raw bytes binary-safe and serves them back byte-identical", async () => {
    dir = mkdtempSync(join(tmpdir(), "ultiv-rest-artifacts-"));
    process.env["ARTIFACTS_DIR"] = dir;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    const uploaded = await post("/api/artifacts?name=shot.png&mime=image%2Fpng", bytes);
    expect(uploaded.handled).toBe(true);
    expect(uploaded.json.status).toBe(200);
    const info = uploaded.json.body as { id: string; mime: string; bytes: number };
    expect(info.mime).toBe("image/png");
    expect(info.bytes).toBe(bytes.byteLength);
    const served = await get(`/api/artifacts/${info.id}`);
    expect((served.raw.body as Buffer).equals(bytes)).toBe(true);
    expect(served.raw.headers["content-type"]).toBe("image/png");
  });

  it("answers 413 over the upload cap", async () => {
    dir = mkdtempSync(join(tmpdir(), "ultiv-rest-artifacts-"));
    process.env["ARTIFACTS_DIR"] = dir;
    const over = await post("/api/artifacts?name=big.bin", Buffer.alloc(10_000_001));
    expect(over.json.status).toBe(413);
    expect(over.json.body).toMatchObject({ error: "file too large (10 MB max)" });
  });
});
