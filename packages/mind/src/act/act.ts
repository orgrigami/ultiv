/**
 * The Act faculty: the mind's executable tool surface, assembled from the
 * extension registry — tools (gated ones through the approval broker at the
 * act; gates ACTS, never ASKS) and prompt sections contributed by plugins
 * (identity and anything the app adds).
 */
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { RegistryService, Tool } from "@spriessen/ext";
import { HOST_REFUSAL, isBeyondVmCall } from "../org/host-switch.ts";
import { withApproval, type ApprovalsService } from "../approvals.ts";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { withTaskNudge, type NudgeGate } from "./nudge.ts";

export interface ActService {
  readonly tools: () => readonly Tool[];
  /** The extension installed into the harness registry for every conversation. */
  readonly extension: () => Extension;
}

export const actService = (
  registry: RegistryService,
  approvals: ApprovalsService,
  audit: AuditService,
  profileOf?: (conversationId: string) => string | null | undefined,
  /** Set when the tasks faculty is present: long stretches get nudged to it. */
  nudge?: NudgeGate | undefined,
  /**
   * The host capability, resolved per conversation (undefined = the owner's
   * bots keep today's behaviour). A beyond-VM call (bash targeting `host`
   * or `node`) refused here never reaches a card: the call comes back
   * refused to the model.
   */
  hostAccess?: (conversationId: string) => boolean | Promise<boolean>,
): ActService => {
  const gate = (tool: Tool): Tool => {
    if (tool.gated !== true) return tool;
    const guard =
      hostAccess !== undefined
        ? async (args: unknown, api: unknown): Promise<string | undefined> =>
            isBeyondVmCall(tool.name, args) &&
            !(await hostAccess(String((api as { conversationId?: unknown }).conversationId ?? "")))
              ? HOST_REFUSAL
              : undefined
        : undefined;
    return withApproval(approvals, tool, guard !== undefined ? { guard } : undefined);
  };
  const tools: readonly Tool[] = registry
    .tools()
    .map(gate)
    .map((tool) =>
      profileOf === undefined ? withAudit(audit, tool) : withAudit(audit, tool, profileOf),
    )
    .map((tool) => (nudge === undefined ? tool : withTaskNudge(tool, nudge)));
  const extension = defineExtension({
    name: "ultius.act",
    tools,
    sections: registry.sections(),
  });
  return {
    tools: () => tools,
    extension: () => extension,
  };
};
