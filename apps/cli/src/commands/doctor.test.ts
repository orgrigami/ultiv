import { describe, expect, it } from "vite-plus/test";
import { checkSteps, nodeStep } from "./doctor.ts";

const check = {
  keys: [],
  models: { providers: ["kenari"], count: 2, default: "kenari/a" },
  microvm: { available: true, detail: "" },
  listen: { port: 8787, scope: "all" as const },
};

describe("doctor's Node steps", () => {
  it("passes Node 26 and fails an older line with the fix", () => {
    expect(nodeStep("The server", "26.13.0").verdict).toBe("ok");
    const old = nodeStep("This command", "24.1.0");
    expect(old.verdict).toBe("fail");
    expect(old.fix).toContain("install-cli.sh");
  });

  it("only notes a newer line", () => {
    expect(nodeStep("The server", "28.0.0").verdict).toBe("info");
  });

  it("checks the server's Node when the server reports it", () => {
    expect(checkSteps(check)[0]?.text).toContain("2 models");
    expect(checkSteps({ ...check, node: "24.0.0" })[0]).toMatchObject({ verdict: "fail" });
  });
});
