import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  makeRig,
  remoteInput,
  startHttpFake,
  waitFor,
  type HttpFake,
  type Rig,
} from "@spreissen/ext/mcp-testing";
import { makeApprovals } from "../approvals.ts";
import { makeAudit } from "../audit/audit.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { makeSecretRequests } from "../secrets/requests.ts";
import { makeUntrustedNotes } from "./access.ts";
import { wireMcp, type McpWiring } from "./install.ts";

const OWNER = "harry";
const CONVERSATION = "c1";
let rig: Rig | undefined;
let fake: HttpFake | undefined;
let wiring: McpWiring | undefined;

afterEach(async () => {
  wiring?.close();
  await rig?.close();
  await fake?.close();
  [rig, fake, wiring] = [undefined, undefined, undefined];
});

const setUp = async (allowlist: string[] | null = null) => {
  fake = await startHttpFake();
  rig = makeRig();
  const registry = createRegistry();
  const approvals = makeApprovals();
  const audit = makeAudit(join(mkdtempSync(join(tmpdir(), "spreissen-audit-")), "audit.jsonl"));
  const profiles = {
    scopeOf: () => ({ owner: OWNER, profileId: "p1" }),
    profileOf: () => ({ id: "p1", toolAllowlist: allowlist }),
  } as unknown as ProfilesService;
  wiring = wireMcp(registry, {
    manager: rig.manager,
    approvals,
    audit,
    profiles,
    notes: makeUntrustedNotes(),
    callTimeoutMs: 5_000,
    secrets: makeSecretRequests({ approvals, vault: null, ownerOf: () => OWNER }),
    vault: null,
    bindings: null,
  });
  const added = rig.manager.add(OWNER, remoteInput(`${fake.base}/mcp`));
  await waitFor(rig.manager, OWNER, added.id, "connected");
  const tool = (name: string): ToolRegistration => {
    const found = registry
      .snapshot()
      .tools()
      .find((entry) => entry.tool.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found.tool;
  };
  let calls = 0;
  /** Run a tool; `answer` decides each approval card that appears (by name). */
  const run = async (name: string, args: unknown, answer: (card: string) => boolean) => {
    const callId = `call-${(calls += 1)}`;
    const pending = tool(name).execute(
      args as never,
      { conversationId: CONVERSATION, callId } as never,
      {} as never,
    );
    const cards: string[] = [];
    const settle = setInterval(() => {
      for (const card of approvals.pendingFor(CONVERSATION)) {
        cards.push(card.name);
        approvals.decide(CONVERSATION, card.callId, answer(card.name));
      }
    }, 5);
    try {
      const result = await pending;
      const text = (result.output ?? [])
        .map((block) => ("text" in block ? block.text : ""))
        .join("");
      return { result, text, cards };
    } finally {
      clearInterval(settle);
    }
  };
  return { added, registry, run, rig };
};

describe("MCP tools in the mind", () => {
  it("asks on first use, then per call; read-only auto-runs only when allowed", async () => {
    const {
      added,
      run,
      rig: { manager },
    } = await setUp();
    const denied = await run("fake_echo", { text: "a" }, () => false);
    expect(denied.cards).toEqual(["mcp (first use of fake)"]);
    expect(denied.result.isError).toBe(true);
    const first = await run("fake_echo", { text: "a" }, () => true);
    expect(first.cards).toEqual(["mcp (first use of fake)"]);
    expect(first.text).toContain("echo: a");
    expect(first.text).toContain('<untrusted source="mcp:fake/echo">');
    // After first use, still a card per call by default (even read-only).
    const second = await run("fake_echo", { text: "b" }, () => true);
    expect(second.cards).toEqual(["fake_echo"]);
    await manager.update(OWNER, added.id, {
      ...remoteInput(added.url ?? ""),
      autoAllowReadOnly: true,
    });
    const auto = await run("fake_echo", { text: "c" }, () => true);
    expect(auto.cards).toEqual([]);
    // Destructive tools always ask.
    const destructive = await run("fake_delete_everything", {}, () => false);
    expect(destructive.cards).toEqual(["fake_delete_everything"]);
    expect(destructive.result.isError).toBe(true);
  });

  it("loads tools through connector_load, filtered by the bot's allowlist", async () => {
    const { run } = await setUp(["fake_echo", "connector_load"]);
    const loaded = await run("connector_load", { server: "fake" }, () => true);
    expect(loaded.result.control?.addTools).toEqual(["fake_echo"]);
    const missing = await run("connector_load", { server: "nope" }, () => true);
    expect(missing.result.isError).toBe(true);
    expect(wiring?.implied(["fake_echo"])).toContain("connector_load");
    expect(wiring?.implied(["now"])).toEqual([]);
  });

  it("reads resources as fenced, read-only calls", async () => {
    const { run } = await setUp();
    const listed = await run("connector_resources", { server: "fake" }, () => true);
    expect(listed.text).toContain("file:///readme.md");
    const read = await run(
      "connector_resources",
      { server: "fake", uri: "file:///readme.md" },
      () => true,
    );
    expect(read.text).toContain("<untrusted");
  });
});
