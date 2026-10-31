/**
 * Auth on every route: enumerate the /api paths the REST sources name, call
 * each WITHOUT a session, and fail if any non-public route answers with
 * anything but the one refusal. The gate runs before routing, so this
 * enumeration is the safety net: a new route that starts answering data
 * anonymously, or a path wrongly added to the public list, fails here.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-route-gate-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

const here = dirname(fileURLToPath(import.meta.url));
const REFUSAL = { error: "sign in required" };

/** The methods worth probing on any path. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** The public contract (prefix match): everything else refuses anonymously. */
const PUBLIC: readonly { readonly method: string; readonly path: string }[] = [
  { method: "GET", path: "/api/health" },
  { method: "POST", path: "/hooks/" },
  { method: "GET", path: "/api/auth/" },
  { method: "POST", path: "/api/auth/" },
];

const isPublic = (method: string, path: string): boolean =>
  PUBLIC.some((entry) => entry.method === method && path.startsWith(entry.path));

/** Collect every /api/... or /hooks/... literal in the REST sources. */
const routeLiterals = (): string[] => {
  const files = [
    join(here, "../rest.ts"),
    ...readdirSync(here)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => join(here, file)),
  ];
  const paths = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/"(\/api\/[a-z0-9\-/]*|\/hooks\/[a-z0-9\-/]*)"/g)) {
      const literal = match[1] ?? "";
      if (literal === "/api/artifacts/nope/meta" || literal === "/api/artifacts/missing-id/meta") {
        continue;
      }
      paths.add(literal);
    }
  }
  // Dynamic shapes the literals only prefix: one id per parametrised route.
  for (const prefix of [
    "/api/cron",
    "/api/sensors",
    "/api/webhooks",
    "/api/tasks",
    "/api/skills",
    "/api/artifacts",
    "/api/sessions",
    "/api/profiles",
    "/api/state",
    "/api/vault",
    "/api/mcp/servers",
    "/api/push",
    "/api/rooms",
  ]) {
    paths.add(`${prefix}/probe-id`);
  }
  return [...paths];
};

let server: Server;
let base = "";
let cookie = "";
let hookId = "";

beforeAll(async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const bot = await handle.mind.profiles.create("owner", { name: "Gated", onboard: false });
  const session = await handle.mind.profiles.ensureMain("owner", bot.id);
  hookId = (await handle.mind.webhooks.create({ sessionId: session.id, name: "gate" })).id;
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
  rmSync(scratch, { recursive: true, force: true });
});

const anonymous = async (
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${base}${path}`, { method });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

describe("the gate answers every route", () => {
  it("refuses an anonymous call on every enumerated non-public route", async () => {
    const paths = routeLiterals();
    expect(paths.length).toBeGreaterThan(30);
    const leaky: string[] = [];
    for (const path of paths) {
      for (const method of METHODS) {
        if (isPublic(method, path)) continue;
        // A non-GET on a public path answers the router's 404, never data.
        if (path === "/api/health") continue;
        const answer = await anonymous(method, path);
        if (answer.status !== 401 || JSON.stringify(answer.body) !== JSON.stringify(REFUSAL)) {
          leaky.push(`${method} ${path} -> ${answer.status}`);
        }
      }
    }
    expect(leaky).toEqual([]);
  });

  it("keeps the public contract: health and the token-authed webhook ingress", async () => {
    expect((await anonymous("GET", "/api/health")).status).toBe(200);
    const knock = await anonymous("POST", `/hooks/${hookId}`);
    // The ingress's own 401 (no token), not the gate's refusal.
    expect(knock.status).toBe(401);
    expect(JSON.stringify(knock.body)).not.toContain("sign in required");
  });

  it("lets a signed-in session through where the gate refused", async () => {
    const refused = await anonymous("GET", "/api/sessions");
    expect(refused.status).toBe(401);
    const response = await fetch(`${base}/api/sessions`, { headers: { cookie } });
    expect(response.status).toBe(200);
  });
});
