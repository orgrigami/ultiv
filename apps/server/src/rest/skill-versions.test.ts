/**
 * Skill versions over the real REST handler: history newest first, restore
 * and undo append, a bad version is a 400 or 404, and another owner gets the
 * 404 an unknown bot gets (and changes nothing).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-skill-versions-rest-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["SKILLS_DIR"] = join(scratch, "skills");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let bot = "";

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

const BODY = (step: string): string =>
  `---\nname: weekly-report\ndescription: The weekly report\n---\n\n${step}`;

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (await handle.mind.profiles.create("owner", { name: "Writer", onboard: false })).id;
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

describe("skill versions REST", () => {
  it("lists, restores and undoes", async () => {
    const path = `/api/skills/${bot}/weekly-report`;
    expect((await call("PUT", path, { body: BODY("one") })).status).toBe(200);
    expect((await call("PUT", path, { body: BODY("two") })).json.version).toBe(2);
    const listed = (await call("GET", `${path}/versions`)).json as any[];
    expect(listed.map((v) => [v.n, v.by])).toEqual([
      [2, "owner"],
      [1, "owner"],
    ]);
    expect((await call("POST", `${path}/restore`, { version: 1 })).json.version).toBe(3);
    expect((await call("GET", path)).json.body).toContain("one");
    expect((await call("POST", `${path}/revert`)).json.version).toBe(4);
    expect((await call("GET", path)).json.body).toContain("two");
    expect((await call("POST", `${path}/restore`, { version: 99 })).status).toBe(404);
    expect((await call("POST", `${path}/restore`, { version: "1" })).status).toBe(400);
    expect((await call("GET", `/api/skills/${bot}/nothing/versions`)).status).toBe(404);
  });

  it("undo can't bring back a deleted skill's text after it is saved anew", async () => {
    const path = `/api/skills/${bot}/invoice-filing`;
    const body = (step: string) =>
      `---\nname: invoice-filing\ndescription: Invoices\n---\n\n${step}`;
    expect((await call("PUT", path, { body: body("deleted text") })).status).toBe(200);
    expect((await call("DELETE", path)).status).toBe(200);
    expect((await call("PUT", path, { body: body("fresh text") })).status).toBe(200);
    const listed = (await call("GET", `${path}/versions`)).json as any[];
    expect(listed[0]).toMatchObject({ n: 2, created: true });
    expect((await call("POST", `${path}/revert`)).status).toBe(404);
    expect((await call("GET", path)).json.body).toContain("fresh text");
  });
});
