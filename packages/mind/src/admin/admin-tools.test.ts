/**
 * The main bot's admin tools on a real (in-memory) mind: the one refusal for
 * every other bot, cards on update and delete, the home rules, audit rows,
 * and host-access switches the model can never set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { ADMIN_REFUSAL, adminTools, openMind, type MindAdmin } from "@spriessen/mind";
import type { ApprovalsService } from "../approvals.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-admin-"));
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["BOT_FILES_DIR"] = join(scratch, "bot-files");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A gate that approves and counts the cards it was asked to park. */
const gate = () => {
  const asked: string[] = [];
  const approvals = {
    request: (_c: string, _k: string, call: { name: string }) => {
      asked.push(call.name);
      return Effect.succeed(true);
    },
    noteFor: () => undefined,
    overrideFor: () => undefined,
  } as unknown as ApprovalsService;
  return { approvals, asked };
};

const setup = async (admin?: MindAdmin) => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { profiles, org, converse, audit } = handle.mind;
  await org.ensureOrg("owner-a", "Org A", true);
  const main = await profiles.create("owner-a", { name: "Kestrel", onboard: false });
  const other = await profiles.create("owner-a", { name: "Wren", onboard: false });
  const conversationOf = async (profileId: string): Promise<string> => {
    const chat = await profiles.ensureMain("owner-a", profileId);
    const row = await profiles.rowOf(chat.id);
    const key = row !== undefined ? await profiles.keyOfRow(row) : "";
    return String(await Effect.runPromise(converse.conversationIdOf(key as never)));
  };
  const { approvals, asked } = gate();
  const tools = adminTools({
    profiles,
    approvals,
    audit,
    converse,
    ...(admin !== undefined ? { admin } : {}),
  });
  const call = async (as: string, name: string, args: object) => {
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`missing ${name}`);
    const result = (await tool.execute(
      args as never,
      { conversationId: await conversationOf(as), callId: `k-${asked.length}-${name}` } as never,
      {} as never,
    )) as { output: { text: string }[]; isError?: boolean };
    return {
      text: result.output.map((part) => part.text).join(""),
      isError: result.isError === true,
    };
  };
  const permissionRows = () =>
    audit
      .tail(200)
      .filter((event) => event.kind === "permission")
      .map((event) => event.name);
  return { handle, main, other, call, asked, permissionRows };
};

