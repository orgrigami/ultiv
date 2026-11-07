/**
 * Slice 10: the host-access switch. The matrix (org AND team AND bot,
 * `blockedBy` naming the level) lives in `org.test.ts`; here: the tool-list
 * exclusion, the watch that re-applies agents on a flip, and — on a real
 * in-memory mind — yolo failing to bypass a false switch and the tools
 * leaving the list while it is off.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentChange } from "@earendil-works/pi-durable";
import { agentForProfile } from "../profiles/agent.ts";
import { hostExcludedTools, hostSwitchWatch, reapplyAgentTools } from "./host-switch.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const flagsOf = (org: boolean | null, teams: [string, boolean][] = []) => ({
  org: org === null ? null : ({ hostAccess: org } as never),
  teams: teams.map(([id, hostAccess]) => ({ id, hostAccess })) as never,
});

const teamBot = (hostAccess: boolean, teamId = "team-x") => ({ teamId, hostAccess }) as never;
const orgBot = (hostAccess: boolean) => ({ teamId: null, hostAccess }) as never;

describe("hostExcludedTools", () => {
  const stdio = ["notes_search", "notes_write"];

  it("drops the stdio connector tools whenever one level is off — bash never leaves the list", () => {
    expect(hostExcludedTools(flagsOf(true, [["team-x", true]]), teamBot(true), stdio)).toEqual([]);
    expect(hostExcludedTools(flagsOf(false, [["team-x", true]]), teamBot(true), stdio)).toEqual([
      ...stdio,
    ]);
    expect(hostExcludedTools(flagsOf(true, [["team-x", false]]), teamBot(true), stdio)).toEqual([
      ...stdio,
    ]);
    expect(hostExcludedTools(flagsOf(true), orgBot(false), stdio)).toEqual([...stdio]);
  });

  it("blocks a bot whose team is gone, and everything before the first read", () => {
    expect(hostExcludedTools(flagsOf(true, []), teamBot(true), stdio)).toEqual([...stdio]);
    // Fail-closed: before the first read (no flags yet) and with no org
    // row at all, the stdio tools are excluded too. The merged bash tool is
    // NEVER in the exclusion — its default vm target is ordinary work; the
    // per-call guard refuses its host/node targets instead.
    expect(hostExcludedTools(undefined, orgBot(true), stdio)).toEqual([...stdio]);
    expect(hostExcludedTools(flagsOf(null), orgBot(true), stdio)).toEqual([...stdio]);
    expect(hostExcludedTools(flagsOf(false), orgBot(true), [])).toEqual([]);
  });
});

describe("agentForProfile with the host exclusion", () => {
  const tools = () => [{ name: "bash" }, { name: "notes_search" }, { name: "web_search" }];
  const profile = {
    model: null,
    toolAllowlist: null,
    policies: {},
    teamId: null,
    hostAccess: false,
  } as never;

  it("removes the listed tools from the bot's tool set", () => {
    const agent = agentForProfile(profile, tools, undefined, ["notes_search"]);
    // A remove filter, not a frozen list: faculty tools and late installs stay.
    const removed = (agent.tools as { remove: readonly { readonly name: string }[] }).remove.map(
      (tool) => tool.name,
    );
    expect(removed).toEqual(["notes_search"]);
  });

  it("leaves the list dynamic when the switch allows", () => {
    const agent = agentForProfile(profile, tools, undefined, []);
    expect(agent.tools).toBeNull();
  });
});

describe("hostSwitchWatch", () => {
  it("re-applies every bot's agent when a switch flips, not on other changes", async () => {
    let state = { org: { hostAccess: true }, teams: [] };
    const configured: (string | null)[] = [];
    const watch = hostSwitchWatch({
      view: (async () => state) as never,
      allProfiles: async () => [{ id: "p1", owner: "o" }] as never,
      agentFor: () => ({ tools: null }) as never,
      reapply: {
        converse: {
          open: () => Effect.succeed({}),
          conversationIdOf: (key: string) => Effect.succeed(`cid-${key}`) as never,
          configure: (_chat: unknown, selection: { tools: unknown }) => {
            configured.push(selection.tools as string | null);
            return Effect.succeed(undefined) as never;
          },
        } as never,
        listSessions: async () => [{ profile: "p1", owner: "o", id: "s1" }] as never,
        keyOfRow: async () => "k",
        taskConversations: async () => [],
      },
    });
    await watch.refresh();
    watch.onOrgChange();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No flip: the tools are untouched.
    expect(configured).toEqual([]);
    state = { org: { hostAccess: false }, teams: [] };
    watch.onOrgChange();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A flip re-applies: tools null means "everything but the exclusions".
    expect(configured).toEqual([null]);
  });

  it("resyncStored heals every stored bot at boot, even with no flip", async () => {
    // A conversation created under the old rule holds a frozen list without
    // `message`; the boot pass re-applies the CURRENT agent (a remove filter).
    const configured: unknown[] = [];
    const watch = hostSwitchWatch({
      view: (async () => ({ org: { hostAccess: false }, teams: [] })) as never,
      allProfiles: async () =>
        [
          { id: "p1", owner: "o" },
          { id: "p2", owner: "o" },
        ] as never,
      agentFor: () => ({ tools: { remove: [{ name: "notes_search" }] } }) as never,
      reapply: {
        converse: {
          open: () => Effect.succeed({}),
          conversationIdOf: (key: string) => Effect.succeed(`cid-${key}`) as never,
          configure: (_chat: unknown, selection: { tools: unknown }) => {
            configured.push(selection.tools);
            return Effect.succeed(undefined) as never;
          },
        } as never,
        listSessions: async (_owner: string, id: string) =>
          [{ profile: id, owner: "o", id: `s-${id}` }] as never,
        keyOfRow: async (row: { id: string }) => row.id,
        taskConversations: async () => [],
      } as never,
    });
    await watch.refresh();
    await watch.resyncStored();
    expect(configured).toEqual([
      { remove: [{ name: "notes_search" }] },
      { remove: [{ name: "notes_search" }] },
    ]);
  });

  it("reapplyAgentTools configures only the profile's own conversations", async () => {
    const configured: string[] = [];
    await reapplyAgentTools(
      {
        converse: {
          open: () => Effect.succeed({}),
          conversationIdOf: (key: string) => Effect.succeed(`cid-${key}`) as never,
          configure: (_chat: unknown, selection: { tools: unknown }) => {
            configured.push(
              ((selection.tools as { name: string }[] | null) ?? [])
                .map((tool) => tool.name)
                .join(","),
            );
            return Effect.succeed(undefined) as never;
          },
        } as never,
        listSessions: async () =>
          [
            { profile: "p1", owner: "o", id: "s1" },
            { profile: "p2", owner: "o", id: "s2" },
          ] as never,
        keyOfRow: async (row: { id: string }) => row.id,
        taskConversations: async () => ["task-c"],
      },
      { id: "p1", owner: "o" } as never,
      [{ name: "bash" }] as never,
    );
    expect(configured).toEqual(["bash", "bash"]);
  });
});

describe("the switch on a real mind (yolo cannot bypass)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "spriessen-host-switch-"));
  process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
  process.env["BOT_FILES_DIR"] = join(scratch, "bot-files");
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const setup = async (allowed: boolean, mode: "manual" | "yolo") => {
    const { openMind } = await import("../entity.ts");
    const handle = await openMind({
      storage: new MemoryStorage(),
      authz: { hostAccess: async () => allowed },
    });
    const { profiles, org, converse } = handle.mind;
    await org.ensureOrg("owner-a", "Org A", true);
    await settle(); // the watch re-reads the org on the create commit
    const bot = await profiles.create("owner-a", { name: "Kestrel", onboard: false });
    await profiles.update("owner-a", bot.id, {
      hostAccess: true,
      policies: { ...bot.policies, approvalMode: mode },
    });
    const chat = await profiles.ensureMain("owner-a", bot.id);
    const row = await profiles.rowOf(chat.id);
    const key = row !== undefined ? await profiles.keyOfRow(row) : "";
    const conversationId = String(await Effect.runPromise(converse.conversationIdOf(key as never)));
    return { handle, bot, conversationId };
  };

  const callBash = async (
    handle: Awaited<ReturnType<typeof setup>>["handle"],
    cid: string,
    input: Record<string, unknown> = { script: "echo hi", target: "host" },
  ) => {
    const tool = handle.mind.act.extension().tools?.find((entry) => entry.name === "bash") as
      | {
          execute: (
            a: never,
            b: never,
            c: never,
          ) => Promise<{ isError?: boolean; output: { text: string }[] }>;
        }
      | undefined;
    if (tool === undefined) throw new Error("bash is not registered");
    return (await tool.execute(
      input as never,
      { conversationId: cid, callId: "h1" } as never,
      {} as never,
    )) as { isError?: boolean; output: { text: string }[] };
  };

  it("a false switch refuses bash beyond the VM in yolo mode, before any card", async () => {
    const { handle, conversationId } = await setup(false, "yolo");
    for (const target of ["host", "node"]) {
      const result = await callBash(handle, conversationId, { script: "echo hi", target });
      expect(result.isError, target).toBe(true);
      expect(result.output[0]?.text).toContain("does not have access to this computer");
    }
    expect(handle.mind.approvals.pendingFor(conversationId)).toEqual([]);
    await handle.close();
  });

  it("a false switch leaves the vm target alone: the call takes the normal approval path", async () => {
    const { handle, conversationId } = await setup(false, "manual");
    const run = callBash(handle, conversationId, { script: "echo hi" });
    let parked = false;
    for (let i = 0; i < 200 && !parked; i += 1) {
      parked = handle.mind.approvals.pendingFor(conversationId).length > 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Parked on the broker, NOT refused by the switch guard.
    expect(parked).toBe(true);
    handle.mind.approvals.decide(conversationId, "h1", false);
    await run;
    await handle.close();
  });

  it("with every level on, the call passes the switch into the approval path", async () => {
    const { handle, conversationId } = await setup(true, "manual");
    const run = callBash(handle, conversationId);
    let parked = false;
    for (let i = 0; i < 200 && !parked; i += 1) {
      parked = handle.mind.approvals.pendingFor(conversationId).length > 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(parked).toBe(true);
    handle.mind.approvals.decide(conversationId, "h1", false);
    await run;
    await handle.close();
  });

  it("the merged bash tool stays listed while the switch is off, and no exclusion appears with it on", async () => {
    const { handle, bot } = await setup(false, "manual");
    const names = (agent: AgentChange) => {
      const list = agent.tools as { remove: readonly { name: string }[] } | null;
      return list === null ? [] : list.remove.map((tool) => tool.name);
    };
    const removed = names(handle.mind.profiles.agentFor({ ...bot } as never));
    // bash never leaves the list: its vm target is ordinary sandboxed work.
    expect(removed).not.toContain("bash");
    expect(removed).not.toContain("message");
    await handle.mind.profiles.update("owner-a", bot.id, { hostAccess: true });
    // With the switch on the list is dynamic again: no exclusion, no frozen set.
    const on = handle.mind.profiles.agentFor({ ...bot, hostAccess: true } as never);
    expect(on.tools).toBeNull();
    await handle.close();
  });
});
