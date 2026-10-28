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
): { args: RouteArgs; body: () => unknown } => {
  let captured: unknown;
  const args = {
    mind,
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL("http://x/api/tasks"),
    owner,
    path: "/api/tasks",
    json: (_status: number, body: unknown) => {
      captured = body;
    },
    readJson: async <T>() => undefined as T,
    readBody: async () => Buffer.alloc(0),
  } as unknown as RouteArgs;
  return { args, body: () => captured };
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
});
