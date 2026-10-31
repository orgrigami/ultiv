/**
 * Persona and Instructions over the real REST handler and an offline mind:
 * read, save, history, restore (history kept), the Persona field mirror,
 * and owner scoping (another owner gets the same 404 an unknown bot gets).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bot-files-rest-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
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

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (
    await handle.mind.profiles.create("owner-a", {
      name: "Filer",
      persona: "Plain.",
      onboard: false,
    })
  ).id;
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

describe("bot files REST", () => {
  it("reads both files, with Persona migrated from the field", async () => {
    const got = await call("owner-a", "GET", `/api/profiles/${bot}/files`);
    expect(got.status).toBe(200);
    expect(got.json.persona.text).toBe("Plain.");
    expect(got.json.instructions).toEqual({ text: "", version: 1 });
  });

  it("saves, lists versions newest first, and restore keeps history", async () => {
    const path = `/api/profiles/${bot}/files/instructions`;
    expect(
      (await call("owner-a", "PUT", path, { text: "Ask first.", reason: "Rules" })).json.version,
    ).toBe(2);
    expect((await call("owner-a", "PUT", path, { text: "Go ahead." })).json.version).toBe(3);
    const restored = await call("owner-a", "POST", `${path}/restore`, { version: 2 });
    expect(restored.json).toEqual({ text: "Ask first.", version: 4 });
    const versions = (await call("owner-a", "GET", `${path}/versions`)).json as any[];
    expect(versions.map((v) => v.n)).toEqual([4, 3, 2, 1]);
    expect(versions[0].restoredFrom).toBe(2);
    expect((await call("owner-a", "POST", `${path}/restore`, { version: 99 })).status).toBe(404);
  });

  it("a Persona save also writes the old field", async () => {
    await call("owner-a", "PUT", `/api/profiles/${bot}/files/persona`, { text: "Cheerful." });
    expect((await handle.mind.profiles.get("owner-a", bot))?.persona).toBe("Cheerful.");
  });

  it("refuses an unknown file and an oversized text", async () => {
    expect(
      (await call("owner-a", "GET", `/api/profiles/${bot}/files/memory/versions`)).status,
    ).toBe(404);
    const big = await call("owner-a", "PUT", `/api/profiles/${bot}/files/persona`, {
      text: "x".repeat(8_001),
    });
    expect(big.status).toBe(400);
  });

  it("the wrong person can't read, save or restore", async () => {
    const files = `/api/profiles/${bot}/files`;
    expect((await call("owner-b", "GET", files)).status).toBe(404);
    expect(
      (await call("owner-b", "PUT", `${files}/instructions`, { text: "Mine now." })).status,
    ).toBe(404);
    expect(
      (await call("owner-b", "POST", `${files}/instructions/restore`, { version: 1 })).status,
    ).toBe(404);
    expect((await call("owner-b", "GET", `${files}/instructions/versions`)).status).toBe(404);
    expect((await call("owner-a", "GET", files)).json.instructions.text).toBe("Ask first.");
  });
});
