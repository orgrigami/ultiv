import { describe, expect, it } from "vite-plus/test";
import { External, NotFound } from "./errors.ts";

describe("core errors", () => {
  it("carry stable spreissen tags", () => {
    expect(new NotFound({ what: "widget" })._tag).toBe("spreissen/NotFound");
    const cause = new Error("boom");
    const failure = new External({ op: "fetch", cause });
    expect(failure._tag).toBe("spreissen/External");
    expect(failure.cause).toBe(cause);
  });
});
