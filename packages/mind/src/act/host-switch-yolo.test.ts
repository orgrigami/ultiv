/**
 * Slice 10, phase 6: the switch wins over every approval mode. The act's
 * guard runs BEFORE the approval broker, so a false host-access switch
 * refuses the merged bash tool's beyond-VM targets (`host`, `node`) even in
 * yolo, and leaves a stored exact-command allow rule dormant (not deleted —
 * it applies again the moment the switch turns on). The vm target is
 * ordinary sandboxed work: it never touches the switch.
 */
import { describe, expect, it } from "vite-plus/test";
import type { RegistryService } from "@spriessen/ext";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@spriessen/ext";
import { targetExactEntry, mayAutoApprove } from "../auto-approve.ts";
import { makeApprovals } from "../approvals.ts";
import { makeAudit } from "../audit/audit.ts";
import { actService } from "./act.ts";

const registry = (tools: readonly ToolRegistration[]): RegistryService =>
  ({
    register: () => undefined,
    plugins: () => [],
    tools: () => tools,
    sections: () => [],
    connector: () => undefined,
  }) as never;

const bash = (runs: { script: string; target?: string }[]): ToolRegistration =>
  ({
    ...defineTool({
      name: "bash",
      description: "run a script",
      parameters: Type.Object({
        script: Type.String(),
        target: Type.Optional(
          Type.Union([Type.Literal("vm"), Type.Literal("host"), Type.Literal("node")]),
        ),
      }),
      execute: async (args) => {
        const input = args as { script: string; target?: string };
        runs.push({
          script: input.script,
          ...(input.target === undefined ? {} : { target: input.target }),
        });
        return { output: [{ type: "text", text: "ran" }] };
      },
    }),
    gated: true,
  }) as unknown as ToolRegistration;

const execute = async (
  act: ReturnType<typeof actService>,
  cid: string,
  input: Record<string, unknown>,
) =>
  (await act
    .extension()
    .tools?.find((entry) => entry.name === "bash")
    ?.execute(input as never, { conversationId: cid, callId: "h1" } as never, {} as never)) as {
    isError?: boolean;
    output: { text: string }[];
  };

describe("the switch vs the approval modes", () => {
  const audit = makeAudit("/dev/null");

  it("yolo cannot bypass a false switch on host or node, and no card is parked", async () => {
    const runs: { script: string; target?: string }[] = [];
    const approvals = makeApprovals();
    approvals.setHooks({ autoApprove: () => true }); // yolo
    const act = actService(
      registry([bash(runs)]),
      approvals,
      audit,
      undefined,
      undefined,
      () => false,
    );
    for (const target of ["host", "node"]) {
      const result = await execute(act, "c1", { script: "ls", target });
      expect(result.isError, target).toBe(true);
      expect(result.output[0]?.text).toContain("does not have access to this computer");
    }
    expect(runs).toEqual([]);
    expect(approvals.pendingFor("c1")).toEqual([]);
  });

  it("the vm target never consults the switch, in any mode", async () => {
    const runs: { script: string; target?: string }[] = [];
    const approvals = makeApprovals();
    approvals.setHooks({ autoApprove: () => true }); // yolo
    let consulted = 0;
    const act = actService(registry([bash(runs)]), approvals, audit, undefined, undefined, () => {
      consulted += 1;
      return false;
    });
    const result = await execute(act, "c2", { script: "ls" });
    expect(result.isError).toBeUndefined();
    expect(runs).toEqual([{ script: "ls" }]);
    expect(consulted).toBe(0);
  });

  it("a stored exact allow rule stays dormant while off, and works again when on", async () => {
    const runs: { script: string; target?: string }[] = [];
    const approvals = makeApprovals();
    let allowed = false;
    let consulted = 0;
    approvals.setHooks({
      autoApprove: (cid, request) => {
        consulted += 1;
        return mayAutoApprove([targetExactEntry({ kind: "host" }, "ls")], request);
      },
    });
    const act = actService(
      registry([bash(runs)]),
      approvals,
      audit,
      undefined,
      undefined,
      async () => allowed,
    );
    // Off: the guard refuses before the broker — the rule is never consulted.
    const refused = await execute(act, "c3", { script: "ls", target: "host" });
    expect(refused.isError).toBe(true);
    expect(consulted).toBe(0);
    expect(runs).toEqual([]);
    // On: the same stored rule applies again, with no new card.
    allowed = true;
    const result = await execute(act, "c4", { script: "ls", target: "host" });
    expect(result.isError).not.toBe(true);
    expect(result.output[0]?.text).toBe("ran");
    expect(consulted).toBe(1);
    expect(runs).toEqual([{ script: "ls", target: "host" }]);
    expect(approvals.pendingFor("c4")).toEqual([]);
  });
});
