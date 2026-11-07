import { describe, expect, it } from "vite-plus/test";
import type { ServerCheck } from "@/lib/api-types";
import { readinessOf, templatesFor } from "./onboarding-templates.ts";

const check = (set: readonly string[], microvm = true): ServerCheck => ({
  keys: ["TINYFISH_API_KEY", "VAULT_KEY"].map((name) => ({
    names: [name],
    set: set.includes(name),
    enables: name,
    group: "features",
  })),
  models: { providers: [], count: 0, default: "", source: "" },
  microvm: { available: microvm, detail: "" },
  listen: { port: 8787, scope: "all" },
});

const bulletsOf = (key: string, readiness: ReturnType<typeof readinessOf> | null) =>
  templatesFor(readiness).find((template) => template.key === key)?.bullets ?? [];

describe("onboarding templates", () => {
  it("promise live web search only when the server has it", () => {
    const off = bulletsOf("researcher", readinessOf(check([])));
    expect(off[0]).toMatchObject({ ready: false, need: "TINYFISH_API_KEY on the server" });
    expect(off.some((bullet) => /Searches the live web/.test(bullet.text))).toBe(false);
    const on = bulletsOf("researcher", readinessOf(check(["TINYFISH_API_KEY"])));
    expect(on[0]).toEqual({ text: "Searches the live web and reads pages", ready: true });
  });

  it("word saved logins and the shell by what is set up", () => {
    const off = bulletsOf("assistant", readinessOf(check([], false)));
    expect(off.filter((bullet) => !bullet.ready).map((bullet) => bullet.need)).toEqual([
      "VAULT_KEY on the server",
      "macOS on Apple silicon, or Linux with KVM",
    ]);
    expect(bulletsOf("assistant", readinessOf(check(["VAULT_KEY"]))).every((b) => b.ready)).toBe(
      true,
    );
  });

  it("never claim other bots on a first run", () => {
    const coordination = bulletsOf("projects", null).at(-1);
    expect(coordination).toMatchObject({ ready: false });
    expect(coordination?.text).toContain("once you add");
  });

  it("never say a capability is 'yet' to ship", () => {
    const all = templatesFor(readinessOf(check(["TINYFISH_API_KEY", "VAULT_KEY"])));
    expect(JSON.stringify(all)).not.toMatch(/can't use logins yet/);
  });
});
