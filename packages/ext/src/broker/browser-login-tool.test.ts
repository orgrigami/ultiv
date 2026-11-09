/**
 * `browser_login`, the broker's browser adapter, against a fake browser:
 * the first use on a host waits for the owner's card and is remembered,
 * the login fills with the username, password and current TOTP code on the
 * page's REAL host, an HTTP-bound item or a page off the login's sites is
 * refused, every fill and refusal is audited, and no secret ever reaches
 * the model's text or the card. Plus the TOTP code against RFC 6238.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { AuditEvent } from "@spriessen/contracts";
import { createScopeHolder } from "../plugins/vault.ts";
import { makeVaultStore } from "../vault.ts";
import { makeBindingStore } from "./bindings.ts";
import { createBrokerHooks, type BrokerApprovalRequest } from "./hooks.ts";
import {
  BROWSER_FIRST_USE_APPROVAL,
  browserLoginTool,
  type BrowserFillDeps,
} from "./browser-login-tool.ts";
import { totpCode } from "./totp.ts";

process.env.VAULT_KEY = "test-vault-key";
const PASSWORD = "hunter2-correct-horse";
const TOTP = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

let root = "";
let cards: BrokerApprovalRequest[] = [];
let audits: AuditEvent[] = [];
let fills: Record<string, unknown>[] = [];
let signed: string[] = [];
let page = "https://accounts.example.com/signin";
let run: (credential: string) => Promise<{ isError?: boolean; text: string }>;
let reply: { ok?: boolean; kind?: string; filled?: string[] } = {
  ok: true,
  filled: ["username", "password", "otp"],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spriessen-browser-login-"));
  cards = [];
  audits = [];
  fills = [];
  signed = [];
  page = "https://accounts.example.com/signin";
  reply = { ok: true, filled: ["username", "password", "otp"] };
  const vault = makeVaultStore(join(root, "vault"));
  const bindings = makeBindingStore(join(root, "vault"));
  const login = vault.create("harry", {
    kind: "login",
    name: "Example",
    login: { username: "me@example.com", password: PASSWORD, totp: TOTP },
  });
  bindings.put("harry", login.id, {
    adapter: "browser",
    hosts: ["accounts.example.com"],
    methods: ["GET"],
    auth: { placement: "bearer" },
    profiles: null,
    allowLocalhostHttp: false,
  });
  const api = vault.create("harry", {
    kind: "key",
    name: "Api",
    key: { secret: "sk_live_123456" },
  });
  bindings.put("harry", api.id, {
    adapter: "http",
    hosts: ["api.example.com"],
    methods: ["GET"],
    auth: { placement: "bearer" },
    profiles: null,
    allowLocalhostHttp: false,
  });
  const holder = createScopeHolder();
  holder.set({ scopeOf: () => ({ owner: "harry", profile: "eve" }) });
  const hooks = createBrokerHooks();
  hooks.set({
    confirm: async (_c, _id, request) => {
      cards.push(request);
      return true;
    },
    noteFor: () => undefined,
    audit: (event) => audits.push(event),
  });
  const browser: BrowserFillDeps = {
    pageUrl: async () => page,
    fill: async (_conversationId, request) => {
      fills.push({ ...request });
      return reply;
    },
    signedIn: (_conversationId, host) => signed.push(host),
  };
  const tool = browserLoginTool({ vault, bindings, holder, hooks }, browser);
  run = async (credential) => {
    const result = await tool.execute(
      { credential } as never,
      { conversationId: "c1", callId: "k1" } as never,
      {} as never,
    );
    const text = (result.output?.[0] as { text: string } | undefined)?.text ?? "";
    return { ...(result.isError !== undefined ? { isError: result.isError } : {}), text };
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("browser_login", () => {
  it("asks once per host, then fills on the page's real host without showing a secret", async () => {
    const first = await run("example");
    expect(first.isError).toBeUndefined();
    expect(cards.map((card) => card.name)).toEqual([BROWSER_FIRST_USE_APPROVAL]);
    expect(cards[0]?.input).toEqual({ host: "accounts.example.com", credential: "Example" });
    expect(fills[0]).toMatchObject({
      hosts: ["accounts.example.com"],
      expect_host: "accounts.example.com",
      username: "me@example.com",
      password: PASSWORD,
      otp: expect.stringMatching(/^\d{6}$/),
    });
    expect(signed).toEqual(["accounts.example.com"]);
    expect(`${first.text}${JSON.stringify(cards)}${JSON.stringify(audits)}`).not.toContain(
      PASSWORD,
    );
    await run("Example");
    expect(cards).toHaveLength(1);
    expect(audits.map((event) => [event.ok, event.credential?.adapter])).toEqual([
      [true, "browser"],
      [true, "browser"],
    ]);
  });

  it("refuses an HTTP credential, an unknown name, and a page off the login's sites", async () => {
    expect((await run("Api")).text).toContain("is not a browser login");
    expect((await run("nope")).text).toContain('no credential "nope"');
    reply = { ok: false, kind: "host" };
    const off = await run("Example");
    expect(off.text).toContain("may not be used on this page");
    expect(audits.at(-1)).toMatchObject({ ok: false });
    page = "";
    expect((await run("Example")).text).toContain("no page is open");
  });

  it("says so when the page had no sign-in field", async () => {
    reply = { ok: true, filled: [] };
    expect((await run("Example")).text).toContain("no sign-in field");
    expect(signed).toEqual([]);
  });
});

describe("totpCode", () => {
  it("matches RFC 6238's SHA-1 vectors (8 digits) and reads otpauth URIs", () => {
    expect(totpCode(TOTP, 59_000, 8)).toBe("94287082");
    expect(totpCode(TOTP, 1_111_111_109_000, 8)).toBe("07081804");
    expect(totpCode(`otpauth://totp/x?secret=${TOTP}`, 59_000)).toBe("287082");
    expect(totpCode("not base32!")).toBeUndefined();
  });
});
