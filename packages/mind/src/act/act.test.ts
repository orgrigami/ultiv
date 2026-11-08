import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { obj, str } from "@earendil-works/pi-schema";
import type { PromptSection } from "@earendil-works/pi-durable";
import {
  bashPlugin,
  defineTool,
  localShellBackend,
  type Tool,
  type RegistryService,
} from "@spriessen/ext";
import { makeApprovals } from "../approvals.ts";
import { makeAudit } from "../audit/audit.ts";
import { actService } from "./act.ts";
import { ENTITY_NAME, identityPlugin, identitySection } from "./identity.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo the input.",
  parameters: obj({ text: str() }, { open: true }),
  execute: async () => ({ output: [{ type: "text", text: "echo" }] }),
});

const registry = (
  tools: readonly ReturnType<typeof defineTool>[],
  sections: readonly PromptSection[] = [],
): RegistryService => ({
  register: () => Effect.succeed(undefined),
  plugins: () => [],
  tools: () => tools,
  sections: () => sections,
  connector: () => undefined,
});

describe("Act", () => {
  const audit = makeAudit("/dev/null");

  it("carries registry sections into the extension", () => {
    const act = actService(registry([echo], [identitySection()]), makeApprovals(), audit);
    const section = act.extension().sections?.[0];
    expect(section?.key).toBe("identity");
    expect(section?.render({} as never, {} as never)).toContain(`You are ${ENTITY_NAME}`);
  });

  it("gates flagged tools through the approval broker, reads stay clean", () => {
    const act = actService(
      registry([
        { ...echo, gated: true },
        { ...echo, name: "echo_read" },
      ]),
      makeApprovals(),
      audit,
    );
    expect(act.tools().map((tool) => tool.name)).toEqual(["echo", "echo_read"]);
    // The gated one is wrapped: its execute now consults the broker first.
    const gated = act.extension().tools?.find((tool) => tool.name === "echo");
    expect(gated?.execute).not.toBe(echo.execute);
  });

  it("refuses a beyond-VM bash call before any card when the capability is absent", async () => {
    const approvals = makeApprovals();
    const act = actService(
      registry([{ ...echo, name: "bash", gated: true }]),
      approvals,
      audit,
      undefined,
      () => false,
    );
    const tool = act.extension().tools?.find((entry) => entry.name === "bash");
    const result = (await tool?.execute(
      { text: "x", target: "host" } as never,
      { conversationId: "c1", callId: "h1" } as never,
      {} as never,
    )) as { isError?: boolean; output: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.output[0]?.text).toContain("does not have access to this computer");
    // Nothing parked: the refusal was final, no card for the owner.
    expect(approvals.pendingFor("c1")).toEqual([]);
  });

  it("keeps the host capability open when the seam allows it", async () => {
    const approvals = makeApprovals();
    const act = actService(
      registry([{ ...echo, name: "bash", gated: true }]),
      approvals,
      audit,
      undefined,
      () => true,
    );
    const tool = act.extension().tools?.find((entry) => entry.name === "bash");
    const run = tool?.execute(
      { text: "x", target: "host" } as never,
      { conversationId: "c2", callId: "h2" } as never,
      {} as never,
    ) as Promise<unknown>;
    // The call parks on the approval broker (owner's card), as before.
    let parked = false;
    for (let i = 0; i < 100 && !parked; i += 1) {
      parked = approvals.pendingFor("c2").length > 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(parked).toBe(true);
    approvals.decide("c2", "h2", false, undefined, undefined);
    await run;
  });
});

describe("Identity plugin", () => {
  it("declares the entity's name as a section capability", () => {
    const plugin = identityPlugin();
    expect(plugin.id).toBe("ultiv.mind.identity");
    const section = plugin.capabilities[0];
    expect(section?.kind).toBe("section");
    if (section?.kind !== "section") throw new Error("missing section capability");
    expect(section.section.render({} as never, {} as never)).toContain("You are Ultius");
  });
});

describe("bash gating", () => {
  const dir = mkdtempSync(join(tmpdir(), "spriessen-act-bash-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bashTool = (): Tool => {
    const capability = bashPlugin({ root: dir, backend: (_d, home) => localShellBackend(home) })
      .capabilities[0];
    if (capability?.kind !== "tool") throw new Error("missing bash tool");
    return capability.tool;
  };
  const run = (tool: Tool | undefined, script: string, callId: string) =>
    (tool as Tool).execute(
      { script } as never,
      { conversationId: "c", callId } as never,
      {} as never,
    );
  const waitPending = async (approvals: ReturnType<typeof makeApprovals>) => {
    for (let i = 0; i < 100 && approvals.pendingFor("c").length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return approvals.pendingFor("c");
  };

  it("asks before a destructive script and does nothing when denied", async () => {
    const approvals = makeApprovals();
    const gated = actService(registry([bashTool()]), approvals, makeAudit("/dev/null")).tools()[0];
    await bashTool().execute(
      { script: "echo keep > keep.txt" },
      { conversationId: "c" } as never,
      {} as never,
    );
    const pending = run(gated, "rm keep.txt", "k1");
    expect((await waitPending(approvals)).map((request) => request.name)).toEqual(["bash"]);
    approvals.decide("c", "k1", false);
    expect((await pending).isError).toBe(true);
    const check = await bashTool().execute(
      { script: "cat keep.txt" },
      { conversationId: "c" } as never,
      {} as never,
    );
    expect(check.structuredOutput).toMatchObject({ stdout: "keep\n" });
  });

  it("gates a benign command too (whole-tool gate), running it once approved", async () => {
    const approvals = makeApprovals();
    const gated = actService(registry([bashTool()]), approvals, makeAudit("/dev/null")).tools()[0];
    const pending = run(gated, "echo hi", "k2");
    expect(await waitPending(approvals)).toHaveLength(1);
    approvals.decide("c", "k2", true);
    expect((await pending).structuredOutput).toMatchObject({ stdout: "hi\n", exitCode: 0 });
  });

  it("skips the prompt when the profile auto-approves bash", async () => {
    const approvals = makeApprovals();
    approvals.setHooks({ autoApprove: (_conversation, request) => request.name === "bash" });
    const gated = actService(registry([bashTool()]), approvals, makeAudit("/dev/null")).tools()[0];
    const result = await run(gated, "echo auto", "k3");
    expect(approvals.pendingFor("c")).toEqual([]);
    expect(result.structuredOutput).toMatchObject({ stdout: "auto\n" });
  });
});
