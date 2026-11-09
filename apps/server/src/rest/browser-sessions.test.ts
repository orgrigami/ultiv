/**
 * The Browsers panel's routes against a hand-built mind: a real active-
 * browsers registry and takeover registry, and the route's own scoping —
 * my bot's session lists (with its open ask linked), another owner's is
 * invisible, the watch stream answers 404 for a session that is not open
 * or not mine (or held by an open takeover), exactly like a missing one,
 * and the Close, saved sign-ins and history routes only ever reach my bots.
 */
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { MindService } from "@spriessen/mind";
import { activeBrowsers, takeoverRegistry } from "@spriessen/ext";
import { browserSessionRoutes } from "./browser-sessions.ts";
import type { RouteArgs } from "./types.ts";
import { OWNER_ID } from "../identity.ts";

let server: Server;
let base = "";
let askId = "";
const forgot: string[] = [];
const closed: string[] = [];
const signIns: string[] = [];

beforeAll(async () => {
  const sessions = activeBrowsers();
  const takeovers = takeoverRegistry();
  sessions.touch("bot-a", "conv-mine", { url: "https://example.test/signin", title: "Sign in" });
  sessions.touch("bot-b", "conv-theirs", { url: "https://example.test/private", title: "Private" });
  sessions.touch("bot-c", "conv-watch", { url: "https://example.test/home", title: "Home" });
  askId = (await takeovers.open({ conversationId: "conv-mine", reason: "the sign-in needs you" }))
    .id;
  const mind = {
    browserSessions: sessions,
    browserTakeovers: takeovers,
    browserSignins: {
      list: (owner: string) =>
        owner === OWNER_ID
          ? [{ profile: "bot-mine", sites: ["google.com"], savedAt: 5 }]
          : [{ profile: "bot-theirs", sites: ["bank.example"], savedAt: 6 }],
    },
    browserLife: {
      forget: async (owner: string, profile: string) => {
        forgot.push(`${owner}/${profile}`);
        return true;
      },
      history: (owner: string, profile: string) => [
        { at: 1, kind: "page", text: `${owner}/${profile}` },
      ],
      close: async (conversationId: string) => {
        closed.push(conversationId);
        return true;
      },
    },
    org: { view: async () => undefined },
    browserSignIn: async (conversationId: string, url: string, botName: string) => {
      signIns.push(`${conversationId} ${url} ${botName}`);
      return { ok: true, takeoverId: "t-1" };
    },
    converse: {
      conversationIdOf: (key: string) => Effect.succeed(`conv-of-${key}`),
    },
    profiles: {
      scopeOf: (conversationId: string) =>
        conversationId.endsWith("-theirs")
          ? { owner: "owner-b", profileId: "bot-theirs" }
          : { owner: OWNER_ID, profileId: "bot-mine" },
      get: async (owner: string, id: string) =>
        id === "bot-theirs" ? undefined : { owner, id, name: "Browsing Bot", teamId: null },
      ensureMain: async (_owner: string, id: string) => ({ id: `main-${id}` }),
      keyOfRow: async (row: { id: string }) => row.id,
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
      readJson: <T>(request: typeof req) =>
        new Promise<T>((resolve) => {
          let raw = "";
          request.on("data", (chunk) => {
            raw += String(chunk);
          });
          request.on("end", () => resolve(JSON.parse(raw === "" ? "{}" : raw) as T));
        }),
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
    expect(body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: "conv-mine",
          url: "https://example.test/signin",
          title: "Sign in",
          botName: "Browsing Bot",
          profileId: "bot-mine",
          takeoverId: askId,
        }),
      ]),
    );
    expect(body.sessions.map((row) => row.conversationId).toSorted()).toEqual([
      "conv-mine",
      "conv-watch",
    ]);
  });

  it("answers another owner's watch stream like a missing one", async () => {
    const theirs = await fetch(`${base}/api/browser/sessions/conv-theirs/cast`);
    const missing = await fetch(`${base}/api/browser/sessions/conv-nobody/cast`);
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
  });

  it("never watches a session under an open takeover (the owner drives it there)", async () => {
    expect((await fetch(`${base}/api/browser/sessions/conv-mine/cast`)).status).toBe(404);
  });

  it("closes only my bots' sessions", async () => {
    const theirs = await fetch(`${base}/api/browser/sessions/conv-theirs`, { method: "DELETE" });
    expect(theirs.status).toBe(404);
    const mine = await fetch(`${base}/api/browser/sessions/conv-watch`, { method: "DELETE" });
    expect(mine.status).toBe(200);
    expect(closed).toEqual(["conv-watch"]);
  });

  it("lists and forgets only my bots' saved sign-ins, and shows only my bots' history", async () => {
    const list = (await (await fetch(`${base}/api/browser/signins`)).json()) as {
      signins: unknown[];
    };
    expect(list.signins).toEqual([
      { profileId: "bot-mine", botName: "Browsing Bot", sites: ["google.com"], savedAt: 5 },
    ]);
    expect(
      (await fetch(`${base}/api/browser/signins/bot-theirs`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await fetch(`${base}/api/browser/signins/bot-mine`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(forgot).toEqual([`${OWNER_ID}/bot-mine`]);
    const theirs = (await (await fetch(`${base}/api/browser/history/bot-theirs`)).json()) as {
      history: unknown[];
    };
    expect(theirs.history).toEqual([]);
    const mine = (await (await fetch(`${base}/api/browser/history/bot-mine`)).json()) as {
      history: unknown[];
    };
    expect(mine.history).toHaveLength(1);
  });

  it("signs only my bots in, and only to an http(s) page", async () => {
    const post = (bot: string, url: string) =>
      fetch(`${base}/api/browser/bots/${bot}/signin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
    expect((await post("bot-theirs", "https://x.example/")).status).toBe(404);
    expect((await post("bot-mine", "javascript:alert(1)")).status).toBe(400);
    expect((await post("bot-mine", "accounts.example.com")).status).toBe(200);
    expect(signIns).toEqual(["conv-of-main-bot-mine https://accounts.example.com/ Browsing Bot"]);
  });
});
