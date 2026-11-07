/**
 * Purge wiring for one VM per home (phase 4 slice 2): deleting a bot must
 * NOT destroy any VM (the VM belongs to its home and is shared), while
 * deleting a team destroys the team's VM — named by the home
 * scope dir, never the org's. The home-VM destroyer is injected, so no VM
 * runtime is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { HomeRef } from "@spriessen/contracts";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-home-purge-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

const destroyed: { owner: string; home: HomeRef }[] = [];

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let team = "";
let bot = "";

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
  handle = await openMind({
    storage: new MemoryStorage(),
    destroyHomeVm: async (owner, home) => {
      destroyed.push({ owner, home });
    },
  });
  await handle.mind.org.ensureOrg("owner", "Personal", true);
  await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
  team = (await handle.mind.org.createTeam({ name: "Shortlived" }, "owner")).id;
  bot = (
    await handle.mind.profiles.create("owner", {
      name: "Temp",
      teamId: team,
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

describe("purge destroys home VMs, not bots'", () => {
  it("deleting a bot destroys no VM", async () => {
    const answer = await call("DELETE", `/api/profiles/${bot}`);
    expect(answer.status).toBe(200);
    expect((answer.json as { sandbox: boolean }).sandbox).toBe(false);
    expect(destroyed).toEqual([]);
  });

  it("deleting a team destroys the team's VM (org VM untouched)", async () => {
    const mover = await handle.mind.profiles.create("owner", {
      name: "Mover",
      teamId: team,
      onboard: false,
    });
    await handle.mind.profiles.update("owner", mover.id, { teamId: null });
    const answer = await call("DELETE", `/api/org/teams/${team}`);
    expect(answer.status).toBe(200);
    expect(destroyed).toEqual([{ owner: "owner", home: { kind: "team", teamId: team } }]);
    // The org VM's scope was never asked for: it is destroyed only with the org.
    expect(destroyed.some((row) => row.home.kind === "org")).toBe(false);
  });
});
