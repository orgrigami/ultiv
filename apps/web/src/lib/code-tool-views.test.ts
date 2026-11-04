import { describe, expect, it } from "vite-plus/test";
import { presentationOf } from "./tool-text.ts";

const step = (name: string, input: unknown, output: string | null = null) => ({
  callId: "c1",
  name,
  status: "done" as const,
  input,
  output,
  durationMs: 5,
});

const viewOf = (s: ReturnType<typeof step>) => {
  const shown = presentationOf(s);
  if (shown.kind !== "human") throw new Error("hidden");
  return shown.view;
};

describe("code tools in owner words", () => {
  it("words code_nav by its action and keeps the result's shape", () => {
    const view = viewOf(
      step("code_nav", { action: "references", name: "greet" }, "src/a.ts:3  greet()"),
    );
    expect(view.done).toBe("Found where “greet” is used");
    expect(view.family).toBe("code");
    expect(view.structured).toEqual({ t: "output", text: "src/a.ts:3  greet()" });
    expect(viewOf(step("code_nav", { action: "definitions", name: "greet" })).done).toBe(
      "Found where “greet” is defined",
    );
  });

  it("names the folder an outline or a find covered", () => {
    expect(viewOf(step("code_outline", { path: "src" })).detail).toBe("src");
    const find = viewOf(step("file_find", '{"pattern":"*.py"}'));
    expect(find).toMatchObject({ done: "Found files by name", detail: "*.py", family: "artifact" });
    expect(find.structured).toMatchObject({ t: "record" });
  });

  it("says when it failed", () => {
    const failed = presentationOf({ ...step("code_outline", {}), status: "error" });
    expect(failed.kind === "human" && failed.view.done).toBe("Couldn't outline it");
  });
});
