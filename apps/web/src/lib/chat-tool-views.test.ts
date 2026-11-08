/**
 * The plan and diagram cards read the arguments the tools really take: both
 * tools use the schemas in `@spriessen/contracts`, so these tests pin those
 * schemas' property names, check each tool is built on them, and check the
 * cards against calls in that shape.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  CHECKLIST_TOOL,
  ChecklistParamsSchema,
  GRAPH_MAX_SOURCE,
  GRAPH_TOOL,
  GraphParamsSchema,
  type ToolStep,
} from "@spriessen/contracts";
import { checklistOf, latestPlans } from "./chat-tool-views.ts";
import { diagramErrorText, drawDiagram } from "./diagram.ts";
import { presentationOf } from "./tool-text.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageSource = (path: string): string =>
  readFileSync(join(here, "../../../../packages", path), "utf8");

const step = (over: Partial<ToolStep>): ToolStep => ({
  callId: "c1",
  name: CHECKLIST_TOOL,
  status: "done",
  input: {},
  output: null,
  durationMs: 40,
  ...over,
});

const viewOf = (over: Partial<ToolStep>) => {
  const presented = presentationOf(step(over));
  if (presented.kind !== "human") throw new Error("hidden");
  return presented.view;
};

const plan = (listId: string, statuses: string[]) => ({
  listId,
  title: "Release",
  items: statuses.map((status, index) => ({ text: `Step ${index + 1}`, status })),
});

/** The property names of an object schema (pi-schema types `properties` as unknown). */
const propertiesOf = (schema: object): object => (schema as { properties: object }).properties;

describe("the arguments the plan and diagram tools take", () => {
  it("are the contracts schemas, and both tools are built on them", () => {
    expect(Object.keys(propertiesOf(ChecklistParamsSchema)).sort()).toEqual([
      "items",
      "title",
      "update",
    ]);
    expect(Object.keys(propertiesOf(GraphParamsSchema)).sort()).toEqual(["source", "title"]);
    expect(packageSource("mind/src/checklist/tools.ts")).toMatch(
      /name: CHECKLIST_TOOL,[\s\S]*parameters: ChecklistParamsSchema/,
    );
    expect(packageSource("ext/src/plugins/graph.ts")).toMatch(
      /name: GRAPH_TOOL,[\s\S]*parameters: GraphParamsSchema/,
    );
  });
});

describe("the plan card", () => {
  it("shows the list the tool settled on", () => {
    const details = plan("p1", ["done", "in_progress", "pending"]);
    const view = viewOf({ input: { items: details.items }, details });
    expect(view.checklist).toEqual(details);
    expect(view.done).toBe("Updated the plan");
  });

  it("is a plain line while running or after a refusal", () => {
    const running = viewOf({ status: "running", input: { items: [] }, details: undefined });
    expect(running.live).toBe("Making a plan…");
    expect(running.checklist).toBeUndefined();
    const updating = viewOf({
      status: "running",
      input: { update: [{ item: 1, status: "done" }] },
    });
    expect(updating.live).toBe("Updating the plan…");
    const refused = viewOf({ status: "error", output: "checklist not changed: no list yet" });
    expect(refused.done).toBe("Plan not changed");
    expect(refused.checklist).toBeUndefined();
  });

  it("refuses details in the wrong shape", () => {
    expect(checklistOf({ listId: "p1", items: [{ text: "a", status: "maybe" }] })).toBeNull();
    expect(checklistOf({ listId: "p1", items: [] })).toBeNull();
    expect(checklistOf({ items: [{ text: "a", status: "done" }] })).toBeNull();
  });

  it("keeps one card per plan, at its latest update", () => {
    const tool = (id: number, details: unknown, name = CHECKLIST_TOOL) => ({
      kind: "tool",
      id,
      step: step({ callId: `c${id}`, name, details }),
    });
    const transcript = [
      tool(1, plan("p1", ["in_progress", "pending"])),
      { kind: "output", id: 2 },
      tool(3, plan("p1", ["done", "in_progress"])),
      tool(4, plan("p2", ["in_progress"])),
      tool(5, undefined, "bash"),
    ];
    expect(latestPlans(transcript).map((entry) => entry.id)).toEqual([2, 3, 4, 5]);
  });
});

describe("the diagram card", () => {
  const source = "flowchart TD\n  A --> B";

  it("draws the source the call was given, with its title", () => {
    const view = viewOf({ name: GRAPH_TOOL, input: { source, title: "Flow" } });
    expect(view.diagram).toEqual({ source, title: "Flow" });
    expect(view.detail).toBe("Flow");
  });

  it("draws nothing for a refused call or while running", () => {
    expect(
      viewOf({ name: GRAPH_TOOL, status: "error", input: { source } }).diagram,
    ).toBeUndefined();
    const running = viewOf({ name: GRAPH_TOOL, status: "running", input: { source } });
    expect(running.diagram).toBeUndefined();
    expect(running.live).toBe("Drawing a diagram…");
  });

  it("draws in the browser path, and says why when it can't", async () => {
    const drawn = await drawDiagram(source, "t1-");
    expect(drawn).toMatchObject({ ok: true, type: "flowchart" });
    const broken = await drawDiagram("flowchart TD\n  A[Start --> B", "t2-");
    expect(broken).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Syntax error at line 2/),
    });
    expect(await drawDiagram("napkin\n  A", "t3-")).toEqual({
      ok: false,
      message: "Not a diagram type this app draws.",
    });
    expect(await drawDiagram("x".repeat(GRAPH_MAX_SOURCE + 1), "t4-")).toEqual({
      ok: false,
      message: "Too large to draw.",
    });
    expect(diagramErrorText(new Error("boom"))).toBe("boom");
  });
});
