/**
 * `ask_user_question`: the bot asks its owner one question with tappable
 * options. The card shows in the chat and in Needs you (it parks on the
 * approval broker, owner-only, so no auto-approve rule, Jev or YOLO answers
 * it). The owner's answer comes back through the decide override as
 * `{ answer }` and continues the same turn; dismissing tells the bot to carry
 * on with its own judgement. While it waits, the turn's deadlines pause (the
 * pending approval counts as waiting on the owner).
 *
 * The card never silently disappears: the tool is replay-safe (asking has no
 * side effect), so a server restart re-runs it and the same question parks a
 * fresh card instead of the call reading "interrupted". And a message the
 * owner sends instead of tapping resolves the card as declined
 * (`releaseQuestions`), so the turn goes on and reads that message next
 * rather than waiting a day behind the card.
 */
import { Duration, Effect } from "effect";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@spriessen/ext";
import type { ApprovalsService } from "../approvals.ts";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

export const ASK_USER_QUESTION = "ask_user_question";

/** Long enough for an owner who is away for the day; the card expires after it. */
export const QUESTION_TIMEOUT = Duration.hours(24);
export const MAX_ANSWER_CHARS = 2_000;

export interface QuestionDeps {
  readonly profiles: ProfilesService;
  readonly approvals: ApprovalsService;
  readonly audit: AuditService;
}

/** The owner's answer from a decide override, or undefined when there is none usable. */
export const answerOf = (override: unknown): string | undefined => {
  if (typeof override !== "object" || override === null) return undefined;
  const answer = (override as { answer?: unknown }).answer;
  if (typeof answer !== "string") return undefined;
  const trimmed = answer.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_ANSWER_CHARS);
};

const DISMISSED =
  "the owner dismissed the question or did not answer in time; carry on with your best " +
  "judgement and say what you assumed — do not ask the same question again";

/** The tool result when the owner wrote a message instead of tapping the card. */
export const OWNER_REPLIED =
  "the owner didn't use the card; they sent you a message instead, which comes next — " +
  "read it as their answer and go on (do not ask the same question again)";

/**
 * Decline every question waiting in this conversation because the owner sent
 * a message instead. Other approval cards are left alone. Returns how many
 * questions were released.
 */
export const releaseQuestions = (
  approvals: Pick<ApprovalsService, "pendingFor" | "decide">,
  conversationId: string,
): number => {
  const waiting = approvals
    .pendingFor(conversationId)
    .filter((request) => request.name === ASK_USER_QUESTION);
  for (const request of waiting)
    approvals.decide(conversationId, request.callId, false, OWNER_REPLIED);
  return waiting.length;
};

const Option = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80, description: "What the owner taps." }),
  detail: Type.Optional(
    Type.String({ maxLength: 200, description: "One line under the option, if it helps." }),
  ),
});

const toolOf = (deps: QuestionDeps) =>
  defineTool({
    name: ASK_USER_QUESTION,
    description:
      "Ask your owner one question when you can't sensibly go on without their choice. They " +
      "get a card with the options as buttons (and a box for their own answer unless " +
      "allow_other is false); the answer comes back as this tool's result and you continue. " +
      "Keep options short and distinct. Not for approvals of your own actions (those ask by " +
      "themselves) and never for keys or passwords (use secret_request).",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 300 }),
      options: Type.Array(Option, { minItems: 2, maxItems: 6 }),
      allow_other: Type.Optional(
        Type.Boolean({ description: "Let the owner type their own answer (default true)." }),
      ),
    }),
    // Script-callable (codemode): a script may ask mid-flight and branch on
    // the answer — the card parks the script and resumes on reply.
    // Asking has no side effect: after a restart the call runs again and the
    // card comes back, instead of the question being lost as "interrupted".
    replay: "safe",
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      if (deps.profiles.scopeOf(conversationId) === undefined)
        return textReply("this conversation belongs to no bot", true);
      const input = {
        question: args.question.trim(),
        options: args.options.map((option) => ({
          label: option.label.trim(),
          ...(option.detail !== undefined && option.detail.trim() !== ""
            ? { detail: option.detail.trim() }
            : {}),
        })),
        allowOther: args.allow_other !== false,
      };
      const approved = await Effect.runPromise(
        deps.approvals.request(
          conversationId,
          api.callId,
          { callId: api.callId, name: ASK_USER_QUESTION, input },
          { owner: true, timeout: QUESTION_TIMEOUT },
        ),
      );
      const note = deps.approvals.noteFor(conversationId, api.callId);
      const answer = approved
        ? answerOf(deps.approvals.overrideFor(conversationId, api.callId))
        : undefined;
      if (answer === undefined) return textReply(note ?? DISMISSED, true);
      const picked = input.options.findIndex((option) => option.label === answer);
      if (!input.allowOther && picked < 0) return textReply(DISMISSED, true);
      return textReply(
        picked >= 0
          ? `The owner chose option ${picked + 1}: ${answer}`
          : `The owner answered in their own words: ${answer}`,
      );
    },
  });

export const questionTools = (deps: QuestionDeps): readonly ToolRegistration[] => {
  const profileOf = (conversationId: string): string | null =>
    deps.profiles.profileOf(conversationId)?.id ?? null;
  return [withAudit(deps.audit, toolOf(deps) as unknown as ToolRegistration, profileOf)];
};
