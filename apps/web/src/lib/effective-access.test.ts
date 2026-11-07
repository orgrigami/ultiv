import { describe, expect, it } from "vite-plus/test";
import { effectiveAccess, type AccessInput } from "./effective-access.ts";

const bot = (
  patch: Partial<AccessInput["bot"]["policies"]> = {},
  allowlist: string[] | null = null,
) =>
  ({
    id: "b1",
    name: "Ada",
    toolAllowlist: allowlist,
    policies: { approvalMode: "manual", autoApprove: [], ...patch },
  }) as unknown as AccessInput["bot"];

const lineOf = (input: AccessInput, label: string) =>
  effectiveAccess(input).find((line) => line.label === label);

const base: AccessInput = {
  bot: bot(),
  microvm: true,
  host: { allowed: false, blockedBy: "org" },
  bindings: [],
};

describe("effectiveAccess", () => {
  it("says who approves, counting saved rules", () => {
    expect(lineOf(base, "Approvals")?.text).toBe("Every step with side effects asks you first.");
    const ruled = lineOf({ ...base, bot: bot({ autoApprove: ["a", "b"] }) }, "Approvals");
    expect(ruled?.text).toContain("2 always-allowed rules skip the question.");
    expect(lineOf({ ...base, bot: bot({ approvalMode: "yolo" }) }, "Approvals")?.tone).toBe("on");
  });

  it("explains a missing shell by its real cause", () => {
    expect(lineOf(base, "Shell")?.tone).toBe("on");
    expect(lineOf({ ...base, bot: bot({ sandbox: false }) }, "Shell")?.text).toMatch(
      /Off for this bot/,
    );
    expect(lineOf({ ...base, microvm: false }, "Shell")).toMatchObject({
      tone: "off",
      fix: "Settings › Server",
    });
  });

  it("names the level that blocks host access and where to fix it", () => {
    expect(lineOf(base, "This computer")).toMatchObject({
      text: "No access: the org switch is off.",
      fix: "Settings › Organization",
    });
    expect(
      lineOf({ ...base, host: { allowed: false, blockedBy: "team" } }, "This computer")?.text,
    ).toBe("No access: its team's switch is off.");
    expect(
      lineOf({ ...base, host: { allowed: true, blockedBy: null } }, "This computer")?.tone,
    ).toBe("asks");
  });

  it("counts the tools on its list", () => {
    expect(lineOf(base, "Tools")?.text).toMatch(/Every installed tool/);
    expect(lineOf({ ...base, bot: bot({}, ["web_search"]) }, "Tools")?.text).toMatch(
      /^1 chosen tool;/,
    );
  });

  it("lists only the logins bound to this bot, by site", () => {
    const bindings = [
      { profiles: null, hosts: ["api.github.com"] },
      { profiles: ["b1"], hosts: ["mail.example.com"] },
      { profiles: ["someone-else"], hosts: ["secret.example.com"] },
    ];
    const line = lineOf({ ...base, bindings }, "Saved logins");
    expect(line?.text).toBe(
      "2 it may use, only on api.github.com, mail.example.com. The first use on each site asks you.",
    );
    expect(lineOf(base, "Saved logins")?.fix).toBe("Vault › Allow web use");
  });
});
