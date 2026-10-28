/**
 * The tasks list carries each running task's waiting gate, so the thread that
 * spawned the task can render the approval card without opening the task
 * sheet (fake RouteArgs over stubbed mind services — no DB).
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { IncomingMessage, ServerResponse } from "node:http";
import { taskRoutes } from "./tasks.ts";
import type { RouteArgs } from "./types.ts";

const fakeArgs = (
  mind: Record<string, unknown>,
  owner = "owner",
): { args: RouteArgs; body: () => unknown; status: () => number } => {
  let captured: unknown;
  let capturedStatus = 0;
  const args = {
    mind,
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL("http://x/api/tasks"),
    owner,
    path: "/api/tasks",
    json: (status: number, body: unknown) => {
      capturedStatus = status;
      captured = body;
    },
    readJson: async <T>() => undefined as T,
    readBody: async () => Buffer.alloc(0),
  } as unknown as RouteArgs;
  return { args, body: () => captured, status: () => capturedStatus };
};

const runningTask = (id: string, owner = "owner", bot?: { owner: string; profileId: string }) => ({
  id,
  sessionId: "s1",
  owner,
  conversationId: "conv-1",
  prompt: "do things",
  status: "running",
  result: null,
  error: null,
  createdAt: 1,
  finishedAt: null,
  ...(bot === undefined ? {} : { bot }),
});

describe("GET /api/tasks carries waiting approvals", () => {
  it("a running task with a parked gate exposes the decide target and the waiting call", async () => {
    const { args, body } = fakeArgs({
      tasks: {
        list: () => Effect.succeed([runningTask("t1")]),
        steps: async () => ["stepping"],
      },
      converse: {
        conversationIdOf: () => Effect.succeed("42"),
      },
      approvals: {
        pendingFor: (conversationId: string) =>
          conversationId === "42"
            ? [{ callId: "c9", name: "bash", input: { command: "ls" }, reason: "joe asked" }]
            : [],
      },
    });
    const handled = await taskRoutes(args, () => "");
    expect(handled).toBe(true);
    const rows = body() as Array<Record<string, unknown>>;
    expect(rows[0]?.taskConversationId).toBe("42");
    expect(rows[0]?.waitingApproval).toEqual({
      callId: "c9",
      name: "bash",
      input: { command: "ls" },
      reason: "joe asked",
    });
    expect(rows[0]?.lastStep).toBe("stepping");
  });

  it("a running task with nothing parked carries no waitingApproval; settled rows are untouched", async () => {
    const settled = { ...runningTask("t2"), status: "done", finishedAt: 2 };
    const { args, body } = fakeArgs({
      tasks: {
        list: () => Effect.succeed([runningTask("t1"), settled]),
        steps: async () => [],
      },
      converse: {
        // The task conversation has not been created (or already retired).
        conversationIdOf: () => Effect.succeed(undefined),
      },
      approvals: {
        pendingFor: () => [],
      },
    });
    await taskRoutes(args, () => "");
    const rows = body() as Array<Record<string, unknown>>;
    expect(rows[0]?.taskConversationId).toBeNull();
    expect(rows[0]?.waitingApproval).toBeUndefined();
    expect(rows[1]?.taskConversationId).toBeUndefined(); // settled rows pass through
  });

  it("rows carry waiting approval INPUTS, so a guest sees only its own rows and its bot's agent rows", async () => {
    const { args, body } = fakeArgs(
      {
        tasks: {
          list: () =>
            Effect.succeed([
              runningTask("t-mine", "guest"),
              runningTask("t-foreign", "someone-else"),
              runningTask("t-agent-mine", "agent", { owner: "guest", profileId: "p1" }),
              runningTask("t-agent-foreign", "agent", { owner: "eve", profileId: "p2" }),
              runningTask("t-agent-nobot", "agent"),
            ]),
          steps: async () => [],
        },
        converse: { conversationIdOf: () => Effect.succeed("42") },
        approvals: {
          pendingFor: (conversationId: string) =>
            conversationId === "42"
              ? [
                  {
                    callId: "c1",
                    name: "http_request",
                    input: { url: "https://x/?token=zzz" },
                    reason: null,
                  },
                ]
              : [],
        },
      },
      "guest",
    );
    await taskRoutes(args, () => "");
    const rows = body() as Array<{ id: string }>;
    // A foreign owner's task, an agent task bound to another principal's bot,
    // and an unbound agent row — inputs and all — never leave the server.
    expect(rows.map((row) => row.id)).toEqual(["t-mine", "t-agent-mine"]);
  });

  it("named owners do not see each other's rows or bots either — the header is not a boundary", async () => {
    const { args, body } = fakeArgs(
      {
        tasks: {
          list: () =>
            Effect.succeed([
              runningTask("t-harry", "harry"),
              runningTask("t-agent-eve", "agent", { owner: "eve", profileId: "p2" }),
              runningTask("t-agent-harry", "agent", { owner: "harry", profileId: "p1" }),
            ]),
          steps: async () => [],
        },
        converse: { conversationIdOf: () => Effect.succeed("42") },
        approvals: { pendingFor: () => [] },
      },
      "eve",
    );
    await taskRoutes(args, () => "");
    const rows = body() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["t-agent-eve"]);
  });

  it("no principal may NAME itself the agent sentinel — it sees no rows at all", async () => {
    const { args, body } = fakeArgs(
      {
        tasks: {
          list: () =>
            Effect.succeed([
              runningTask("t-agent-mine", "agent", { owner: "agent", profileId: "p1" }),
              runningTask("t-plain", "agent"),
              runningTask("t-harry", "harry"),
            ]),
          steps: async () => [],
        },
        converse: { conversationIdOf: () => Effect.succeed("42") },
        approvals: { pendingFor: () => [] },
      },
      "agent",
    );
    await taskRoutes(args, () => "");
    const rows = body() as Array<{ id: string }>;
    expect(rows).toEqual([]);
  });

  it("every task branch is scoped: foreign ids 404, the caller's own bot row passes", async () => {
    const mine = runningTask("t-mine", "guest", { owner: "guest", profileId: "p1" });
    const foreign = runningTask("t-foreign", "eve", { owner: "eve", profileId: "p2" });
    const rig = (id: string, row: typeof mine | typeof foreign | undefined, owner = "guest") => {
      const { args, body, status } = fakeArgs(
        {
          tasks: {
            list: () => Effect.succeed([]),
            get: () => Effect.succeed(row),
            cancel: () => Effect.succeed({ cancelled: true }),
            remove: () => Effect.succeed({ id }),
          },
          converse: { conversationIdOf: () => Effect.succeed("42") },
          approvals: { pendingFor: () => [] },
        },
        owner,
      );
      return { args, body, status };
    };
    const segment = (path: string) => path.slice("/api/tasks/".length);
    // Single GET.
    for (const path of [`/api/tasks/${foreign.id}`, `/api/tasks/${mine.id}`]) {
      const r = rig(segment(path), path.endsWith("foreign") ? foreign : mine);
      (r.args as { path: string }).path = path;
      await taskRoutes(r.args, segment);
      expect(r.status()).toBe(path.endsWith("foreign") ? 404 : 200);
    }
    // Cancel.
    const cancelForeign = rig(foreign.id, foreign);
    (cancelForeign.args as { path: string }).path = `/api/tasks/${foreign.id}/cancel`;
    await taskRoutes(cancelForeign.args, () => "");
    expect(cancelForeign.status()).toBe(404);
    const cancelMine = rig(mine.id, mine);
    (cancelMine.args as { path: string }).path = `/api/tasks/${mine.id}/cancel`;
    await taskRoutes(cancelMine.args, () => "");
    expect(cancelMine.status()).toBe(200);
    // DELETE.
    const deleteForeign = rig(foreign.id, foreign);
    (deleteForeign.args as { path: string }).path = `/api/tasks/${foreign.id}`;
    (deleteForeign.args as { req: IncomingMessage }).req = { method: "DELETE" } as IncomingMessage;
    await taskRoutes(deleteForeign.args, segment);
    expect(deleteForeign.status()).toBe(404);
    const deleteMine = rig(mine.id, mine);
    (deleteMine.args as { path: string }).path = `/api/tasks/${mine.id}`;
    (deleteMine.args as { req: IncomingMessage }).req = { method: "DELETE" } as IncomingMessage;
    await taskRoutes(deleteMine.args, segment);
    expect(deleteMine.status()).toBe(200);
  });
});
