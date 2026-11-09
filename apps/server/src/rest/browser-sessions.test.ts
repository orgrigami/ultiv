/**
 * The Browsers panel's routes against a hand-built mind: a real active-
 * browsers registry and takeover registry, and the route's own scoping —
 * my bot's session lists (with its open ask linked), another owner's is
 * invisible, and the watch stream answers 404 for a session that is not
 * open or not mine, exactly like a missing one.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { MindService } from "@spriessen/mind";
import { activeBrowsers, takeoverRegistry } from "@spriessen/ext";
import { browserSessionRoutes } from "./browser-sessions.ts";
import type { RouteArgs } from "./types.ts";
import { OWNER_ID } from "../identity.ts";

let server: Server;
let base = "";
let askId = "";

beforeAll(async () => {
  const sessions = activeBrowsers();
  const takeovers = takeoverRegistry();
  sessions.touch("conv-mine", "https://example.test/signin", "Sign in");
  sessions.touch("conv-theirs", "https://example.test/private", "Private");
  askId = (
    await takeovers.open({
      conversationId: "conv-mine",
      reason: "the sign-in needs you",
      act: async () => ({ ok: true, png: "", url: "", title: "", text: "", error: null }),
    })
  ).id;
  const mind = {
    browserSessions: sessions,
    browserTakeovers: takeovers,
    profiles: {
      scopeOf: (conversationId: string) =>
        conversationId.endsWith("-theirs")
          ? { owner: "owner-b", profileId: "bot-theirs" }
          : { owner: OWNER_ID, profileId: "bot-mine" },
      get: async (owner: string, id: string) => ({ owner, id, name: "Browsing Bot" }),
    },
  } as unknown as MindService;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const args: RouteArgs = {
      mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
      req,
      res,
      url,
      owner: OWNER_ID,
      path: url.pathname,
      json: (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
      readJson: async <T>() => ({}) as T,
      readBody: async () => Buffer.alloc(0),
    };
    void browserSessionRoutes(args).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the browser-session routes", () => {
  it("lists only my bots' sessions, each linked to its open ask", async () => {
    const response = await fetch(`${base}/api/browser/sessions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: { conversationId: string; botName: string; takeoverId: string | null }[];
    };
    expect(body.sessions).toEqual([
      expect.objectContaining({
        conversationId: "conv-mine",
        url: "https://example.test/signin",
        title: "Sign in",
        botName: "Browsing Bot",
        profileId: "bot-mine",
        takeoverId: askId,
      }),
    ]);
  });

  it("answers another owner's watch stream like a missing one", async () => {
    const theirs = await fetch(`${base}/api/browser/sessions/conv-theirs/cast`);
    const missing = await fetch(`${base}/api/browser/sessions/conv-nobody/cast`);
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
  });
});
