import { beforeEach, describe, expect, it } from "vite-plus/test";
import { legacyEnvNotice, readEnv, resetLegacyEnvWarnings } from "./env.ts";

describe("readEnv", () => {
  beforeEach(() => resetLegacyEnvWarnings());

  it("reads the SPRIESSEN_ name", () => {
    const warnings: string[] = [];
    expect(readEnv("MODEL", { SPRIESSEN_MODEL: "a/b" }, (m) => warnings.push(m))).toBe("a/b");
    expect(warnings).toEqual([]);
  });

  it("falls back to the old ULTIV_ name and warns once", () => {
    const warnings: string[] = [];
    const env = { ULTIV_MODEL: "old/model" };
    expect(readEnv("MODEL", env, (m) => warnings.push(m))).toBe("old/model");
    expect(readEnv("MODEL", env, (m) => warnings.push(m))).toBe("old/model");
    expect(warnings).toEqual([legacyEnvNotice("MODEL")]);
    expect(warnings[0]).toContain("SPRIESSEN_MODEL");
  });

  it("prefers the new name when both are set, without a warning", () => {
    const warnings: string[] = [];
    const env = { SPRIESSEN_PROVIDERS: "new", ULTIV_PROVIDERS: "old" };
    expect(readEnv("PROVIDERS", env, (m) => warnings.push(m))).toBe("new");
    expect(warnings).toEqual([]);
  });

  it("ignores the short-lived misspelt SPREISSEN_ name (clean cut, no fallback)", () => {
    const warnings: string[] = [];
    expect(readEnv("MODEL", { SPREISSEN_MODEL: "a/b" }, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("is undefined when neither is set", () => {
    expect(readEnv("MAX_RUNNING_TASKS", {}, () => {})).toBeUndefined();
  });
});
