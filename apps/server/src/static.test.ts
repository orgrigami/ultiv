/**
 * The server's own web serving: files from the build, the SPA's index.html
 * for client routes, hashed assets cached for a year, nothing outside the
 * build folder, and the server's own prefixes left to the API.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { staticHandler } from "./static.ts";

const dist = mkdtempSync(join(tmpdir(), "spriessen-dist-"));
let server: Server;
let base = "";

beforeAll(async () => {
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(dist, "sw.js"), "self");
  writeFileSync(join(dist, "..", "outside-secret.txt"), "nope");
  const web = staticHandler(dist);
  server = createServer((req, res) => {
    if (!web(req, res)) {
      res.writeHead(418);
      res.end("api");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(dist, "..", "outside-secret.txt"), { force: true });
});

describe("staticHandler", () => {
  it("serves a hashed asset with a long cache and its type", async () => {
    const res = await fetch(`${base}/assets/index-abc.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("answers client routes with index.html, never cached", async () => {
    const res = await fetch(`${base}/c/some-session`);
    expect(await res.text()).toContain("<title>app</title>");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect((await fetch(`${base}/sw.js`)).headers.get("cache-control")).toBe("no-cache");
  });

  it("never reads outside the build folder", async () => {
    const res = await fetch(`${base}/%2e%2e/outside-secret.txt`);
    expect(await res.text()).not.toContain("nope");
  });

  it("leaves the API, hooks, chord, agent and push paths alone, and every POST", async () => {
    for (const path of ["/api/health", "/hooks/x", "/chord", "/agent", "/push"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(418);
    }
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(418);
  });

  it("refuses to start without a build", () => {
    expect(() => staticHandler(join(dist, "missing"))).toThrow(/vp -C apps\/web build/);
  });
});
