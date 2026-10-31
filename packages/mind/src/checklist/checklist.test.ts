import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CHECKLIST_MAX_ITEMS, type ChecklistDetails } from "@spriessen/contracts";
import { openMind } from "../entity.ts";
import type { AuditService } from "../audit/audit.ts";
import { applyChecklist, checklistText } from "./checklist.ts";
import { ChecklistDoc, checklistTools } from "./tools.ts";

let ids = 0;
const newId = () => `list-${++ids}`;
const plan = (current?: ChecklistDetails) =>
  applyChecklist(
    current,
    {
      items: [
        { text: "Read the brief", status: "in_progress" },
        { text: "Draft", status: "pending" },
        { text: "Check", status: "pending" },
      ],
      title: "Report",
    },
    newId,
  );
const listOf = (applied: ReturnType<typeof applyChecklist>): ChecklistDetails => {
  if (!applied.ok) throw new Error(applied.error);
  return applied.list;
};

describe("checklist rules", () => {
  it("starts a list, ticks items off by number and keeps the same card", () => {
    const first = listOf(plan());
    const next = listOf(
      applyChecklist(
        first,
        {
          update: [
            { item: 1, status: "done" },
            { item: 2, status: "in_progress" },
          ],
        },
        newId,
      ),
    );
    expect(next.listId).toBe(first.listId);
    expect(next.title).toBe("Report");
    expect(next.items.map((item) => item.status)).toEqual(["done", "in_progress", "pending"]);
    expect(checklistText(next)).toContain('"Report" 1/3 done');
    expect(checklistText(next)).toContain("2. [>] Draft (in progress)");
  });

  it("re-planning an unfinished list keeps its card; a list after a finished one is new", () => {
    const first = listOf(plan());
    expect(listOf(plan(first)).listId).toBe(first.listId);
    const finished = {
      ...first,
      items: first.items.map((item) => ({ ...item, status: "done" as const })),
    };
    expect(listOf(plan(finished)).listId).not.toBe(first.listId);
  });

  it("refuses two items in progress, unknown items, both modes and an empty start", () => {
    const first = listOf(plan());
    const two = applyChecklist(first, { update: [{ item: 2, status: "in_progress" }] }, newId);
    expect(two).toEqual({ ok: false, error: expect.stringContaining("only one item") });
    const missing = applyChecklist(first, { update: [{ item: 9, status: "done" }] }, newId);
    expect(missing).toEqual({ ok: false, error: expect.stringContaining("no item 9") });
    const both = applyChecklist(first, { items: first.items, update: [{ item: 1 }] }, newId);
    expect(both.ok).toBe(false);
    const none = applyChecklist(undefined, { update: [{ item: 1, status: "done" }] }, newId);
    expect(none).toEqual({ ok: false, error: expect.stringContaining("no checklist yet") });
  });

  it("caps the item count and text length", () => {
    const many = Array.from({ length: CHECKLIST_MAX_ITEMS + 1 }, (_, index) => ({
      text: `step ${index}`,
      status: "pending" as const,
    }));
    expect(applyChecklist(undefined, { items: many }, newId).ok).toBe(false);
    const long = [{ text: "x".repeat(500), status: "pending" as const }];
    expect(applyChecklist(undefined, { items: long }, newId)).toEqual({
      ok: false,
      error: expect.stringContaining("longer than"),
    });
  });
});

describe("checklist tool (offline, MemoryStorage)", () => {
  it("keeps the list durably per conversation and reports it in details", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles } = handle.mind;
    const bot = await profiles.create("owner", { name: "Planner", onboard: false });
    const main = await profiles.ensureMain("owner", bot.id);
    const key = await profiles.keyForSession("owner", main.id);
    const conversationId = String((await Effect.runPromise(converse.ensure(key))).id);
    const audit = { record: () => undefined } as unknown as AuditService;
    const [tool] = checklistTools({ converse, profiles, audit });
    if (tool === undefined) throw new Error("missing checklist tool");
    const call = (args: object, id = conversationId) =>
      tool.execute(
        args as never,
        { conversationId: id, callId: "k" } as never,
        {} as never,
      ) as unknown as Promise<{
        output: { text: string }[];
        isError?: boolean;
        details?: ChecklistDetails;
      }>;

    const started = await call({
      items: [
        { text: "One", status: "in_progress" },
        { text: "Two", status: "pending" },
      ],
    });
    expect(started.isError).toBeUndefined();
    const ticked = await call({ update: [{ item: 1, status: "done" }] });
    expect(ticked.details?.listId).toBe(started.details?.listId);
    expect(ticked.details?.items[0]?.status).toBe("done");
    const stored = await Effect.runPromise(
      converse.docs.snapshotKeyed(ChecklistDoc, conversationId),
    );
    expect(stored?.current?.items.map((item) => item.status)).toEqual(["done", "pending"]);

    const bad = await call({ update: [{ item: 5, status: "done" }] });
    expect(bad.isError).toBe(true);
    expect(bad.output[0]?.text).toContain("checklist not changed");
    const stranger = await call({ items: [{ text: "x", status: "pending" }] }, "not-a-bot-chat");
    expect(stranger.isError).toBe(true);
    await handle.close();
  });
});
