/**
 * Projects on a real offline mind: a bot starts one through the `project`
 * tool, moves it along by #handle (ticks, adds, notes, status), its open
 * projects render in the prompt section, the owner's changes land in the log
 * as theirs, and every read is per owner and bot.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { PROJECT_LIMITS } from "@spriessen/contracts";
import { openMind } from "../entity.ts";
import { changeProject, resolveProject, startProject } from "./rules.ts";
import { openProjectsSection, projectTools } from "./tools.ts";

const OWNER = "owner";

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles, projects } = handle.mind;
  const bot = await profiles.create(OWNER, { name: "Planner", onboard: false });
  const main = await profiles.ensureMain(OWNER, bot.id);
  const key = await profiles.keyForSession(OWNER, main.id);
  const conversationId = String((await Effect.runPromise(converse.ensure(key))).id);
  const [tool] = projectTools(projects, profiles, undefined);
  if (tool === undefined) throw new Error("no project tool");
  const call = async (args: object) =>
    (await tool.execute(args as never, { conversationId } as never, {} as never)) as {
      output: { text: string }[];
      isError?: boolean;
    };
  const section = openProjectsSection(projects, profiles);
  const prompt = async () => section.render({ conversationId } as never, {} as never);
  return { handle, projects, bot, call, prompt };
};

describe("projects", () => {
  it("a bot starts a project and moves it along by #handle", async () => {
    const { handle, projects, bot, call, prompt } = await setup();
    expect(await prompt()).toBeUndefined();
    const started = await call({
      action: "start",
      title: "Move house",
      goal: "Living in the new flat by March",
      milestones: ["Find a mover", "Pack", "Change address"],
    });
    expect(started.isError).toBeUndefined();
    const [project] = await projects.list(OWNER, bot.id);
    const ref = project?.id.slice(0, 6) ?? "";
    expect(started.output[0]?.text).toContain(`#${project?.id.slice(0, 8)} Move house [active]`);
    expect(await prompt()).toContain("Move house: 0/3 milestones; next: Find a mover");
    const updated = await call({
      action: "update",
      id: `#${ref}`,
      done: [1],
      note: "Booked Movers & Co",
      add: ["Return keys"],
    });
    expect(updated.output[0]?.text).toContain("1. [x] Find a mover");
    expect(updated.output[0]?.text).toContain("4. [ ] Return keys");
    expect(await prompt()).toContain("1/4 milestones; next: Pack");
    const bad = await call({ action: "update", id: ref, done: [9] });
    expect(bad.isError).toBe(true);
    await call({ action: "update", id: ref, status: "done" });
    expect(await prompt()).toBeUndefined();
    expect((await call({ action: "list" })).output[0]?.text).toContain("(done)");
    await handle.close();
  });

  it("owner changes log as the owner's and stay per owner", async () => {
    const { handle, projects, bot } = await setup();
    const outcome = await projects.start(OWNER, bot.id, { title: "Taxes", milestones: ["Gather"] });
    if (!outcome.ok) throw new Error(outcome.error);
    const id = outcome.project.id;
    expect(
      await projects.change("someone-else", id, { status: "paused" }, "owner"),
    ).toBeUndefined();
    const paused = await projects.change(
      OWNER,
      id,
      { status: "paused", note: "after the trip" },
      "owner",
    );
    expect(paused?.ok && paused.project.log.at(-1)).toMatchObject({
      by: "owner",
      text: "after the trip",
    });
    expect(await projects.list("someone-else")).toEqual([]);
    expect(await projects.remove("someone-else", id)).toBe(false);
    expect(await projects.remove(OWNER, id)).toBe(true);
    await handle.close();
  });
});

describe("project rules", () => {
  const base = { id: "abcdef12-0000", owner: "o", profileId: "p", now: 1 };

  it("refuses a nameless project and a bot over its open cap", () => {
    expect(startProject({ title: " " }, base, 0)).toEqual({
      ok: false,
      error: "a project needs a title",
    });
    expect(startProject({ title: "x" }, base, PROJECT_LIMITS.open).ok).toBe(false);
  });

  it("resolves handles and unticks milestones", () => {
    const started = startProject({ title: "x", milestones: ["a"] }, base, 0);
    if (!started.ok) throw new Error(started.error);
    expect(resolveProject([started.project], "#abcd")).toBe(started.project);
    expect(resolveProject([started.project], "ab")).toMatch(/at least 4/);
    expect(resolveProject([started.project], "ffff")).toBe("no project #ffff");
    const ticked = changeProject(started.project, { done: [1] }, "bot", 2);
    if (!ticked.ok) throw new Error(ticked.error);
    expect(ticked.project.milestones[0]).toEqual({ text: "a", done: true, doneAt: 2 });
    const unticked = changeProject(ticked.project, { undone: [1] }, "owner", 3);
    expect(unticked.ok && unticked.project.milestones[0]?.done).toBe(false);
  });
});
