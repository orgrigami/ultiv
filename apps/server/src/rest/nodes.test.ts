/**
 * The node REST surface: owner-scoped pairing, the token shown exactly once
 * (in the minting response, never in any later read), revoke, and roots
 * updates. Another owner's node reads as a missing one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, pairNode, resolveNodeId } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-nodes-rest-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";

const call = async (method: string, path: string, body?: unknown, withCookie = cookie) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(withCookie === "" ? {} : { cookie: withCookie }),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
      auth: new AuthStore(),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  cookie = await signInForTest(base);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("node routes", () => {
  it("pairs owner-scoped; the token appears only in the minting response", async () => {
    const pair = await call("POST", "/api/nodes", {
      name: "node-x",
      roots: ["/home/me/repos"],
    });
    expect(pair.status).toBe(200);
    const token: string = pair.json.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(pair.json.node).toMatchObject({ name: "node-x", status: "paired", owner: "owner" });

    // Every later read shows the node, never the token or a hash.
    const list = await call("GET", "/api/nodes");
    expect(list.status).toBe(200);
    const body = JSON.stringify(list.json);
    expect(body).toContain("node-x");
    expect(body).not.toContain(token);
    expect(body).not.toContain("tokenHash");
    // And the audit log never sees it either.
    const audit = await call("GET", "/api/audit");
    expect(JSON.stringify(audit.json)).not.toContain(token);

    // Bad input is a 400 that names the owner action.
    expect((await call("POST", "/api/nodes", { name: "y", roots: ["rel"] })).status).toBe(400);
    expect((await call("POST", "/api/nodes", { name: "node-x", roots: ["/r"] })).status).toBe(400); // duplicate name
  });

  it("a foreign account reads another owner's node as missing", async () => {
    // A foreign owner label pairs through the mind directly (like
    // wrong-owner.test.ts creates its records) — there is one sign-in here.
    const theirs = await pairNode(handle.mind.converse, "owner-b", {
      name: "theirs",
      roots: ["/t"],
    });
    const theirId = theirs.node.id;

    // The signed-in owner's list shows only their own node.
    const list = await call("GET", "/api/nodes");
    const names = (list.json as { name: string }[]).map((row) => row.name);
    expect(names).toEqual(["node-x"]);
    // Mutations on the foreign node read as missing.
    expect((await call("POST", `/api/nodes/${theirId}/revoke`)).json.ok).toBe(false);
    expect((await call("PUT", `/api/nodes/${theirId}/roots`, { roots: ["/x"] })).status).toBe(404);
    // And the foreign node is invisible to the gate resolution for our owner.
    expect(await resolveNodeId(handle.mind.converse, "owner", "theirs")).toBeUndefined();
  });

  it("revokes and updates roots; revoked keeps answering reads without the token", async () => {
    const pair = await call("POST", "/api/nodes", { name: "node-y", roots: ["/y"] });
    const id: string = pair.json.node.id;
    const roots = await call("PUT", `/api/nodes/${id}/roots`, { roots: ["/y/repos", "/z"] });
    expect(roots.status).toBe(200);
    expect(roots.json.roots).toEqual(["/y/repos", "/z"]);
    expect(JSON.stringify(roots.json)).not.toContain(pair.json.token);

    const revoked = await call("POST", `/api/nodes/${id}/revoke`);
    expect(revoked.json.ok).toBe(true);
    const listed = await call("GET", "/api/nodes");
    const row = (listed.json as { id: string; status: string }[]).find((n) => n.id === id);
    expect(row?.status).toBe("revoked");
    // Revoking again stays a no-op success; no token ever reappears.
    expect((await call("POST", `/api/nodes/${id}/revoke`)).json.ok).toBe(true);
    expect(JSON.stringify(listed.json)).not.toContain(pair.json.token);
  });
});
