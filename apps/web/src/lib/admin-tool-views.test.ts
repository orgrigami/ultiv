import { describe, expect, it } from "vite-plus/test";
import type { ToolStep } from "@spriessen/contracts";
import { ADMIN_APPROVALS, adminFields, adminView, isAdminTool } from "./admin-tool-views.ts";

const step = (name: string, input: unknown, status: ToolStep["status"] = "done"): ToolStep =>
  ({ id: "call-1", name, input, status, output: "ok" }) as unknown as ToolStep;

describe("admin tool views", () => {
  it("names the admin tools and only them", () => {
    expect(isAdminTool("bot_move")).toBe(true);
    expect(isAdminTool("team_create")).toBe(true);
    expect(isAdminTool("bots_list")).toBe(false);
  });

  it("reads a move as who → where, the org in words", () => {
    const view = adminView(step("bot_move", { bot: "Wren", to: "org" }));
    expect(view?.done).toBe("Moved a bot");
    expect(view?.detail).toBe("Wren → the org");
  });

  it("says resumed when pause is false, and failed on an error", () => {
    expect(adminView(step("bot_pause", { bot: "Wren", paused: false }))?.done).toBe(
      "Resumed a bot",
    );
    expect(adminView(step("bot_delete", { bot: "Wren" }, "error"))?.done).toBe(
      "Didn't remove the bot",
    );
  });

  it("labels the arguments in a fixed order", () => {
    const fields = adminFields({ memoryMiB: 2048, name: "Research", cpus: 2, tools: ["a", "b"] });
    expect(fields.map((field) => field.k)).toEqual(["Name", "Tools", "CPUs", "Memory (MiB)"]);
    expect(fields.find((field) => field.k === "Tools")?.v).toBe("a, b");
  });

  it("returns null for other tools and words the destructive ones", () => {
    expect(adminView(step("web_search", { query: "x" }))).toBeNull();
    expect(ADMIN_APPROVALS["bot_delete"]?.risky).toBe(true);
    expect(ADMIN_APPROVALS["team_delete"]?.risky).toBe(true);
  });
});
