/**
 * A bot's home over the real REST handler: created inside a team,
 * moved between homes, a home that does not exist refused, and each move
 * audited.
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

const scratch = mkdtempSync(join(tmpdir(), "spriessen-bot-home-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let team = "";

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      cookie,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { status: response.status, json };
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  // The org exists the way a boot migration leaves it.
  await handle.mind.org.ensureOrg("owner", "Personal", true);
  // The first bot lives in the org and becomes the main bot (the home rules).
  await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
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

describe("a bot's home over REST", () => {
  it("creates a bot inside a team and audits it", async () => {
    const made = await call("POST", "/api/org/teams", { name: "Team X" });
    team = (made.json as { id: string }).id;
    const bot = await call("POST", "/api/profiles", {
      name: "Wren",
      onboard: false,
      teamId: team,
    });
    expect(bot.status).toBe(200);
    expect((bot.json as { teamId: string }).teamId).toBe(team);
    const events = (await call("GET", "/api/audit?kind=permission")).json as { name: string }[];
    expect(events.some((event) => event.name === "bot-moved")).toBe(true);
  });

  it("refuses a home that does not exist, on create and on a move", async () => {
    const bad = await call("POST", "/api/profiles", {
      name: "Stray",
      onboard: false,
      teamId: "team-nowhere",
    });
    expect(bad.status).toBe(400);
    const names = ((await call("GET", "/api/profiles")).json as { name: string }[]).map(
      (row) => row.name,
    );
    expect(names).not.toContain("Stray");
    const bot = (await call("POST", "/api/profiles", { name: "Finch", onboard: false })).json as {
      id: string;
    };
    const move = await call("PATCH", `/api/profiles/${bot.id}`, { teamId: "team-nowhere" });
    expect(move.status).toBe(400);
    const row = (await call("GET", `/api/profiles/${bot.id}`)).json as { teamId: unknown };
    expect(row.teamId).toBeNull();
  });

  it("moves a bot between homes and back to the org", async () => {
    const bot = (await call("POST", "/api/profiles", { name: "Lark", onboard: false })).json as {
      id: string;
    };
    const into = await call("PATCH", `/api/profiles/${bot.id}`, { teamId: team });
    expect((into.json as { teamId: string }).teamId).toBe(team);
    const out = await call("PATCH", `/api/profiles/${bot.id}`, { teamId: null });
    expect((out.json as { teamId: unknown }).teamId).toBeNull();
    // The main bot (Keeper) stays in the org; a team bot cannot be main.
    const main = ((await call("GET", "/api/profiles")).json as { id: string; name: string }[]).find(
      (row) => row.name === "Keeper",
    );
    const keep = await call("PATCH", `/api/profiles/${main?.id}`, { teamId: team });
    expect(keep.status).toBe(400);
    expect((keep.json as { error: string }).error).toMatch(/main bot lives in the org/);
    await call("PATCH", `/api/profiles/${bot.id}`, { teamId: team });
    const promote = await call("POST", `/api/profiles/${bot.id}/main`, {});
    expect(promote.status).toBe(409);
    expect((await call("POST", `/api/profiles/${main?.id}/archive`, {})).status).toBe(409);
    // A team that still has bots cannot be removed.
    const remove = await call("DELETE", `/api/org/teams/${team}`);
    expect(remove.status).toBe(400);
  });
});
