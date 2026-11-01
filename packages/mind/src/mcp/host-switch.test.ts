/**
 * Slice 10: stdio connectors are host-direct (their server runs as a host
 * process). A false switch refuses a tool call BEFORE the first-use card and
 * before any auto-allow, leaves the tools unloadable and the connector out
 * of the prompt section; an HTTP connector is untouched.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  makeRig,
  remoteInput,
  startHttpFake,
  stdioInput,
  waitFor,
  type HttpFake,
  type Rig,
} from "@spriessen/ext/mcp-testing";

/** The test-only stdio server, from the ext package's source tree. */
const STDIO_SCRIPT = new URL("../../../ext/src/mcp/testing/stdio-server.ts", import.meta.url)
  .pathname;
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

const setUp = async (hostAccess: () => boolean, hostAllowed?: () => boolean) => {
  fake = await startHttpFake();
  rig = makeRig();
  const registry = createRegistry();
  const approvals = makeApprovals();
  const audit = makeAudit(join("/dev", "null"));
  const profiles = {
    scopeOf: () => ({ owner: OWNER, profileId: "p1" }),
    profileOf: () => ({ id: "p1", toolAllowlist: null, departmentId: null, hostAccess: true }),
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
    hostAccess: async () => hostAccess(),
    ...(hostAllowed === undefined ? {} : { hostAllowed: () => hostAllowed() }),
  });
  const stdio = rig.manager.add(
    OWNER,
    stdioInput({
      name: "Local",
      command: { command: process.execPath, args: [STDIO_SCRIPT], env: [] },
    }),
  );
  const http = rig.manager.add(OWNER, remoteInput(`${fake.base}/mcp`));
  await waitFor(rig.manager, OWNER, stdio.id, "connected");
  await waitFor(rig.manager, OWNER, http.id, "connected");
  const tool = (name: string): ToolRegistration => {
    const found = registry
      .snapshot()
      .tools()
      .find((entry) => entry.tool.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found.tool;
  };
  return { approvals, audit, registry, tool, stdio, http };
};

describe("the host-access switch on stdio connectors", () => {
  it("refuses a tool call before the first-use card while the switch is off", async () => {
    const { approvals, tool, stdio } = await setUp(() => false);
    const tools = rig?.manager.views().find((view) => view.record.id === stdio.id)?.tools ?? [];
    const name = tools[0]?.name;
    expect(name).toBeDefined();
    const result = (await tool(name as string).execute(
      {} as never,
      { conversationId: CONVERSATION, callId: "k1" } as never,
      {} as never,
    )) as { isError?: boolean; output: { type: string; text?: string }[] };
    const text = (result.output ?? []).map((block) => block.text ?? "").join("");
    expect(result.isError).toBe(true);
    expect(text).toContain("does not have access to this computer");
    expect(approvals.pendingFor(CONVERSATION)).toEqual([]);
  });

  it("runs the same call through the first-use card once the switch is on", async () => {
    const { approvals, tool, stdio } = await setUp(() => true);
    const tools = rig?.manager.views().find((view) => view.record.id === stdio.id)?.tools ?? [];
    const name = tools[0]?.name as string;
    const pending = tool(name).execute(
      {} as never,
      { conversationId: CONVERSATION, callId: "k2" } as never,
      {} as never,
    );
    let card = false;
    for (let i = 0; i < 200 && !card; i += 1) {
      card = approvals.pendingFor(CONVERSATION).length > 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(card).toBe(true);
    approvals.decide(CONVERSATION, "k2", false);
    await pending;
  });

  it("hides the stdio server from the section while off; http stays", async () => {
    const { registry } = await setUp(
      () => false,
      () => false,
    );
    const section = registry
      .snapshot()
      .sections()
      .find((entry) => entry.section.key === "connectors");
    const rendered = String(
      section?.section.render({ conversationId: CONVERSATION } as never, {} as never),
    );
    expect(rendered).toContain("fake");
    expect(rendered).not.toContain("local");
  });

  it("names the stdio tools for the list exclusion", async () => {
    const { registry, stdio } = await setUp(() => false);
    const wiringLocal = wiring as McpWiring;
    const names = wiringLocal.hostDirectToolNames();
    const tools = rig?.manager.views().find((view) => view.record.id === stdio.id)?.tools ?? [];
    expect(names).toEqual(tools.map((tool) => tool.name));
    expect(registry).toBeDefined();
  });
});
