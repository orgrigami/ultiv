/**
 * The chat draws a task where it was started: "Started a task" carries the
 * task id, and the line under it shows the task's state from the chat's one
 * task list, in the same words as every other task row.
 */
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRow, ToolStep } from "@spriessen/contracts";
import { LiveTask } from "./live-task.tsx";
import { ChatTasksProvider } from "../lib/chat-tasks.tsx";
import { presentationOf } from "../lib/tool-text.ts";

const ID = "0f6b1c2e-1111-4222-8333-944445555666";

const step = (over: Partial<ToolStep>): ToolStep => ({
  callId: "c1",
  name: "task_spawn",
  status: "done",
  input: { prompt: "Research Zyn", title: "Zyn research brief" },
  output: `task ${ID} running. End your turn now; you will be woken with the result.`,
  durationMs: 20,
  ...over,
});

const task = (over: Partial<TaskRow>): TaskRow => ({
  id: ID,
  sessionId: "",
  owner: "agent",
  conversationId: "chat",
  prompt: "Research Zyn",
  status: "running",
  result: null,
  error: null,
  createdAt: Date.now() - 5_000,
  finishedAt: null,
  ...over,
});

const viewOf = (over: Partial<ToolStep>) => {
  const presented = presentationOf(step(over));
  if (presented.kind !== "human") throw new Error("hidden");
  return presented.view;
};

describe("a task in the chat", () => {
  it("names the task a spawn started, from details or the reply line", () => {
    expect(viewOf({}).task).toEqual({ id: ID });
    expect(viewOf({ details: { id: "abc12345", status: "queued" } })).toMatchObject({
      done: "Queued a task",
      task: { id: "abc12345" },
    });
    expect(viewOf({ status: "running", output: null }).task).toBeUndefined();
  });

  it("says when a message continued a finished task", () => {
    const view = viewOf({
      name: "task_message",
      input: { id: ID, text: "now in a table" },
      details: { id: ID, outcome: "continued" },
    });
    expect(view.done).toBe("Continued a task");
    expect(view.task).toEqual({ id: ID });
  });

  it("draws the task's live line from the chat's task list", () => {
    const render = (tasks: TaskRow[]) =>
      renderToStaticMarkup(
        <ChatTasksProvider value={{ tasks, refresh: async () => undefined }}>
          <LiveTask id={ID} />
        </ChatTasksProvider>,
      );
    expect(render([task({ lastStep: "Searching the web" })])).toContain("Searching the web");
    expect(render([task({ status: "queued" })])).toContain("Queued · waits for a free slot");
    expect(render([task({ status: "done", finishedAt: Date.now() })])).toContain("Done");
    expect(render([])).toBe("");
  });
});
