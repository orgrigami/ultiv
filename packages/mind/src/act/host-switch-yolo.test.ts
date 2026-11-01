/**
 * Slice 10: the switch wins over every approval mode. The act's guard runs
 * BEFORE the approval broker, so a false host-access switch refuses
 * `bash_host` in yolo and leaves a stored exact-command allow rule dormant
 * (not deleted — it applies again the moment the switch turns on).
 */
import { describe, expect, it } from "vite-plus/test";
import type { RegistryService } from "@spriessen/ext";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@spriessen/ext";
import { exactEntry, mayAutoApprove } from "../auto-approve.ts";
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

const bashHost = (runs: string[]): ToolRegistration =>
  ({
    ...defineTool({
      name: "bash_host",
      description: "run on the host",
      parameters: Type.Object({ script: Type.String() }),
      execute: async (args) => {
        runs.push((args as { script: string }).script);
        return { output: [{ type: "text", text: "ran" }] };
      },
    }),
    gated: true,
  }) as unknown as ToolRegistration;

const execute = async (act: ReturnType<typeof actService>, cid: string) =>
  (await act
    .extension()
    .tools?.find((entry) => entry.name === "bash_host")
    ?.execute(
      { script: "ls" } as never,
      { conversationId: cid, callId: "h1" } as never,
      {} as never,
    )) as { isError?: boolean; output: { text: string }[] };

describe("the switch vs the approval modes", () => {
  const audit = makeAudit("/dev/null");

  it("yolo cannot bypass a false switch, and no card is parked", async () => {
    const runs: string[] = [];
    const approvals = makeApprovals();
    approvals.setHooks({ autoApprove: () => true }); // yolo
    const act = actService(
      registry([bashHost(runs)]),
      approvals,
      audit,
      undefined,
      undefined,
      () => false,
    );
    const result = await execute(act, "c1");
    expect(result.isError).toBe(true);
    expect(result.output[0]?.text).toContain("does not have access to this computer");
    expect(runs).toEqual([]);
    expect(approvals.pendingFor("c1")).toEqual([]);
  });

  it("a stored exact allow rule stays dormant while off, and works again when on", async () => {
    const runs: string[] = [];
    const approvals = makeApprovals();
    let allowed = false;
    let consulted = 0;
    approvals.setHooks({
      autoApprove: (cid, request) => {
        consulted += 1;
        return mayAutoApprove([exactEntry("bash_host", "ls")], request);
      },
    });
    const act = actService(
      registry([bashHost(runs)]),
      approvals,
      audit,
      undefined,
      undefined,
      async () => allowed,
    );
    // Off: the guard refuses before the broker — the rule is never consulted.
    const refused = await execute(act, "c2");
    expect(refused.isError).toBe(true);
    expect(consulted).toBe(0);
    expect(runs).toEqual([]);
    // On: the same stored rule applies again, with no new card.
    allowed = true;
    const result = await execute(act, "c3");
    expect(result.isError).not.toBe(true);
    expect(result.output[0]?.text).toBe("ran");
    expect(consulted).toBe(1);
    expect(runs).toEqual(["ls"]);
    expect(approvals.pendingFor("c3")).toEqual([]);
  });
});
