import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { CredentialBindingInput } from "@spreissen/contracts";
import { makeBindingStore, validateBinding } from "./bindings.ts";
import { checkHttp } from "./http-adapter.ts";
import { entryMatches } from "./http-auth.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The InvalidInput reason a validation throws ('' when it did not throw). */
const reasonOf = (run: () => unknown): string => {
  try {
    run();
    return "";
  } catch (cause) {
    return String((cause as { reason?: string }).reason ?? cause);
  }
};

const input = (over: Partial<CredentialBindingInput> = {}): CredentialBindingInput => ({
  adapter: "http",
  hosts: ["api.example.com"],
  methods: ["GET"],
  auth: { placement: "bearer" },
  profiles: null,
  allowLocalhostHttp: false,
  ...over,
});

describe("credential bindings", () => {
  it("validates hosts, placements and header names", () => {
    expect(validateBinding(input({ hosts: ["API.Example.com", "*.example.org"] })).hosts).toEqual([
      "api.example.com",
      "*.example.org",
    ]);
    expect(validateBinding(input({ hosts: ["https://api.x.com/v1"] })).hosts).toEqual([
      "https://api.x.com/v1",
    ]);
    expect(reasonOf(() => validateBinding(input({ hosts: ["http://api.x.com/"] })))).toMatch(
      /https/,
    );
    expect(reasonOf(() => validateBinding(input({ hosts: ["http://localhost:3000/"] })))).toMatch(
      /https/,
    );
    expect(
      validateBinding(input({ hosts: ["http://localhost:3000/"], allowLocalhostHttp: true })).hosts,
    ).toEqual(["http://localhost:3000/"]);
    expect(reasonOf(() => validateBinding(input({ hosts: ["*.com"] })))).toMatch(/./);
    expect(reasonOf(() => validateBinding(input({ hosts: ["https://u:p@x.com/"] })))).toMatch(
      /credentials/,
    );
    expect(reasonOf(() => validateBinding(input({ auth: { placement: "query" } })))).toMatch(
      /needs a name/,
    );
    expect(() =>
      validateBinding(input({ auth: { placement: "header", name: "Cookie" } })),
    ).toThrow();
  });

  it("matches hosts, wildcards, ports and path prefixes on a boundary", () => {
    const url = (u: string) => new URL(u);
    expect(entryMatches("api.example.com", url("https://api.example.com/a"))).toBe(true);
    expect(entryMatches("api.example.com", url("https://api.example.com:8443/a"))).toBe(false);
    expect(entryMatches("api.example.com:8443", url("https://api.example.com:8443/a"))).toBe(true);
    expect(entryMatches("*.example.com", url("https://a.b.example.com/"))).toBe(true);
    expect(entryMatches("*.example.com", url("https://evilexample.com/"))).toBe(false);
    expect(entryMatches("https://x.com/v1", url("https://x.com/v1/users"))).toBe(true);
    expect(entryMatches("https://x.com/v1", url("https://x.com/v10"))).toBe(false);
    expect(entryMatches("https://x.com/v1", url("http://x.com/v1/users"))).toBe(false);
  });

  it("enforces methods and hosts, and resets first-use approvals when hosts change", () => {
    const root = mkdtempSync(join(tmpdir(), "spreissen-bind-"));
    dirs.push(root);
    const store = makeBindingStore(root);
    const binding = store.put("harry", "item1", input());
    expect(checkHttp(binding, { method: "GET", url: "https://api.example.com/x" })).toEqual({
      ok: true,
      host: "api.example.com",
    });
    expect(checkHttp(binding, { method: "POST", url: "https://api.example.com/x" }).ok).toBe(false);
    expect(checkHttp(binding, { method: "GET", url: "https://evil.com/x" }).ok).toBe(false);
    store.approveHost("harry", "item1", "api.example.com");
    store.put("harry", "item1", input({ methods: ["GET", "POST"] }));
    expect(store.get("harry", "item1")?.approvedHosts).toEqual(["api.example.com"]);
    store.put("harry", "item1", input({ hosts: ["api.other.com"] }));
    expect(store.get("harry", "item1")?.approvedHosts).toEqual([]);
    expect(store.list("someone-else")).toEqual([]);
    expect(store.remove("harry", "item1")).toBe(true);
  });
});
