/**
 * The `react` tool: a bot attaches one emoji from the fixed 12-name ack
 * vocabulary to the owner's message instead of writing prose. Reactions live
 * in one durable doc per conversation (`ultiv.reactions`), keyed by the
 * transcript entry id the web renders; the web reads them through plain REST
 * and joins them to the transcript by entry id. Model-callable only
 * (`callers: ["model"]`), and it rides the registry, not the allowlist
 * catalog: every bot has it, allowlisted or not.
 */
import { defineDocFamily, type ToolRegistration } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import {
  REACTION_EMOJI,
  REACTIONS_TOOL,
  ReactionParamsSchema,
  type ReactionRow,
} from "@spriessen/contracts";
import { defineTool } from "@spriessen/ext";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import { stepIdOf } from "../converse/steps.ts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { applyReaction, isOwnerEntry } from "./reactions.ts";

type ReactionsState = { rows: ReactionRow[] };

/** One doc per conversation (keyed by its id); rows join the web transcript. */
export const ReactionsDoc = defineDocFamily<ReactionsState, ReactionsState>({
  kind: "ultiv.reactions",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

export interface ReactionsToolDeps {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  readonly audit?: AuditService | undefined;
}

export const REACT_DESCRIPTION =
  "React INSTEAD of replying when the owner's message needs no prose: `react` attaches " +
  "one emoji to their message and the owner sees it on their own bubble. The names are " +
  "fixed, one fits the message: ack (understood, nothing to answer), seen (read it, " +
  "will come back to it), done (the asked thing is complete), working (on it, will " +
  "report when there is something to say), declined (will not do it; also say a short " +
  "reason in text), clarify (need more input; also ask in text), caveat (done but with " +
  "a warning or partial result; also explain in text), blocked (waiting on something " +
  "outside my control), noted (stored to memory, no response needed), recurs (this " +
  "repeats or is scheduled, no action needed), shipped (a milestone landed), agreed " +
  "(commitment accepted, deal). React AND reply briefly whenever semantics demand " +
  "words (declined, caveat, clarify). React only to the OWNER's messages. One reaction " +
  "per message: reacting again replaces the earlier one.";

type EntryLike = { readonly id: number; readonly kind: string };

/** The owner-message transcript ids of a conversation, oldest first. */
const reactableIds = async (
  converse: ConverseService,
  conversationId: string,
): Promise<number[]> => {
  const entries = (await Effect.runPromise(
    converse.entriesOf(conversationId, 500),
  )) as readonly EntryLike[];
  return entries
    .filter((entry) => isOwnerEntry(entry.kind))
    .map((entry) => stepIdOf(entry.id))
    .reverse();
};

const refuseOf = (cause: unknown): string =>
  (cause as { what?: string }).what ?? String(cause).slice(0, 200);

const reactTool = (deps: ReactionsToolDeps) =>
  defineTool({
    name: REACTIONS_TOOL,
    description: REACT_DESCRIPTION,
    parameters: ReactionParamsSchema,
    callers: ["model"],
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      if (deps.profiles.profileOf(conversationId) === undefined) {
        return textReply("this conversation belongs to no bot", true);
      }
      const ids = await reactableIds(deps.converse, conversationId);
      // Default target: the most recent owner message (newest first above).
      const target = args.target ?? ids[ids.length - 1];
      if (target === undefined) {
        return textReply("no owner message to react to yet", true);
      }
      // Unknown or foreign entries are refused before anything is written
      // (the docs layer would wrap the kernel NotFound into an External).
      if (!ids.includes(target)) {
        return textReply(`no message ${String(target)} to react to here`, true);
      }
      const reactorProfileId = deps.profiles.profileOf(conversationId)?.id ?? "";
      const outcome = await Effect.runPromise(
        deps.converse.docs.commit(async (tx) => {
          const draft = await tx.doc(ReactionsDoc, conversationId, { rows: [] });
          const applied = applyReaction(
            draft.rows,
            { emoji: args.emoji, target },
            reactorProfileId,
            ids,
          );
          // A plain copy: draft values die with the transaction.
          if (applied.ok) draft.rows = structuredClone(applied.rows);
          return applied;
        }),
      ).catch((cause) => ({ ok: false as const, error: refuseOf(cause) }));
      if (!outcome.ok) return textReply(`reaction not saved: ${outcome.error}`, true);
      return {
        ...textReply(`${REACTION_EMOJI[args.emoji]} ${args.emoji}: reaction saved.`),
        details: { entryId: outcome.entryId, emoji: args.emoji },
      };
    },
  });

export const reactTools = (deps: ReactionsToolDeps): ToolRegistration[] => {
  const tool = reactTool(deps) as unknown as ToolRegistration;
  const profileOf = (conversationId: string) => deps.profiles.profileOf(conversationId)?.id ?? null;
  return [deps.audit === undefined ? tool : withAudit(deps.audit, tool, profileOf)];
};
