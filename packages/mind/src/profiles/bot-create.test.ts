/** `bot_create`'s card fields as a ProfileCreate; the tool itself runs in admin/admin-tools.test.ts. */
import { describe, expect, it } from "vite-plus/test";
import { createInputOf } from "./bot-create.ts";

describe("createInputOf", () => {
  it("maps the card fields onto ProfileCreate; empty means default", () => {
    expect(createInputOf({ name: " Robinson " })).toEqual({ name: " Robinson " });
    expect(
      createInputOf({
        name: "R",
        title: " Helper ",
        persona: " be kind ",
        model: "kenari/x",
        effort: "high",
        sandbox: false,
      }),
    ).toEqual({
      name: "R",
      description: "Helper",
      persona: "be kind",
      model: { id: "kenari/x", effort: "high" },
      policies: expect.objectContaining({ sandbox: false }),
    });
  });

  it("keeps tool names and refuses an effort without a model", () => {
    expect(createInputOf({ name: "R", tools: [" web_search ", ""] }).toolAllowlist).toEqual([
      "web_search",
    ]);
    expect(() => createInputOf({ name: "R", effort: "high" })).toThrow();
  });
});
