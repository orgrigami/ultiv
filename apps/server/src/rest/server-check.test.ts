import { describe, expect, it } from "vite-plus/test";
import { serverCheck } from "./server-check.ts";

const base = {
  env: {},
  platform: "darwin",
  arch: "arm64",
  hasKvm: false,
  catalog: { providers: ["kenari"], models: 3, source: "cache" },
  defaultModel: "kenari/some-model",
};

describe("serverCheck", () => {
  it("reports keys as set or not, never their values", () => {
    const secret = "do-not-leak-0123456789";
    const out = serverCheck({
      ...base,
      env: { VAULT_KEY: secret, KENARI_API_KEY: "  ", VAPID_PUBLIC_KEY: secret },
    });
    expect(JSON.stringify(out)).not.toContain(secret);
    const byName = new Map(out.keys.map((key) => [key.names.join("+"), key.set]));
    expect(byName.get("VAULT_KEY")).toBe(true);
    expect(byName.get("KENARI_API_KEY")).toBe(false);
    // A pair counts only when both halves are set.
    expect(byName.get("VAPID_PUBLIC_KEY+VAPID_PRIVATE_KEY")).toBe(false);
  });

  it("flags listening on every interface", () => {
    expect(serverCheck(base).listen).toEqual({ port: 8787, scope: "all" });
    expect(serverCheck({ ...base, env: { HOST: "127.0.0.1", PORT: "9000" } }).listen).toEqual({
      port: 9000,
      scope: "loopback",
    });
    expect(serverCheck({ ...base, env: { HOST: "0.0.0.0" } }).listen.scope).toBe("all");
    expect(serverCheck({ ...base, env: { HOST: "10.0.0.5" } }).listen.scope).toBe("specific");
  });

  it("guesses microVM support from the platform", () => {
    expect(serverCheck(base).microvm.available).toBe(true);
    expect(serverCheck({ ...base, arch: "x64" }).microvm.available).toBe(false);
    expect(serverCheck({ ...base, platform: "linux", hasKvm: true }).microvm.available).toBe(true);
    expect(serverCheck({ ...base, platform: "linux" }).microvm.available).toBe(false);
  });
});
