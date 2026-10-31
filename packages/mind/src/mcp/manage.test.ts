import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { makeBindingStore } from "@spreissen/ext";
import { makeRig, startHttpFake, type HttpFake, type Rig } from "@spreissen/ext/mcp-testing";
import { makeApprovals } from "../approvals.ts";
import { makeAudit } from "../audit/audit.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { makeSecretRequests, type SecretRequestsService } from "../secrets/requests.ts";
import { makeUntrustedNotes } from "./access.ts";
import { wireMcp, type McpWiring } from "./install.ts";
import { CONNECTOR_CHANGES, isNeverAutoApproved, planAdd } from "./manage.ts";

const OWNER = "harry";
const CONVERSATION = "c1";
// Built at runtime so the literal never sits next to a log line.
const TOKEN = ["tok", "en", "-", "9f3a7c2e"].join("");
let rig: Rig | undefined;
let fake: HttpFake | undefined;
let wiring: McpWiring | undefined;

afterEach(async () => {
  wiring?.close();
  await rig?.close();
  await fake?.close();
  [rig, fake, wiring] = [undefined, undefined, undefined];
});

type Answer = boolean | { values: Record<string, string> } | "cancel" | "ignore";

const setUp = async (secretTimeoutMs = 5_000, fakeOpts?: Parameters<typeof startHttpFake>[0]) => {
  fake = await startHttpFake(fakeOpts ?? { bearer: TOKEN });
  rig = makeRig();
  const registry = createRegistry();
  const approvals = makeApprovals();
  const auditPath = join(mkdtempSync(join(tmpdir(), "spreissen-audit-")), "audit.jsonl");
  const audit = makeAudit(auditPath);
  const bindings = makeBindingStore(join(rig.root, "vault"));
  const profiles = {
    scopeOf: () => ({ owner: OWNER, profileId: "p1", kind: "main", participants: null }),
    profileOf: () => ({ id: "p1", toolAllowlist: null }),
    list: async () => [
      { id: "p1", name: "Eve" },
      { id: "p2", name: "Ops" },
    ],
  } as unknown as ProfilesService;
  const secrets: SecretRequestsService = makeSecretRequests({
    approvals,
    vault: rig.vault,
    ownerOf: () => OWNER,
    timeoutMs: secretTimeoutMs,
  });
  wiring = wireMcp(registry, {
    manager: rig.manager,
    approvals,
    audit,
    profiles,
    notes: makeUntrustedNotes(),
    callTimeoutMs: 5_000,
    secrets,
    vault: rig.vault,
    bindings,
    settleMs: 8_000,
  });
  const tool = (name: string): ToolRegistration | undefined =>
    registry
      .snapshot()
      .tools()
      .find((entry) => entry.tool.name === name)?.tool;
  let calls = 0;
  /** Run a tool; `answer` handles each card (approve, deny, type a secret, cancel). */
  const run = async (
    name: string,
    args: unknown,
    answer: (card: string, input: unknown) => Answer,
  ) => {
    const callId = `call-${(calls += 1)}`;
    const found = tool(name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    const pending = found.execute(
      args as never,
      { conversationId: CONVERSATION, callId } as never,
      {} as never,
    );
    const cards: { name: string; input: unknown }[] = [];
    const seen = new Set<string>();
    const tick = setInterval(() => {
      for (const card of approvals.pendingFor(CONVERSATION)) {
        if (seen.has(card.callId)) continue;
        seen.add(card.callId);
        cards.push({ name: card.name, input: card.input });
        const reply = answer(card.name, card.input);
        if (reply === "ignore") continue;
        if (reply === "cancel") secrets.cancel(OWNER, card.callId);
        else if (typeof reply === "object")
          expect(secrets.submit(OWNER, card.callId, reply.values).ok).toBe(true);
        else approvals.decide(CONVERSATION, card.callId, reply);
      }
    }, 5);
    try {
      const result = await pending;
      const text = (result.output ?? [])
        .map((block) => ("text" in block ? block.text : ""))
        .join("");
      return { result, text, cards };
    } finally {
      clearInterval(tick);
    }
  };
  return {
    run,
    tool,
    secrets,
    approvals,
    bindings,
    auditPath,
    manager: rig.manager,
    url: `${fake.base}/mcp`,
  };
};

describe("bot-managed connectors", () => {
  it("adds a server live after the card, with the key typed in a secure field", async () => {
    const { run, tool, manager, auditPath, url } = await setUp();
    expect(tool("fake_echo")).toBeUndefined();
    const added = await run("connector_add", { name: "fake", url, auth: "api_key" }, (card) =>
      card === "secret_request" ? { values: { f0: TOKEN } } : card === "connector_add",
    );
    expect(added.cards.map((card) => card.name)).toEqual(["connector_add", "secret_request"]);
    expect(added.cards[0]?.input).toMatchObject({
      change: "add",
      server: "fake",
      url,
      bots: "Eve",
      runsOnMac: false,
    });
    expect(added.text).toContain("Connected with");
    expect(added.text).toContain("fake_echo");
    expect(tool("fake_echo")).toBeDefined();
    expect(fake?.lastAuthorization()).toBe(`Bearer ${TOKEN}`);
    // The value is nowhere the model, the transcript or the audit trail can see.
    const visible = JSON.stringify([added.text, added.cards, manager.list(OWNER)]);
    expect(visible).not.toContain(TOKEN);
    expect(readFileSync(auditPath, "utf8")).not.toContain(TOKEN);
  });

  it("adds a confidential OAuth connector with the client secret in a secure field", async () => {
    const SECRET = ["gocsp", "e2e", "secret", "0987654321"].join("-");
    // The fake token endpoint refuses any exchange without the secret.
    const { run, manager, auditPath, url } = await setUp(5_000, {
      oauth: true,
      oauthRequireSecret: SECRET,
    });
    const flow = await run(
      "connector_add",
      {
        name: "gd",
        url,
        auth: "oauth",
        clientId: "abc.apps.googleusercontent.com",
        authParams: [{ name: "access_type", value: "offline" }],
      },
      (card) => (card === "secret_request" ? { values: { f0: SECRET } } : card === "connector_add"),
    );
    expect(flow.cards.map((card) => card.name)).toEqual(["connector_add", "secret_request"]);
    expect(flow.cards[0]?.input).toMatchObject({
      auth: expect.stringMatching(
        /^Sign in \(OAuth\) as client abc\.apps.* you type its client secret in a secure field next/,
      ),
    });
    expect(flow.text).toContain("It needs sign-in");
    const list = manager.list(OWNER);
    expect(list.length).toBe(1);
    const auth = list[0]?.auth;
    expect(auth).toMatchObject({
      kind: "oauth",
      clientId: "abc.apps.googleusercontent.com",
      authParams: [{ name: "access_type", value: "offline" }],
    });
    const secretItem = (auth as { clientSecretItem?: string }).clientSecretItem ?? "";
    expect(secretItem).not.toBe("");
    // The secret lives only in the vault; replies, config and audit are clean.
    const visible = JSON.stringify([flow.text, flow.cards, list]);
    expect(visible).not.toContain(SECRET);
    expect(readFileSync(auditPath, "utf8")).not.toContain(SECRET);
    // The vault item redeems to the real secret (so sign-in can use it).
    expect(rig?.vault.resolve(OWNER, secretItem)).toBeDefined();
  });

  it("changes nothing when the owner denies the card or cancels the secure field", async () => {
    const { run, manager, url } = await setUp();
    const denied = await run("connector_add", { name: "fake", url, auth: "api_key" }, () => false);
    expect(denied.result.isError).toBe(true);
    expect(denied.cards.map((card) => card.name)).toEqual(["connector_add"]);
    const cancelled = await run("connector_add", { name: "fake", url, auth: "api_key" }, (card) =>
      card === "secret_request" ? "cancel" : true,
    );
    expect(cancelled.result.isError).toBe(true);
    expect(cancelled.text).toContain("nothing was stored");
    expect(manager.list(OWNER)).toEqual([]);
  });

  it("times out an unanswered secure field without adding anything", async () => {
    const { run, manager, url } = await setUp(80);
    const late = await run("connector_add", { name: "fake", url, auth: "api_key" }, (card) =>
      card === "secret_request" ? "ignore" : true,
    );
    expect(late.result.isError).toBe(true);
    expect(manager.list(OWNER)).toEqual([]);
  });

  it("gates disable and remove behind cards; reconnect and list need none", async () => {
    const { run, manager, url } = await setUp();
    await run("connector_add", { name: "fake", url, auth: "api_key" }, (card) =>
      card === "secret_request" ? { values: { f0: TOKEN } } : true,
    );
    const listed = await run("connector_list", {}, () => false);
    expect(listed.cards).toEqual([]);
    expect(listed.text).toContain("context7");
    const kept = await run("connector_disable", { server: "fake" }, () => false);
    expect(kept.result.isError).toBe(true);
    expect(manager.list(OWNER)[0]?.enabled).toBe(true);
    const off = await run("connector_disable", { server: "fake" }, () => true);
    expect(off.cards.map((card) => card.name)).toEqual(["connector_disable"]);
    expect(manager.list(OWNER)[0]?.state).toBe("disabled");
    const moved = await run("connector_update", { server: "fake", bots: ["*"] }, () => true);
    expect(moved.cards[0]?.input).toMatchObject({ changes: ["Bots: Eve → Every bot"] });
    const gone = await run("connector_remove", { server: "fake" }, () => true);
    expect(gone.text).toContain("Removed");
    expect(manager.list(OWNER)).toEqual([]);
  });

  it("stores a secret_request value in the vault and binds it for http_request", async () => {
    const { run, bindings, secrets, auditPath } = await setUp();
    const asked = await run(
      "secret_request",
      { label: "Acme key", purpose: "Call the Acme API", bindTo: { host: "api.acme.test" } },
      (card, input) => {
        expect(card).toBe("secret_request");
        expect(input).toMatchObject({ usedFor: "only sent to api.acme.test" });
        expect(secrets.submit("someone-else", "call-1", { secret: TOKEN }).ok).toBe(false);
        expect(secrets.submit(OWNER, "call-1", { secret: "short" }).ok).toBe(false);
        return { values: { secret: TOKEN } };
      },
    );
    expect(asked.text).toContain('stored as vault item "Acme key"');
    expect(asked.text).not.toContain(TOKEN);
    expect(bindings.list(OWNER)[0]?.hosts).toEqual(["api.acme.test"]);
    expect(readFileSync(auditPath, "utf8")).not.toContain(TOKEN);
  });
});

describe("planning a connector change", () => {
  it("fills presets and shows a local command's env names, never values", () => {
    const preset = planAdd({ preset: "context7" }, { items: [], bots: "Eve", profiles: ["p1"] });
    expect(preset).toMatchObject({ card: { url: "https://mcp.context7.com/mcp", auth: "No key" } });
    const local = planAdd(
      { name: "files", command: "npx", args: ["-y", "srv"], env: [{ name: "API_TOKEN" }] },
      { items: [], bots: "Eve", profiles: ["p1"] },
    );
    expect(local).toMatchObject({ card: { runsOnMac: true, env: ["API_TOKEN"], command: "npx" } });
    expect(
      planAdd(
        { name: "x", url: "https://x.test", vaultItem: "nope" },
        { items: [], bots: "", profiles: null },
      ),
    ).toBe('no vault item "nope"');
  });

  it("keeps connector changes and secure inputs out of Always allow", () => {
    for (const name of [...CONNECTOR_CHANGES, "secret_request"])
      expect(isNeverAutoApproved(name)).toBe(true);
    expect(isNeverAutoApproved("connector_list")).toBe(false);
  });

  it("plans confidential OAuth: client id, preset params, secure secret slot", () => {
    const items = [{ id: "v1", name: "Google client secret" }];
    const context = { items, bots: "Eve", profiles: ["p1"] };
    // Preset carries Google's redirect quirks; the client id queues the secret.
    const planned = planAdd(
      { preset: "google-drive", clientId: "abc.apps.googleusercontent.com" },
      context,
    );
    if (typeof planned === "string") throw new Error(planned);
    expect(planned.input.auth).toEqual({
      kind: "oauth",
      clientId: "abc.apps.googleusercontent.com",
      clientSecretItem: "",
      authParams: [
        { name: "access_type", value: "offline" },
        { name: "prompt", value: "consent" },
      ],
    });
    expect(planned.slots).toEqual([
      { target: "oauthSecret", index: 0, label: "OAuth client secret for google-drive" },
    ]);
    expect(planned.card.auth).toContain("secure field");
    // An existing vault item pins the secret instead of asking.
    const pinned = planAdd(
      {
        name: "gdrive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        auth: "oauth",
        clientId: "abc",
        vaultItem: "Google client secret",
        oauthScope: "https://www.googleapis.com/auth/drive.readonly",
      },
      context,
    );
    if (typeof pinned === "string") throw new Error(pinned);
    expect(pinned.input.auth).toEqual({
      kind: "oauth",
      clientId: "abc",
      clientSecretItem: "v1",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });
    expect(pinned.slots).toEqual([]);
    // The client id can live in the vault too (secure-field collection).
    const idFromVault = planAdd(
      {
        name: "gdrive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        auth: "oauth",
        clientIdItem: "Google client id",
        vaultItem: "Google client secret",
      },
      { items: [...items, { id: "v2", name: "Google client id" }], bots: "Eve", profiles: ["p1"] },
    );
    if (typeof idFromVault === "string") throw new Error(idFromVault);
    expect(idFromVault.input.auth).toEqual({
      kind: "oauth",
      clientIdItem: "v2",
      clientSecretItem: "v1",
    });
    expect(
      planAdd(
        { name: "x", url: "https://x.test", auth: "oauth", clientIdItem: "nope" },
        { items: [], bots: "", profiles: null },
      ),
    ).toBe('no vault item "nope"');
    // Updates keep the previous scope and secret when only the id changes.
    const previous = pinned.input.auth as Extract<
      import("@spreissen/contracts").McpAuth,
      { kind: "oauth" }
    >;
    const updated = planAdd(
      {
        name: "gdrive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        clientId: "new-id",
        previousOAuth: previous,
        auth: "oauth",
      },
      context,
    );
    if (typeof updated === "string") throw new Error(updated);
    expect(updated.input.auth).toMatchObject({ clientId: "new-id", clientSecretItem: "v1" });
    expect(updated.input.auth).toMatchObject({
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });
    expect(updated.slots).toEqual([]);
  });
});
