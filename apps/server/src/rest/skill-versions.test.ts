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

const scratch = mkdtempSync(join(tmpdir(), "spriessen-skill-versions-rest-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["SKILLS_DIR"] = join(scratch, "skills");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let bot = "";

const call = async (owner: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-spriessen-user": owner },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

const BODY = (step: string): string =>
  `---\nname: weekly-report\ndescription: The weekly report\n---\n\n${step}`;

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (await handle.mind.profiles.create("owner-a", { name: "Writer", onboard: false })).id;
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("skill versions REST", () => {
  it("lists, restores and undoes", async () => {
    const path = `/api/skills/${bot}/weekly-report`;
    expect((await call("owner-a", "PUT", path, { body: BODY("one") })).status).toBe(200);
    expect((await call("owner-a", "PUT", path, { body: BODY("two") })).json.version).toBe(2);
    const listed = (await call("owner-a", "GET", `${path}/versions`)).json as any[];
    expect(listed.map((v) => [v.n, v.by])).toEqual([
      [2, "owner"],
      [1, "owner"],
    ]);
    expect((await call("owner-a", "POST", `${path}/restore`, { version: 1 })).json.version).toBe(3);
    expect((await call("owner-a", "GET", path)).json.body).toContain("one");
    expect((await call("owner-a", "POST", `${path}/revert`)).json.version).toBe(4);
    expect((await call("owner-a", "GET", path)).json.body).toContain("two");
    expect((await call("owner-a", "POST", `${path}/restore`, { version: 99 })).status).toBe(404);
    expect((await call("owner-a", "POST", `${path}/restore`, { version: "1" })).status).toBe(400);
    expect((await call("owner-a", "GET", `/api/skills/${bot}/nothing/versions`)).status).toBe(404);
  });

  it("the wrong person can't list, restore or undo", async () => {
    const path = `/api/skills/${bot}/weekly-report`;
    expect((await call("owner-b", "GET", `${path}/versions`)).status).toBe(404);
    expect((await call("owner-b", "POST", `${path}/restore`, { version: 1 })).status).toBe(404);
    expect((await call("owner-b", "POST", `${path}/revert`)).status).toBe(404);
    const versions = (await call("owner-a", "GET", `${path}/versions`)).json as any[];
    expect(versions[0].n).toBe(4);
  });
});
