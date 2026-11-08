/**
 * Background work on its own model: the resolution order (spawn argument,
 * the bot's backgroundModel, SPRIESSEN_BACKGROUND_MODEL, else the bot's
 * own), a task's conversation configured on that model, and a "note" report
 * that lands in the parent chat for the model to read without starting a
 * turn there.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { defaultPolicies } from "../profiles/docs.ts";
import { openMind } from "../entity.ts";
import { projectTranscript } from "../converse/steps.ts";
import { backgroundModelFor } from "./model.ts";
import { taskConversationKey } from "./tasks.ts";
import { TASK_REPORT_KIND } from "./wake.ts";
import type { ProfileInfo } from "@spriessen/contracts";
import { readView, TRANSCRIPT_WINDOW } from "../converse/view.ts";

const bot = (backgroundModel: { id: string; effort: string } | null): ProfileInfo => ({
  id: "p1",
  owner: "owner",
  name: "Scout",
  description: "",
  persona: "",
  timezone: "Asia/Jakarta",
  model: null,
  toolAllowlist: null,
  policies: { ...defaultPolicies(), backgroundModel },
  createdAt: 0,
  archivedAt: null,
});

const catalog = new Set(["kenari/small", "kenari/big", "openai/mini"]);
const knows = (ref: string) => catalog.has(ref);
const env = { SPRIESSEN_BACKGROUND_MODEL: "openai/mini", SPRIESSEN_BACKGROUND_EFFORT: "low" };

describe("backgroundModelFor", () => {
  it("prefers the spawn's own model, then the bot's, then the environment", () => {
    const stored = bot({ id: "kenari/small", effort: "" });
    expect(backgroundModelFor(stored, { model: "kenari/big", effort: "high" }, knows, env)).toEqual(
      { ok: true, model: { id: "kenari/big", effort: "high" } },
    );
    expect(backgroundModelFor(stored, {}, knows, env)).toEqual({
      ok: true,
      model: { id: "kenari/small", effort: "" },
    });
    expect(backgroundModelFor(bot(null), {}, knows, env)).toEqual({
      ok: true,
      model: { id: "openai/mini", effort: "low" },
    });
  });

  it("keeps the bot's chat model when nothing is set", () => {
    expect(backgroundModelFor(bot(null), {}, knows, {})).toEqual({ ok: true, model: undefined });
  });

  it("refuses an unknown spawn model, but skips an unknown stored one", () => {
    const refused = backgroundModelFor(bot(null), { model: "nope/x" }, knows, env);
    expect(refused.ok).toBe(false);
    const skipped = backgroundModelFor(bot({ id: "gone/old", effort: "" }), {}, knows, env);
    expect(skipped).toEqual({ ok: true, model: { id: "openai/mini", effort: "low" } });
  });
});

describe("background tasks (offline, MemoryStorage)", () => {
  it("runs on its own model and reports into the parent as a note, without a turn", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, tasks } = handle.mind;
    const parent = await Effect.runPromise(converse.ensure("parent"));
    const task = await Effect.runPromise(
      tasks.spawn({
        sessionId: "s",
        owner: "agent",
        conversationId: String(parent.id),
        prompt: "check the feeds",
        model: { id: "openai/mini", effort: "" },
        report: "note",
      }),
    );
    expect(task.model).toBe("openai/mini");
    expect(task.report).toBe("note");
    const taskChat = await Effect.runPromise(converse.ensure(taskConversationKey(task.id)));
    const agent = await Effect.runPromise(converse.agentOf(taskChat));
    expect(agent.model).toBe("openai/mini");
    // Offline the task fails; the report still lands, as a note entry.
    let entries: readonly { kind: string }[] = [];
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const state = await readView(parent, TRANSCRIPT_WINDOW);
      entries = (state.entries ?? []) as readonly { kind: string }[];
      if (entries.some((entry) => entry.kind === TASK_REPORT_KIND)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(entries.map((entry) => entry.kind)).toEqual([TASK_REPORT_KIND]);
    const steps = projectTranscript(entries as never, undefined, false);
    expect(steps[0]?.kind).toBe("input");
    expect(steps[0]?.kind === "input" ? steps[0].text : "").toContain(`[task ${task.id} failed]`);
    const live = await Effect.runPromise(converse.liveOf(parent));
    expect(live?.run).toBeUndefined();
    const row = await Effect.runPromise(tasks.get(task.id));
    expect(row?.notified).toBe(true);
    await handle.close();
  });
});
