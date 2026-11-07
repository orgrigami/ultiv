/** A file's source chat: direct, through the task that wrote it, or none. */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { artifactSources } from "./artifact-source.ts";
import type { RouteArgs } from "./types.ts";

const row = (id: string, kind: string, profile = "p1") => ({
  id,
  owner: "owner",
  profile,
  kind,
  participants: null,
  title: `Chat ${id}`,
  createdAt: 1,
  lastMessageAt: 1,
});

const CONVERSATIONS: Record<string, string> = {
  "key:s-main": "conv-main",
  "key:s-side": "conv-side",
  "task:t1": "conv-task-1",
  "task:t2": "conv-task-2",
};

const argsFor = (owner = "owner"): RouteArgs =>
  ({
    owner,
    mind: {
      profiles: {
        listSessions: async (who: string) =>
          who === "owner" ? [row("s-main", "main"), row("s-side", "chat")] : [],
        keyOfRow: async (session: { id: string }) => `key:${session.id}`,
      },
      converse: {
        conversationIdOf: (key: string) => Effect.succeed(CONVERSATIONS[key]),
      },
      tasks: {
        list: () =>
          Effect.succeed([
            {
              id: "t1",
              owner: "owner",
              sessionId: "s-side",
              conversationId: "conv-side",
              prompt: "Find flights",
              title: "Flights",
              bot: { owner: "owner", profileId: "p1" },
            },
            {
              id: "t2",
              owner: "someone-else",
              sessionId: "s-x",
              conversationId: "conv-x",
              prompt: "Theirs",
              bot: { owner: "someone-else", profileId: "px" },
            },
          ]),
      },
    },
  }) as unknown as RouteArgs;

describe("artifactSources", () => {
  it("names the chat whose conversation wrote the file", async () => {
    const resolve = await artifactSources(argsFor(), ["p1"]);
    expect(await resolve("conv-main")).toEqual({
      sessionId: "s-main",
      title: "Chat s-main",
      main: true,
      botId: "p1",
    });
    expect(await resolve(null)).toBeNull();
    expect(await resolve("conv-unknown")).toBeNull();
  });

  it("follows a task's file back to the chat that spawned it", async () => {
    const resolve = await artifactSources(argsFor(), ["p1"]);
    expect(await resolve("conv-task-1")).toMatchObject({
      sessionId: "s-side",
      main: false,
      task: { id: "t1", title: "Flights" },
    });
  });

  it("never names another owner's task or chat", async () => {
    const resolve = await artifactSources(argsFor(), ["p1"]);
    expect(await resolve("conv-task-2")).toBeNull();
    const stranger = await artifactSources(argsFor("stranger"), ["p1"]);
    expect(await stranger("conv-main")).toBeNull();
  });
});
