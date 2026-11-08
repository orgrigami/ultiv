/**
 * Chats coordinate, tasks work (chat-tools.ts): a bot's chat is offered only
 * the chat tools, its task conversation the work tools too; a chat calling a
 * work tool anyway is refused before it runs; a chat made before the split
 * gets the filter at boot; and every name on the list is a real tool.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { healChats } from "../entity-chats.ts";
import { agentForProfile } from "./agent.ts";
import { CHAT_ROLE, CHAT_TOOLS, chatMayCall, chatToolsExtension } from "./chat-tools.ts";

const offered = async (
  converse: Awaited<ReturnType<typeof openMind>>["mind"]["converse"],
  key: string,
): Promise<string[]> => {
  const chat = await Effect.runPromise(converse.ensure(key));
  return (await chat.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
};

describe("the chat/task split", () => {
  it("offers a chat only the chat tools and a task the work tools too", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles, converse } = handle.mind;
    const bot = await profiles.create("harry", { name: "Alfred", onboard: false });
    const main = await profiles.keyOfRow(await profiles.ensureMain("harry", bot.id));
    const inChat = await offered(converse, main);
    expect(inChat).toContain("task_spawn");
    expect(inChat).toContain("memory_recall");
    expect(inChat.filter((name) => !chatMayCall(name))).toEqual([]);
    const mainId = String(await Effect.runPromise(converse.conversationIdOf(main)));
    await profiles.bindTask("task:split-test", mainId, null);
    const inTask = await offered(converse, "task:split-test");
    expect(inTask).toContain("artifact_write");
    expect(inTask).toContain("codemode");
    await handle.close();
  });

  it("heals a chat made before the split at the next boot", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles, converse } = handle.mind;
    const bot = await profiles.create("harry", { name: "Alfred", onboard: false });
    const main = await profiles.keyOfRow(await profiles.ensureMain("harry", bot.id));
    const chat = await Effect.runPromise(converse.ensure(main));
    await Effect.runPromise(converse.configure(chat, { modelTools: null }));
    expect(await offered(converse, main)).toContain("artifact_write");
    await healChats(converse, profiles);
    expect((await offered(converse, main)).filter((name) => !chatMayCall(name))).toEqual([]);
    await handle.close();
  });

  it("refuses a chat's work tool before it runs, never a task's", async () => {
    const kinds: Record<string, "main" | "task"> = { chat: "main", task: "task" };
    const extension = chatToolsExtension((id) => kinds[id]);
    const before = extension.hooks?.[0] as unknown as {
      readonly handlers: { readonly beforeTool: (call: unknown, api: unknown) => unknown };
    };
    const call = (name: string, conversationId: string) =>
      before.handlers.beforeTool({ name, id: "c", arguments: {} }, { conversationId });
    expect(call("web_fetch", "chat")).toMatchObject({
      block: expect.stringContaining("task_spawn"),
    });
    expect(call("task_spawn", "chat")).toBeUndefined();
    expect(call("web_fetch", "task")).toBeUndefined();
    expect(call("web_fetch", "unmapped")).toBeUndefined();
    // The role line reaches chats only.
    const role = extension.sections?.[0];
    const render = (conversationId: string) =>
      role?.render({ conversationId } as never, undefined as never);
    expect(render("chat")).toBe(CHAT_ROLE);
    expect(render("task")).toBeUndefined();
  });

  it("adds the chat filter only for chats", () => {
    const profile = {
      model: null,
      toolAllowlist: null,
      policies: { sandbox: true },
    } as unknown as Parameters<typeof agentForProfile>[0];
    expect(
      agentForProfile(profile, () => [], undefined, [], undefined, "main").modelTools,
    ).toBeDefined();
    expect(
      agentForProfile(profile, () => [], undefined, [], undefined, "task").modelTools,
    ).toBeUndefined();
    expect(agentForProfile(profile, () => []).modelTools).toBeUndefined();
  });

  it("lists only tools the packages define", () => {
    const packages = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sources(path);
        return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
      });
    const text = readdirSync(packages)
      .flatMap((pkg) => {
        try {
          return sources(join(packages, pkg, "src"));
        } catch {
          return [];
        }
      })
      .filter((path) => path !== fileURLToPath(new URL("./chat-tools.ts", import.meta.url)))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const missing = CHAT_TOOLS.filter((name) => !text.includes(`"${name}"`));
    expect(missing).toEqual([]);
  });
});
