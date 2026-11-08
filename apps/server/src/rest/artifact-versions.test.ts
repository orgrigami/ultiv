/**
 * A bot's files as one tree over REST: uploads land under uploads/ with a
 * free name, a file written again lists once and keeps its versions, a
 * restore puts one back, a delete takes the file out of the tree, and
 * another owner's file answers like a missing one (fake RouteArgs, no HTTP).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { DurableFs, putFile, readArtifact } from "@spriessen/ext";
import { artifactRoutes } from "./artifacts.ts";
import type { RouteArgs } from "./types.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spriessen-rest-tree-"));
  process.env["ARTIFACTS_DIR"] = root;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const call = async (method: string, target: string, owner = "owner", body = Buffer.alloc(0)) => {
  let status = 0;
  let payload: unknown;
  const url = new URL(`http://x${target}`);
  const args = {
    mind: {
      profiles: {
        list: async () => [{ id: "p1" }],
        get: async (_owner: string, id: string) =>
          id === "p1" ? { id: "p1", owner: "owner" } : undefined,
        rowOf: async (id: string) =>
          id === "s1" ? { id: "s1", owner: "owner", profile: "p1" } : undefined,
        keyForSession: async () => "key-1",
      },
      converse: { conversationIdOf: () => Effect.succeed("conv-1") },
      org: { view: async () => undefined },
    },
    req: { method } as IncomingMessage,
    res: { writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse,
    url,
    owner,
    path: url.pathname,
    json: (code: number, value: unknown) => {
      status = code;
      payload = value;
    },
    readJson: async <T>() => undefined as T,
    readBody: async () => body,
  } as unknown as RouteArgs;
  await artifactRoutes(args, (after) => decodeURIComponent(url.pathname.slice(after.length)));
  return { status, body: payload as Record<string, unknown> & Record<number, unknown> };
};

const botDir = (): string => join(root, "owner", "p1");
const write = async (path: string, text: string) => {
  const put = await putFile(botDir(), path, Buffer.from(text), { owner: "owner", profile: "p1" });
  if ("refused" in put) throw new Error(put.refused);
  return put.info;
};

describe("a bot's files over REST", () => {
  it("an upload from a chat lands in the bot's tree under uploads/, never replacing", async () => {
    const first = await call(
      "POST",
      "/api/artifacts?name=image.png&sessionId=s1",
      "owner",
      Buffer.from("a"),
    );
    const second = await call(
      "POST",
      "/api/artifacts?name=image.png&sessionId=s1",
      "owner",
      Buffer.from("b"),
    );
    expect(first.body).toMatchObject({
      path: "uploads/image.png",
      profile: "p1",
      mime: "image/png",
    });
    expect(second.body).toMatchObject({ path: "uploads/image (2).png" });
    expect(new DurableFs({ dir: botDir() }).allFilePaths()).toEqual([
      "/uploads/image (2).png",
      "/uploads/image.png",
    ]);
  });

  it("a file written twice lists once, newest write first, with its versions", async () => {
    const info = await write("/board.md", "one");
    await write("/board.md", "two");
    const list = await call("GET", "/api/artifacts?profile=p1");
    expect((list.body as unknown as { id: string }[]).map((row) => row.id)).toEqual([info.id]);
    const versions = await call("GET", `/api/artifacts/${info.id}/versions`);
    expect(versions.status).toBe(200);
    const [version] = versions.body as unknown as { id: string; versionOf: string }[];
    expect(version?.versionOf).toBe(info.id);
    const restored = await call(
      "POST",
      `/api/artifacts/${info.id}/versions/${version?.id}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(readArtifact(botDir(), info.id)?.text).toBe("one");
  });

  it("another owner's file and an unknown version answer like missing ones", async () => {
    const info = await write("/a.md", "x");
    const foreign = await call("GET", `/api/artifacts/${info.id}/versions`, "someone-else");
    expect(foreign).toEqual({ status: 404, body: { error: "unknown artifact" } });
    const unknown = await call("POST", `/api/artifacts/${info.id}/versions/nope/restore`);
    expect(unknown).toEqual({ status: 404, body: { error: "unknown version" } });
  });

  it("a delete takes the file out of the tree", async () => {
    const info = await write("/notes/a.md", "x");
    const removed = await call("DELETE", `/api/artifacts/${info.id}`);
    expect(removed.body).toEqual({ ok: true });
    expect(new DurableFs({ dir: botDir() }).allFilePaths()).toEqual([]);
  });
});
