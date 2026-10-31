import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { ProfileInfo } from "@spreissen/contracts";
import type { AuditService } from "../audit/audit.ts";
import type { TasksService } from "../tasks/tasks.ts";
import type { ProfilesService } from "./profiles.ts";
import { BOT_INFO, BOTS_LIST, botsTools, taskActivity } from "./bots-tools.ts";

const bot = (id: string, name: string, overrides: Partial<ProfileInfo> = {}): ProfileInfo => ({
  id,
  owner: "harry",
  name,
  description: `${name} does things. Second sentence stays out of the list.`,
  persona: `You are ${name}, calm.\nSECRET-PERSONA-DETAIL keep this private`,
  timezone: "Asia/Jakarta",
  model: null,
  toolAllowlist: null,
  policies: { canInitiate: ["*"], autoApprove: [] } as unknown as ProfileInfo["policies"],
  createdAt: 0,
  archivedAt: null,
  ...overrides,
});

const policy = (canInitiate: string[]) =>
  ({ canInitiate, autoApprove: [] }) as unknown as ProfileInfo["policies"];

const scout = bot("p1", "Scout", { policies: policy(["p2"]) });
const ledger = bot("p2", "Ledger", {
  toolAllowlist: ["memory_recall", "web_search", "artifact_write"],
  policies: policy([]),
});
const quiet = bot("p3", "Quiet");
const old = bot("p4", "Oldie", { archivedAt: 5 });
const all = [scout, ledger, quiet, old];

const audited: string[] = [];
const audit = {
  record: (event: { name: string }) => audited.push(event.name),
} as unknown as AuditService;
const profiles = {
  profileOf: (conversationId: string) => (conversationId === "c1" ? scout : undefined),
  list: async () => all,
} as unknown as ProfilesService;
const tasks = {
  list: () =>
    Effect.succeed([
      { status: "running", bot: { owner: "harry", profileId: "p2" } },
      { status: "done", bot: { owner: "harry", profileId: "p3" } },
    ]),
} as unknown as TasksService;

const tools = botsTools({ profiles, audit, activity: taskActivity(tasks) });
const run = async (name: string, args: object, conversationId = "c1") => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing ${name}`);
  const result = (await tool.execute(
    args as never,
    { conversationId, callId: "k1" } as never,
    {} as never,
  )) as {
    output: { text: string }[];
    isError?: boolean;
  };
  return {
    text: result.output.map((part) => part.text).join(""),
    isError: result.isError === true,
  };
};

describe("bots_list", () => {
  it("lists active bots with role, contact right and tool groups", async () => {
    const { text } = await run(BOTS_LIST, {});
    expect(text).toContain("Ledger (id: p2) - Ledger does things.; you may message it: yes");
    expect(text).toContain("Quiet (id: p3) - Quiet does things.; you may message it: no");
    expect(text).toContain("Scout (id: p1) (you)");
    expect(text).toContain("tools: files, memory, web");
    expect(text).not.toContain("Second sentence");
    expect(text).not.toContain("Oldie");
    expect(audited).toContain(BOTS_LIST);
  });

  it("shows archived bots only when asked, marked", async () => {
    const { text } = await run(BOTS_LIST, { includeArchived: true });
    expect(text).toContain("Oldie (id: p4) [archived]");
    expect(text).toContain("you may message it: no");
  });

  it("refuses conversations that belong to no bot", async () => {
    expect((await run(BOTS_LIST, {}, "stray")).isError).toBe(true);
  });
});

describe("bot_info", () => {
  it("resolves a name case-insensitively and states both contact directions", async () => {
    const { text, isError } = await run(BOT_INFO, { bot: "lEdGeR" });
    expect(isError).toBe(false);
    expect(text).toContain("Ledger (id: p2)");
    expect(text).toContain("You may message it: yes");
    expect(text).toContain("It may message you first: no");
    expect(text).toContain("Tool groups: files, memory, web");
    expect(text).toContain("Activity: busy (1 background task(s) running)");
    expect(text).toContain("Persona (first line): You are Ledger, calm.");
  });

  it("resolves by id and reports idle and blocked contact", async () => {
    const { text } = await run(BOT_INFO, { bot: "p3" });
    expect(text).toContain("You may message it: no (your contact policy)");
    expect(text).toContain("It may message you first: yes");
    expect(text).toContain("Activity: idle");
  });

  it("marks an archived bot", async () => {
    const { text } = await run(BOT_INFO, { bot: "oldie" });
    expect(text).toContain("Status: archived");
    expect(text).not.toContain("Activity:");
  });

  it("answers an unknown name with close matches", async () => {
    const near = await run(BOT_INFO, { bot: "Ledgr" });
    expect(near.isError).toBe(true);
    expect(near.text).toContain('no such bot "Ledgr"');
    expect(near.text).toContain("Did you mean: Ledger");
    const far = await run(BOT_INFO, { bot: "Zzzzzzzzzz" });
    expect(far.text).not.toContain("Did you mean");
  });

  it("never leaks private data", async () => {
    const texts = [
      (await run(BOTS_LIST, { includeArchived: true })).text,
      ...(await Promise.all(
        all.map(async (target) => (await run(BOT_INFO, { bot: target.id })).text),
      )),
    ].join("\n");
    expect(texts).not.toContain("SECRET-PERSONA-DETAIL");
    expect(texts).not.toContain("memory_recall");
    expect(texts).not.toContain("web_search");
    expect(texts).not.toMatch(/vault item|harry/);
  });
});
