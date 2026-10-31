/**
 * `bot_create`: the owner's main bot mints a new bot. The gate is the owner's
 * alone: the card always parks on the owner (auto-approve rules and the Jev
 * judge are skipped), the proposed fields are editable on the card, and the
 * wait is generous (a form takes typing). A non-main bot is refused before
 * any card.
 */
import { Duration } from "effect";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { InvalidInput } from "@spreissen/core";
import type { ProfileCreate } from "@spreissen/contracts";
import { defineTool } from "@spreissen/ext";
import { withApproval, type ApprovalsService } from "../approvals.ts";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import { defaultPolicies } from "./docs.ts";
import type { ProfilesService } from "./profiles.ts";

export const BOT_CREATE = "bot_create";

export interface BotCreateDeps {
  readonly profiles: ProfilesService;
  readonly approvals: ApprovalsService;
  readonly audit: AuditService;
}

/** The tool's args; empty model/effort strings mean the defaults. */
export interface BotCreateArgs {
  readonly name: string;
  readonly title?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly sandbox?: boolean;
}

/** The card's fields as a ProfileCreate: each field is trimmed, empty means default. */
export const createInputOf = (args: BotCreateArgs): ProfileCreate => {
  const title = args.title?.trim() ?? "";
  const persona = args.persona?.trim() ?? "";
  const model = args.model?.trim() ?? "";
  const effort = args.effort?.trim() ?? "";
  return {
    name: args.name,
    ...(title !== "" ? { description: title } : {}),
    ...(persona !== "" ? { persona } : {}),
    ...(model !== "" ? { model: { id: model, effort } } : {}),
    // create() merges policies over its own defaults; the fresh spread keeps
    // this object type-honest (full ProfilePolicies) without pinning values.
    ...(args.sandbox === false ? { policies: { ...defaultPolicies(), sandbox: false } } : {}),
  };
};

/** Refusal before any card: no bot behind the conversation, or not the main one. */
export const mainGuardOf = (deps: BotCreateDeps) => {
  return async (_args: unknown, api: unknown): Promise<string | undefined> => {
    const me = deps.profiles.profileOf(String((api as { conversationId: unknown }).conversationId));
    if (me === undefined) return "this conversation belongs to no bot";
    if ((await deps.profiles.mainOf(me.owner)) !== me.id) {
      return (
        "only your owner's main bot can create bots; tell the owner to create it " +
        "themselves (the Bots page or the switcher)"
      );
    }
    return undefined;
  };
};

const toolOf = (deps: BotCreateDeps) =>
  defineTool({
    name: BOT_CREATE,
    description:
      "Create a new bot for your owner. Only you, the owner's main bot, may call this; " +
      "the owner confirms on a card in the chat and can edit every field before it is " +
      "created. The new bot introduces itself in its own main chat right away.",
    parameters: Type.Object({
      name: Type.String({ description: "The new bot's name.", minLength: 1, maxLength: 80 }),
      title: Type.Optional(
        Type.String({ description: "One-line title/role for the bot.", maxLength: 500 }),
      ),
      persona: Type.Optional(
        Type.String({ description: "Personality and instructions, free text.", maxLength: 8_000 }),
      ),
      model: Type.Optional(
        Type.String({ description: 'Model ref "provider/model"; empty = workspace default.' }),
      ),
      effort: Type.Optional(
        Type.String({ description: "Thinking effort for the model; empty = the model default." }),
      ),
      sandbox: Type.Optional(
        Type.Boolean({ description: "Own sandbox (bash in a microVM)? Default true." }),
      ),
    }),
    callers: ["model"],
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const me = deps.profiles.profileOf(conversationId);
      if (me === undefined) return textReply("this conversation belongs to no bot", true);
      if ((await deps.profiles.mainOf(me.owner)) !== me.id) {
        return textReply("only the main bot can create bots", true);
      }
      const input = createInputOf(args);
      try {
        const profile = await deps.profiles.create(me.owner, input);
        return textReply(
          `created bot "${profile.name}" (id: ${profile.id}).` +
            " It is introducing itself in its own main chat now; tell the owner it is live.",
        );
      } catch (cause) {
        const message =
          cause instanceof InvalidInput
            ? cause.reason
            : cause instanceof Error
              ? cause.message
              : String(cause);
        return textReply(`not created: ${message}; fix the fields and call again`, true);
      }
    },
  });

export const botCreateTools = (deps: BotCreateDeps): readonly ToolRegistration[] => {
  const profileOf = (conversationId: string): string | null =>
    deps.profiles.profileOf(conversationId)?.id ?? null;
  return [
    withAudit(
      deps.audit,
      withApproval(deps.approvals, toolOf(deps), {
        owner: true,
        editable: true,
        guard: mainGuardOf(deps),
        timeout: Duration.minutes(10),
      }),
      profileOf,
    ),
  ];
};
