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
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bot-files-rest-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
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

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (
    await handle.mind.profiles.create("owner", {
      name: "Filer",
      persona: "Plain.",
      onboard: false,
    })
  ).id;
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

describe("bot files REST", () => {
  it("reads both files, with Persona migrated from the field", async () => {
    const got = await call("GET", `/api/profiles/${bot}/files`);
    expect(got.status).toBe(200);
    expect(got.json.persona.text).toBe("Plain.");
    expect(got.json.instructions).toEqual({ text: "", version: 1 });
  });

  it("saves, lists versions newest first, and restore keeps history", async () => {
    const path = `/api/profiles/${bot}/files/instructions`;
    expect((await call("PUT", path, { text: "Ask first.", reason: "Rules" })).json.version).toBe(2);
    expect((await call("PUT", path, { text: "Go ahead." })).json.version).toBe(3);
    const restored = await call("POST", `${path}/restore`, { version: 2 });
    expect(restored.json).toEqual({ text: "Ask first.", version: 4 });
    const versions = (await call("GET", `${path}/versions`)).json as any[];
    expect(versions.map((v) => v.n)).toEqual([4, 3, 2, 1]);
    expect(versions[0].restoredFrom).toBe(2);
    expect((await call("POST", `${path}/restore`, { version: 99 })).status).toBe(404);
  });

  it("a Persona save also writes the old field", async () => {
    await call("PUT", `/api/profiles/${bot}/files/persona`, { text: "Cheerful." });
    expect((await handle.mind.profiles.get("owner", bot))?.persona).toBe("Cheerful.");
  });

  it("refuses an unknown file and an oversized text", async () => {
    expect((await call("GET", `/api/profiles/${bot}/files/memory/versions`)).status).toBe(404);
    const big = await call("PUT", `/api/profiles/${bot}/files/persona`, {
      text: "x".repeat(8_001),
    });
    expect(big.status).toBe(400);
  });

  it("an unknown bot reads like a missing one for files too", async () => {
    expect((await call("GET", "/api/profiles/no-such-bot/files")).status).toBe(404);
  });
});
