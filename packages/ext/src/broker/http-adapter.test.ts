import { afterEach, describe, expect, it } from "vite-plus/test";
import type { CredentialBinding } from "@spreissen/contracts";
import { performHttp } from "./http-adapter.ts";
import { startServer, type TestServer } from "./test-servers.ts";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const binding = (hosts: string[], over: Partial<CredentialBinding> = {}): CredentialBinding => ({
  adapter: "http",
  hosts,
  methods: ["GET", "POST"],
  auth: { placement: "bearer" },
  profiles: null,
  allowLocalhostHttp: true,
  itemId: "item",
  approvedHosts: [],
  updatedAt: 0,
  ...over,
});
const material = { secret: "tok_123456789", username: null };

describe("HTTP adapter", () => {
  it("places auth on the bound host and drops it for good on a cross-host redirect", async () => {
    const other = await startServer((_s, res) => res.end("landed"));
    const first = await startServer((_s, res) => {
      res.writeHead(302, { location: `http://localhost:${other.port}/next` }).end();
    });
    servers.push(other, first);
    const result = await performHttp(
      { method: "GET", url: `http://127.0.0.1:${first.port}/start` },
      { material, binding: binding([`http://127.0.0.1:${first.port}/`]) },
      { allowLocalhostHttp: true },
    );
    expect(first.seen[0]?.headers.authorization).toBe("Bearer tok_123456789");
    expect(other.seen[0]?.headers.authorization).toBeUndefined();
    expect(result).toMatchObject({ status: 200, body: "landed", redirects: 1, authDropped: true });
  });

  it("drops auth when a same-host redirect leaves the bound path prefix", async () => {
    const server = await startServer((seen, res) => {
      if (seen.url === "/v1/a") res.writeHead(307, { location: "/admin" }).end();
      else res.end("ok");
    });
    servers.push(server);
    const result = await performHttp(
      { method: "POST", url: `http://127.0.0.1:${server.port}/v1/a`, body: "{}" },
      { material, binding: binding([`http://127.0.0.1:${server.port}/v1`]) },
      { allowLocalhostHttp: true },
    );
    expect(server.seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([
      ["POST", "/v1/a", "Bearer tok_123456789"],
      ["POST", "/admin", undefined],
    ]);
    expect(result.authDropped).toBe(true);
  });

  it("caps redirects, turns 303 into GET, and refuses redirects into private ranges", async () => {
    const loop = await startServer((_s, res) => res.writeHead(302, { location: "/again" }).end());
    const see = await startServer((seen, res) => {
      if (seen.url === "/form") res.writeHead(303, { location: "/done" }).end();
      else if (seen.url === "/meta")
        res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      else res.end(seen.method);
    });
    servers.push(loop, see);
    const options = { allowLocalhostHttp: true };
    await expect(
      performHttp({ method: "GET", url: `http://127.0.0.1:${loop.port}/` }, null, options),
    ).rejects.toThrow(/too many redirects/);
    const done = await performHttp(
      { method: "POST", url: `http://127.0.0.1:${see.port}/form`, body: "x=1" },
      null,
      options,
    );
    expect(done.body).toBe("GET");
    await expect(
      performHttp({ method: "GET", url: `http://127.0.0.1:${see.port}/meta` }, null, options),
    ).rejects.toThrow(/only https|refused/);
  });

  it("caps the response size and the request body", async () => {
    const big = await startServer((_s, res) => res.end("x".repeat(700 * 1024)));
    servers.push(big);
    const result = await performHttp(
      { method: "GET", url: `http://127.0.0.1:${big.port}/` },
      null,
      { allowLocalhostHttp: true },
    );
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(512 * 1024);
    await expect(
      performHttp(
        { method: "POST", url: "https://api.example.com/", body: "y".repeat(300 * 1024) },
        null,
        { allowLocalhostHttp: false },
      ),
    ).rejects.toThrow(/request body over/);
  });

  it("places basic, header, query and body credentials", async () => {
    const server = await startServer((_s, res) => res.end("ok"));
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/`;
    const run = (auth: CredentialBinding["auth"], body?: string) =>
      performHttp(
        { method: "POST", url: `${base}x?a=1`, ...(body !== undefined ? { body } : {}) },
        {
          material: { secret: "pw_abcdef", username: "harry" },
          binding: binding([base], { auth }),
        },
        { allowLocalhostHttp: true },
      );
    await run({ placement: "basic" });
    await run({ placement: "header", name: "X-Api-Key", prefix: "Token " });
    await run({ placement: "query", name: "key" });
    await run({ placement: "body", name: "token" }, '{"a":1}');
    const [basic, header, query, body] = server.seen;
    expect(basic?.headers.authorization).toBe(
      `Basic ${Buffer.from("harry:pw_abcdef").toString("base64")}`,
    );
    expect(header?.headers["x-api-key"]).toBe("Token pw_abcdef");
    expect(query?.url).toBe("/x?a=1&key=pw_abcdef");
    expect(JSON.parse(body?.body ?? "{}")).toEqual({ a: 1, token: "pw_abcdef" });
  });
});
