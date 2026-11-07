/**
 * The `react` tool: a bot puts one of four reactions on the owner's latest
 * message. Nothing is stored apart from the call: the result's `details`
 * carry the transcript id it marks, and the web reads the chip from the
 * transcript it already holds. `ok`, `no` and `done` end the turn
 * (`control.terminate`), so a reaction-only reply costs ONE model request,
 * not two; `looking` lets the turn go on, an early ack of work the bot is
 * about to do. Model-callable only; it rides the registry, not the allowlist
 * catalog: every bot has it.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import {
  ENDS_TURN,
  REACTION_EMOJI,
  REACTIONS_TOOL,
  ReactionParamsSchema,
  type ReactionDetails,
} from "@spriessen/contracts";
import { defineTool } from "@spriessen/ext";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import { projectTranscript } from "../converse/steps.ts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { latestOwnerMessage } from "./reactions.ts";

export interface ReactionsToolDeps {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  readonly audit?: AuditService | undefined;
}

/** How far back the owner's latest message is looked for. */
const SCAN = 200;

export const REACT_DESCRIPTION =
  "Put a reaction on the owner's latest message when it needs no written reply: " +
  "ok 👍 (understood or agreed), no 👎 (won't do it), done ✅ (the asked thing is done). " +
  "These END your turn: write any words in the same message, before the call. " +
  "looking 👀 = you are starting on it now; your turn goes on. " +
  "Never react instead of an answer the owner asked for.";

/** The transcript id of the owner's latest message in this conversation. */
const latestTarget = async (
  converse: ConverseService,
  conversationId: string,
): Promise<number | undefined> => {
  const newestFirst = await Effect.runPromise(converse.entriesOf(conversationId, SCAN));
  return latestOwnerMessage(projectTranscript([...newestFirst].reverse(), undefined, false));
};

const reactTool = (deps: ReactionsToolDeps) =>
  defineTool({
    name: REACTIONS_TOOL,
    description: REACT_DESCRIPTION,
    parameters: ReactionParamsSchema,
    callers: ["model"],
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const scope = deps.profiles.scopeOf(conversationId);
      if (scope === undefined) return textReply("this conversation belongs to no bot", true);
      if (scope.kind === "task") {
        return textReply("a task has no owner message to react to: report in your result", true);
      }
      const target = await latestTarget(deps.converse, conversationId);
      if (target === undefined) return textReply("no owner message to react to yet", true);
      const details: ReactionDetails = { target, reaction: args.reaction };
      return {
        ...textReply(`${REACTION_EMOJI[args.reaction]} shown on the owner's message.`),
        details,
        ...(ENDS_TURN.has(args.reaction) ? { control: { terminate: true } } : {}),
      };
    },
  });

export const reactTools = (deps: ReactionsToolDeps): ToolRegistration[] => {
  const tool = reactTool(deps) as unknown as ToolRegistration;
  const profileOf = (conversationId: string) => deps.profiles.profileOf(conversationId)?.id ?? null;
  return [deps.audit === undefined ? tool : withAudit(deps.audit, tool, profileOf)];
};
