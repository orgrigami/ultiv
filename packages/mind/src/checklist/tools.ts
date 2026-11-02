/**
 * The `checklist` tool: a bot's short task list for the chat it works in.
 * It touches nothing but its own conversation's list (no id or path is ever
 * taken from the model), so it needs no approval. The list lives in one
 * durable doc per conversation, so it survives restarts; the web draws the
 * latest call of each list as one card that updates in place.
 */
import { randomUUID } from "node:crypto";
import { defineDocFamily, type ToolRegistration } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import {
  CHECKLIST_MAX_ITEMS,
  CHECKLIST_TOOL,
  ChecklistParamsSchema,
  type ChecklistDetails,
} from "@spriessen/contracts";
import { defineTool } from "@spriessen/ext";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { applyChecklist, checklistText } from "./checklist.ts";

type ChecklistState = { current: ChecklistDetails | null };

/** One small doc per conversation (keyed by its id), checkpointed on every change. */
export const ChecklistDoc = defineDocFamily<ChecklistState, ChecklistState>({
  kind: "ultiv.checklist",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

export interface ChecklistToolDeps {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  readonly audit: AuditService;
}

export const CHECKLIST_DESCRIPTION =
  "Your visible plan for multi-step work in this chat: the owner sees it as a live " +
  "checklist. Use it only when a request takes 3 or more distinct steps; skip it for " +
  "quick answers and single actions. Start with `items` (the whole list, first step " +
  "in_progress), then tick steps off with `update` ([{ item: 2, status: 'done' }]) " +
  "as you go, keeping exactly one step in_progress while working. Send `items` " +
  `again to re-plan. At most ${CHECKLIST_MAX_ITEMS} short steps.`;

const checklistTool = (deps: ChecklistToolDeps) =>
  defineTool({
    name: CHECKLIST_TOOL,
    description: CHECKLIST_DESCRIPTION,
    parameters: ChecklistParamsSchema,
    // Script-callable (codemode): replay-safe chat surface, no side effects
    // beyond the bot's own visible plan.
    replay: "safe",
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      if (deps.profiles.profileOf(conversationId) === undefined) {
        return textReply("this conversation belongs to no bot", true);
      }
      let applied: ReturnType<typeof applyChecklist> | undefined;
      await Effect.runPromise(
        deps.converse.docs.commit(async (tx) => {
          const draft = await tx.doc(ChecklistDoc, conversationId, { current: null });
          applied = applyChecklist(draft.current ?? undefined, args, randomUUID);
          // A plain copy: draft values die with the transaction.
          if (applied.ok) draft.current = structuredClone(applied.list);
        }),
      );
      if (applied === undefined || !applied.ok) {
        return textReply(`checklist not changed: ${applied?.error ?? "no change"}`, true);
      }
      return { ...textReply(checklistText(applied.list)), details: applied.list };
    },
  });

export const checklistTools = (deps: ChecklistToolDeps): ToolRegistration[] => {
  const profileOf = (conversationId: string) => deps.profiles.profileOf(conversationId)?.id ?? null;
  return [withAudit(deps.audit, checklistTool(deps) as unknown as ToolRegistration, profileOf)];
};
