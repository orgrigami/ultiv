import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { invoke } from "../connector.ts";
import { vaultedHttpConnector } from "./http.ts";
import { makeVaultStore, vaultAuthSource } from "../vault.ts";

// The vault reads process.env directly (not Effect Config), so test-time is fine.
process.env.VAULT_KEY = "test-vault-key";

const dirs: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spreissen-vault-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Vault store", () => {
  it("seals secrets, resolves them in-process, and never leaks in metadata", async () => {
    const store = makeVaultStore(tempRoot());
    const login = store.create("harry", {
      kind: "login",
      name: "Gmail",
      login: { url: "https://mail.google.com", username: "harry@gmail.com", password: "s3cret!" },
    });
    expect(login.access).toBe("secret");
    expect(login.masked).toBe("harry@gmail.com@mail.google.com");
    expect(JSON.stringify(login)).not.toContain("s3cret");

    const resolved = store.resolve("harry", login.id);
    expect(resolved).toMatchObject({
      kind: "login",
      username: "harry@gmail.com",
      password: "s3cret!",
    });
    expect(store.get("harry", login.id)?.lastUsedAt).not.toBeNull();
  });

  it("scopes items owner-shared or profile-isolated; contacts are readable", () => {
    const store = makeVaultStore(tempRoot());
    const key = store.create("harry", {
      kind: "key",
      name: "API key",
      key: { service: "acme", secret: "tok_123" },
    });
    // Masks never reveal characters of a secret — not even a prefix.
    expect(key.masked).not.toContain("tok");
    store.create("harry", {
      kind: "contact",
      name: "Mom",
      profile: "researcher",
      contact: { email: "mom@example.com" },
    });
    // Owner-wide list sees both; a profile scope sees the shared item only.
    expect(store.list("harry").length).toBe(2);
    expect(store.list("harry", { profile: "researcher" }).length).toBe(2);
    expect(store.list("harry", { profile: "other" }).length).toBe(1);
    const contacts = store.contacts("harry", { profile: "researcher", query: "mom" });
    expect(contacts.length).toBe(1);
    expect(contacts[0]?.email).toBe("mom@example.com");
    // Another owner sees nothing.
    expect(store.list("someone-else").length).toBe(0);
  });

  it("skips and reports a contact it cannot decrypt instead of failing the lookup", () => {
    const store = makeVaultStore(tempRoot());
    store.create("harry", { kind: "contact", name: "Old", contact: { email: "old@example.com" } });
    const previous = process.env.VAULT_KEY;
    process.env.VAULT_KEY = "a-different-key";
    try {
      store.create("harry", {
        kind: "contact",
        name: "New",
        contact: { email: "new@example.com" },
      });
      const report = store.contactsReport("harry");
      expect(report.contacts.map((contact) => contact.name)).toEqual(["New"]);
      expect(report.unreadable.map((item) => item.name)).toEqual(["Old"]);
      expect(store.contacts("harry").length).toBe(1);
    } finally {
      process.env.VAULT_KEY = previous;
    }
  });

  it("mints single-use, short-lived grants for executors", () => {
    const store = makeVaultStore(tempRoot());
    const key = store.create("harry", { kind: "key", name: "runner", key: { secret: "tok" } });
    const grant = store.mintGrant("harry", key.id, "cli-login");
    expect(grant).toBeDefined();
    const first = store.redeemGrant(grant!.token);
    expect(first?.secret).toMatchObject({ kind: "key", secret: "tok" });
    expect(store.redeemGrant(grant!.token)).toBeUndefined();
    expect(store.mintGrant("harry", "unknown", "x")).toBeUndefined();
  });

  it("purges a profile's items", () => {
    const store = makeVaultStore(tempRoot());
    const item = store.create("harry", {
      kind: "note",
      name: "n",
      profile: "gone",
      note: { secret: "x" },
    });
    store.create("harry", { kind: "note", name: "shared", note: { secret: "y" } });
    expect(store.removeProfile("harry", "gone")).toBe(1);
    expect(store.get("harry", item.id)).toBeUndefined();
    expect(store.list("harry").length).toBe(1);
  });
});

describe("Vault-backed connector auth", () => {
  it("redeems the vault item at the authenticate step; missing items fail loudly", async () => {
    const store = makeVaultStore(tempRoot());
    const item = store.create("harry", { kind: "key", name: "bearer", key: { secret: "tok_abc" } });
    const source = vaultAuthSource(store, "harry");
    const connector = {
      ...vaultedHttpConnector,
      auth: { ...vaultedHttpConnector.auth, item: item.id },
      actions: [
        {
          ...vaultedHttpConnector.actions[0]!,
          perform: (input: unknown, ctx: { apiKey?: string }) =>
            Effect.succeed({ status: 200, body: ctx.apiKey ?? "none" }),
        },
      ],
    };
    const context = await Effect.runPromise(
      invoke(connector, "request", { method: "GET", url: "https://example.test" }, source),
    );
    expect(context).toMatchObject({ status: 200, body: "tok_abc" });

    // No vault item under that id: AuthMissing, never a silent pass-through.
    const missing = await Effect.runPromise(
      Effect.exit(
        invoke(vaultedHttpConnector, "request", { method: "GET", url: "https://example.test" }),
      ),
    );
    expect(missing._tag).toBe("Failure");
  });
});
