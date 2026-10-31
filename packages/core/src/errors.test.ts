import { describe, expect, it } from "vite-plus/test";
import { External, NotFound } from "./errors.ts";

describe("core errors", () => {
  it("carry stable spriessen tags", () => {
    expect(new NotFound({ what: "widget" })._tag).toBe("spriessen/NotFound");
    const cause = new Error("boom");
    const failure = new External({ op: "fetch", cause });
    expect(failure._tag).toBe("spriessen/External");
    expect(failure.cause).toBe(cause);
  });
});
