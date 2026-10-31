import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { AuditEvent } from "@spreissen/contracts";
import { createScopeHolder } from "../plugins/vault.ts";
import { makeVaultStore } from "../vault.ts";
import { makeBindingStore } from "./bindings.ts";
import { createBrokerHooks, type BrokerApprovalRequest } from "./hooks.ts";
import { FIRST_USE_APPROVAL, HTTP_REQUEST_TOOL, httpRequestTool } from "./http-request-tool.ts";
import { startServer, type TestServer } from "./test-servers.ts";

process.env.VAULT_KEY = "test-vault-key";
const SECRET = "sk_test_9f8e7d6c5b4a";

interface Rig {
  readonly server: TestServer;
  readonly cards: BrokerApprovalRequest[];
  readonly audits: AuditEvent[];
  readonly run: (args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
  readonly approve: { value: boolean };
  readonly bindings: ReturnType<typeof makeBindingStore>;
  readonly itemId: string;
  readonly base: string;
}

let rig: Rig;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "spreissen-broker-"));
  // An echo server: whatever reached it (auth included) comes back in the body.
  const server = await startServer((seen, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ method: seen.method, url: seen.url, headers: seen.headers }));
  });
  const vault = makeVaultStore(join(root, "vault"));
  const bindings = makeBindingStore(join(root, "vault"));
  const item = vault.create("harry", { kind: "key", name: "Stripe", key: { secret: SECRET } });
  const base = `http://127.0.0.1:${server.port}/`;
  bindings.put("harry", item.id, {
    adapter: "http",
    hosts: [`${base}v1`],
    methods: ["GET", "POST"],
    auth: { placement: "query", name: "key" },
    profiles: ["eve"],
    allowLocalhostHttp: true,
  });
  const holder = createScopeHolder();
  holder.set({ scopeOf: () => ({ owner: "harry", profile: "eve" }) });
  const hooks = createBrokerHooks();
  const cards: BrokerApprovalRequest[] = [];
  const audits: AuditEvent[] = [];
  const approve = { value: true };
  hooks.set({
    confirm: async (_c, _id, request) => {
      cards.push(request);
      return approve.value;
    },
    noteFor: () => undefined,
    audit: (event) => audits.push(event),
  });
  const tool = httpRequestTool({ vault, bindings, holder, hooks });
  const run = async (args: Record<string, unknown>) => {
    const api = { conversationId: "conv-1", callId: `call-${cards.length}` } as never;
    const result = await tool.execute(args as never, api, {} as never);
    const text = (result.output?.[0] as { text: string } | undefined)?.text ?? "";
    return { ...(result.isError !== undefined ? { isError: result.isError } : {}), text };
  };
  rig = { server, cards, audits, run, approve, bindings, itemId: item.id, base };
});

afterEach(async () => {
  await rig.server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("http_request broker tool", () => {
  it("asks on first use, spends the secret, and scrubs it from everything model-facing", async () => {
    expect(HTTP_REQUEST_TOOL).toBe("http_request");
    const first = await rig.run({ method: "GET", url: `${rig.base}v1/me`, credential: "stripe" });
    expect(rig.cards.map((card) => card.name)).toEqual([FIRST_USE_APPROVAL]);
    expect(JSON.stringify(rig.cards)).not.toContain(SECRET);
    expect(rig.server.seen[0]?.url).toBe(`/v1/me?key=${SECRET}`);
    expect(first.text).not.toContain(SECRET);
    expect(first.text).toContain("[redacted:Stripe]");
    // Approved once for this host: a second GET goes straight through.
    await rig.run({ method: "GET", url: `${rig.base}v1/me`, credential: "Stripe" });
    expect(rig.cards).toHaveLength(1);
    expect(rig.bindings.get("harry", rig.itemId)?.approvedHosts).toEqual([
      `127.0.0.1:${rig.server.port}`,
    ]);
    // The audit says who/where/status and never carries the secret.
    expect(rig.audits[0]).toMatchObject({
      kind: "credential",
      profile: "eve",
      credential: { item: "Stripe", adapter: "http", method: "GET", status: 200 },
    });
    expect(JSON.stringify(rig.audits)).not.toContain(SECRET);
  });

  it("asks before every non-GET call and makes no request when denied", async () => {
    rig.bindings.approveHost("harry", rig.itemId, `127.0.0.1:${rig.server.port}`);
    rig.approve.value = false;
    const denied = await rig.run({
      method: "POST",
      url: `${rig.base}v1/charge`,
      credential: "Stripe",
      body: "{}",
    });
    expect(denied.isError).toBe(true);
    expect(rig.cards.map((card) => card.name)).toEqual([HTTP_REQUEST_TOOL]);
    expect(rig.server.seen).toHaveLength(0);
  });

  it("enforces the binding: methods, URL prefix, profiles and unbound items", async () => {
    const refusals = [
      { method: "DELETE", url: `${rig.base}v1/x`, credential: "Stripe" },
      { method: "GET", url: `${rig.base}admin`, credential: "Stripe" },
      { method: "GET", url: `${rig.base}v1/x`, credential: "Nope" },
    ];
    for (const args of refusals) expect((await rig.run(args)).isError).toBe(true);
    rig.bindings.put("harry", rig.itemId, {
      ...rig.bindings.get("harry", rig.itemId)!,
      profiles: ["other-bot"],
    });
    const wrongProfile = await rig.run({
      method: "GET",
      url: `${rig.base}v1/x`,
      credential: "Stripe",
    });
    expect(wrongProfile.isError).toBe(true);
    rig.bindings.remove("harry", rig.itemId);
    const unbound = await rig.run({ method: "GET", url: `${rig.base}v1/x`, credential: "Stripe" });
    expect(unbound.text).toMatch(/binding/);
    expect(rig.server.seen).toHaveLength(0);
    expect(rig.cards).toHaveLength(0);
  });

  it("refuses plain-http and private targets without a credential's localhost opt-in", async () => {
    const plain = await rig.run({ method: "GET", url: `${rig.base}v1/x` });
    expect(plain.text).toMatch(/only https/);
    const metadata = await rig.run({ method: "GET", url: "https://169.254.169.254/latest" });
    expect(metadata.text).toMatch(/refused/);
    expect(rig.server.seen).toHaveLength(0);
  });
});