describe("the admin tools", () => {
  it("give every other bot the same refusal, before any card", async () => {
    const { handle, other, call, asked } = await setup();
    const tries: [string, object][] = [
      ["bot_create", { name: "Finch" }],
      ["bot_details", { bot: "Kestrel" }],
      ["bot_update", { bot: "Kestrel", role: "x" }],
      ["bot_move", { bot: "Kestrel", to: "org" }],
      ["bot_pause", { bot: "Kestrel", paused: true }],
      ["bot_delete", { bot: "Kestrel" }],
      ["teams_list", {}],
      ["team_create", { name: "Team X" }],
      ["team_update", { team: "Team X", name: "Y" }],
      ["team_delete", { team: "Team X" }],
    ];
    for (const [name, args] of tries) {
      const reply = await call(other.id, name, args);
      expect(reply.text, name).toContain(ADMIN_REFUSAL);
    }
    expect(asked).toEqual([]);
    await handle.close();
  });

  it("a host app's can() answer is the one that counts", async () => {
    const { handle, main, call } = await setup({ mayAdminister: () => false });
    expect((await call(main.id, "teams_list", {})).text).toContain(ADMIN_REFUSAL);
    await handle.close();
  });

  it("creates a team and a bot in it; host access stays off", async () => {
    const { handle, main, call, asked, permissionRows } = await setup();
    const made = await call(main.id, "team_create", {
      name: "Team X",
      instructions: "Cite sources.",
      cpus: 2,
      hostAccess: true,
    });
    expect(made.text).toContain('created team "Team X"');
    const team = (await handle.mind.org.view()).teams[0];
    expect(team?.hostAccess).toBe(false);
    expect(team?.vm).toEqual({ cpus: 2, memoryMiB: 512 });
    const bot = await call(main.id, "bot_create", {
      name: "Finch",
      title: "Reads papers",
      team: "team x",
      instructions: "Summaries under 200 words.",
      tools: ["web_search"],
      hostAccess: true,
    });
    expect(bot.text).toContain('in team "Team X"');
    const row = (await handle.mind.profiles.list("owner-a")).find(
      (entry) => entry.name === "Finch",
    );
    expect(row?.teamId).toBe(team?.id);
    expect(row?.hostAccess).toBe(false);
    expect(row?.toolAllowlist).toEqual(["web_search"]);
    expect(row !== undefined && handle.mind.profiles.files?.read(row, "instructions").text).toBe(
      "Summaries under 200 words.",
    );
    // The fake gate approves everything, so creation consults it (the real
    // broker skips the card for the main bot — see the real-approvals test).
    expect(asked).toEqual(["team_create", "bot_create"]);
    const listed = await call(main.id, "teams_list", {});
    expect(listed.text).toContain('Team "Team X"');
    expect(listed.text).toContain("Finch");
    expect(listed.text).toContain("Kestrel (main)");
    expect(permissionRows()).toContain("team-created");
    await handle.close();
  });

  it("refuses an unknown team before the card, naming the real ones", async () => {
    const { handle, main, call, asked } = await setup();
    await call(main.id, "team_create", { name: "Team X" });
    const reply = await call(main.id, "bot_create", { name: "Stray", team: "Nowhere" });
    expect(reply.text).toContain('no team "Nowhere"');
    expect(reply.text).toContain('"Team X"');
    // The stray bot_create was refused by its guard before any card; the
    // team_create before it consulted the gate (the fake approves all).
    expect(asked).toEqual(["team_create"]);
    await handle.close();
  });

  it("moves, pauses and resumes another bot; the main bot stays put", async () => {
    const { handle, main, other, call, permissionRows } = await setup();
    await call(main.id, "team_create", { name: "Team X" });
    expect((await call(main.id, "bot_move", { bot: "Kestrel", to: "Team X" })).text).toContain(
      "main bot lives in the org",
    );
    expect((await call(main.id, "bot_move", { bot: "Wren", to: "Team X" })).text).toContain(
      'moved "Wren" to team "Team X"',
    );
    expect((await call(main.id, "bot_pause", { bot: "Kestrel", paused: true })).isError).toBe(true);
    await call(main.id, "bot_pause", { bot: "Wren", paused: true });
    expect((await handle.mind.profiles.get("owner-a", other.id))?.archivedAt).not.toBeNull();
    await call(main.id, "bot_pause", { bot: "Wren", paused: false });
    expect((await handle.mind.profiles.get("owner-a", other.id))?.archivedAt).toBeNull();
    expect(permissionRows()).toEqual(
      expect.arrayContaining(["bot-moved", "bot-paused", "bot-resumed"]),
    );
    await handle.close();
  });

  it("updates through a card and never touches a switch", async () => {
    const { handle, main, other, call, asked } = await setup();
    const before = (await handle.mind.profiles.get("owner-a", other.id))?.hostAccess;
    const reply = await call(main.id, "bot_update", {
      bot: "Wren",
      role: "Keeps the books",
      instructions: "Round to cents.",
      tools: "all",
      hostAccess: !before,
      teamId: "team-x",
    });
    expect(reply.text).toContain('updated bot "Wren"');
    const row = await handle.mind.profiles.get("owner-a", other.id);
    expect(row?.description).toBe("Keeps the books");
    expect(row?.hostAccess).toBe(before);
    expect(row?.teamId ?? null).toBeNull();
    expect(asked).toEqual(["bot_update"]);
    const details = await call(main.id, "bot_details", { bot: "Wren" });
    expect(details.text).toContain("Instructions: Round to cents.");
    expect(details.text).toContain("(the owner's to change)");
    await handle.close();
  });

  it("deletes through a card; the main bot and a team with bots are refused first", async () => {
    const purged: string[] = [];
    const { handle, main, other, call, asked } = await setup({
      purgeBot: async (owner, id) => {
        purged.push(id);
        return handle.mind.profiles.remove(owner, id);
      },
    });
    expect((await call(main.id, "bot_delete", { bot: "Kestrel" })).text).toContain(
      "main bot cannot be removed",
    );
    await call(main.id, "team_create", { name: "Team X" });
    await call(main.id, "bot_move", { bot: "Wren", to: "Team X" });
    const warn = await call(main.id, "team_delete", { team: "Team X" });
    expect(warn.text).toContain("still has 1 bot(s): Wren");
    expect(warn.text).toContain('bot_move with to "org"');
    expect(asked).toEqual(["team_create"]);
    expect((await call(main.id, "bot_delete", { bot: "Wren" })).text).toContain(
      'deleted bot "Wren"',
    );
    expect(purged).toEqual([other.id]);
    expect((await call(main.id, "team_delete", { team: "Team X" })).text).toContain(
      'deleted team "Team X"',
    );
    expect(asked).toEqual(["team_create", "bot_delete", "team_delete"]);
    await handle.close();
  });

  it("lets scripts call the read-only discovery tools, never the mutating ones", async () => {
    // No `callers` field = callable by model AND scripts (codemode). The
    // mutating admin tools stay model-direct: a restart mid-script abandons
    // an unfinished mutation, so org changes never batch inside a script.
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles, org, converse, audit } = handle.mind;
    await org.ensureOrg("owner-a", "Org A", true);
    const scriptCallable = (
      name: string,
      tools: readonly { name?: string; callers?: readonly string[] }[],
    ) => {
      const tool = tools.find((entry) => entry.name === name);
      if (tool === undefined) throw new Error(`missing ${name}`);
      return tool.callers === undefined || tool.callers.includes("tools");
    };
    const tools = adminTools({ profiles, approvals: gate().approvals, audit, converse });
    for (const name of ["bot_details", "teams_list"]) {
      expect(scriptCallable(name, tools)).toBe(true);
    }
    for (const name of [
      "bot_create",
      "bot_update",
      "bot_move",
      "bot_pause",
      "bot_delete",
      "team_create",
      "team_update",
      "team_delete",
    ]) {
      expect(scriptCallable(name, tools)).toBe(false);
    }
    await handle.close();
  });

  it("the real broker: the main bot creates without a card, the audit carries the skip, updates still park", async () => {
    // The mind's own approvals (hooks wired with the profiles index), not the
    // fake gate: this is the whole path a live bot_create rides.
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles, org, converse, audit, approvals } = handle.mind;
    await org.ensureOrg("owner-a", "Org A", true);
    const main = await profiles.create("owner-a", { name: "Kestrel", onboard: false });
    const chat = await profiles.ensureMain("owner-a", main.id);
    const row = await profiles.rowOf(chat.id);
    const key = row !== undefined ? await profiles.keyOfRow(row) : "";
    const conversationId = String(await Effect.runPromise(converse.conversationIdOf(key as never)));
    const tools = adminTools({ profiles, approvals, audit, converse });
    const call = async (name: string, args: object, callId: string) => {
      const tool = tools.find((entry) => entry.name === name);
      if (tool === undefined) throw new Error(`missing ${name}`);
      const result = (await tool.execute(
        args as never,
        { conversationId, callId } as never,
        {} as never,
      )) as { output: { text: string }[]; isError?: boolean };
      return result.output.map((part) => part.text).join("");
    };

    // The main bot creates directly: no card parks, the audit says why.
    expect(await call("team_create", { name: "Team X" }, "skip-1")).toContain(
      'created team "Team X"',
    );
    expect(approvals.pendingFor(conversationId)).toEqual([]);
    const skip = audit
      .tail(200)
      .find((event) => event.kind === "approval" && event.callId === "skip-1");
    expect(skip?.ok).toBe(true);
    expect(skip?.name).toBe("team_create");
    expect(skip?.error).toContain("main bot");

    // bot_update keeps `owner: true`: the same main actor still parks a card.
    await profiles.create("owner-a", { name: "Wren", onboard: false });
    const parked = call("bot_update", { bot: "Wren", role: "x" }, "park-1");
    await expect
      .poll(() => approvals.pendingFor(conversationId).map((entry) => entry.name), {
        timeout: 2_000,
      })
      .toEqual(["bot_update"]);
    approvals.decide(conversationId, "park-1", true);
    await parked;
    expect(approvals.pendingFor(conversationId)).toEqual([]);
    await handle.close();
  });
});
