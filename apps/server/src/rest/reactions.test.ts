/**
 * GET /api/sessions/:sessionId/reactions over a real offline mind: the rows
 * a react write stored, an unknown session and another owner's session both
 * reading as the same 404, and a registered session with no conversation yet
 * reading as an empty list.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, ReactionsDoc, stepIdOf } from "@spriessen/mind";
import type { ReactionRow } from "@spriessen/contracts";
import type { RouteArgs } from "./types.ts";
import { reactionRoutes } from "./reactions.ts";

/** Minimal RouteArgs over a real offline mind; captures the JSON response. */
const routeArgs = (
  mind: Awaited<ReturnType<typeof openMind>>["mind"],
  opts: { path: string; owner?: string },
): { args: RouteArgs; status: () => number; body: () => unknown } => {
  let captured: { status: number; body: unknown } | undefined;
  return {
    args: {
      mind,
      scheduler: {} as RouteArgs["scheduler"],
      req: { method: "GET" } as RouteArgs["req"],
      res: {} as RouteArgs["res"],
      url: new URL(`http://localhost${opts.path}`),
      owner: opts.owner ?? "harry",
      path: opts.path,
      json: (status, body) => {
        captured = { status, body };
      },
      readJson: async <T>() => ({}) as T,
      readBody: async () => Buffer.from("{}"),
    },
    status: () => captured?.status ?? 0,
    body: () => captured?.body,
  };
};

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { mind } = handle;
  const bot = await mind.profiles.create("harry", { name: "Acker", onboard: false });
  const session = await mind.profiles.createSession("harry", bot.id, "reactions");
  const key = await mind.profiles.keyForSession("harry", session.id);
  const conversation = await Effect.runPromise(mind.converse.ensure(key));
  await Effect.runPromise(mind.converse.submit(conversation, "ship it"));
  const entries = (await Effect.runPromise(
    mind.converse.entriesOf(String(conversation.id), 10),
  )) as readonly { id: number; kind: string }[];
  const latest = entries.find((entry) => entry.kind === "pi.user");
  if (latest === undefined) throw new Error("no owner entry after submit");
  const row: ReactionRow = {
    entryId: stepIdOf(latest.id),
    emoji: "ack",
    reactorProfileId: bot.id,
    createdAt: Date.now(),
  };
  await Effect.runPromise(
    mind.converse.docs.commit(async (tx) => {
      const draft = await tx.doc(ReactionsDoc, String(conversation.id), { rows: [] });
      draft.rows = [structuredClone(row)];
    }),
  );
  return { handle, mind, session, row };
};

describe("GET /api/sessions/:sessionId/reactions", () => {
  it("returns the stored rows for the owner's session", async () => {
    const { handle, mind, session, row } = await setup();
    const ok = routeArgs(mind, { path: `/api/sessions/${session.id}/reactions` });
    expect(await reactionRoutes(ok.args)).toBe(true);
    expect(ok.status()).toBe(200);
    expect(ok.body()).toEqual({ reactions: [row] });
    await handle.close();
  });

  it("answers an unknown id and another owner's id with the same 404", async () => {
    const { handle, mind, session } = await setup();
    const unknown = routeArgs(mind, { path: "/api/sessions/no-such-session/reactions" });
    expect(await reactionRoutes(unknown.args)).toBe(true);
    expect(unknown.status()).toBe(404);
    const foreign = routeArgs(mind, {
      path: `/api/sessions/${session.id}/reactions`,
      owner: "someone-else",
    });
    expect(await reactionRoutes(foreign.args)).toBe(true);
    expect(foreign.status()).toBe(404);
    expect(foreign.body()).toEqual(unknown.body());
    await handle.close();
  });

  it("reads a registered session with no conversation yet as empty", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const bot = await handle.mind.profiles.create("harry", { name: "Quiet", onboard: false });
    const session = await handle.mind.profiles.createSession("harry", bot.id, "never opened");
    const empty = routeArgs(handle.mind, { path: `/api/sessions/${session.id}/reactions` });
    expect(await reactionRoutes(empty.args)).toBe(true);
    expect(empty.status()).toBe(200);
    expect(empty.body()).toEqual({ reactions: [] });
    await handle.close();
  });
});
