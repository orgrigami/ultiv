/**
 * `bot_create`: the owner's main bot mints a new bot. The main bot's own call
 * runs WITHOUT a card (`ownerUnlessMain` — assembling crew is its job); any
 * other may-administer actor parks an owner card (auto-approve rules and the
 * Jev judge are skipped), the proposed fields are editable on the card, and
 * the wait is generous (a form takes typing). Any other bot gets the admin
 * tools' one refusal before any card (admin/common.ts), and so does a
 * department that does not exist. The new bot's host-access switch starts
 * off and is never read from the model: only the owner turns it on.
 */
import { Duration } from "effect";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { InvalidInput } from "@spriessen/core";
import type { ProfileCreate } from "@spriessen/contracts";
import { defineTool } from "@spriessen/ext";
import { withApproval } from "../approvals.ts";
import { withAudit } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import {
  adminGuard,
  adminOf,
  failed,
  homeWords,
  orgOf,
  resolveHome,
  type AdminDeps,
} from "../admin/common.ts";
import { defaultPolicies } from "./docs.ts";

export const BOT_CREATE = "bot_create";

export type BotCreateDeps = AdminDeps;

/** The tool's args; empty strings mean the defaults. */
export interface BotCreateArgs {
  readonly name: string;
  /** The one-line role (stored as the bot's description). */
  readonly title?: string;
  readonly persona?: string;
  readonly instructions?: string;
  /** A department name or id; empty or "org" = an org bot. */
  readonly department?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly sandbox?: boolean;
  /** Tool names the bot may use; absent = all installed tools. */
  readonly tools?: readonly string[];
}

/** The card's fields as a ProfileCreate (home and Instructions apart): trimmed, empty = default. */
export const createInputOf = (args: BotCreateArgs): ProfileCreate => {
  const title = args.title?.trim() ?? "";
  const persona = args.persona?.trim() ?? "";
  const model = args.model?.trim() ?? "";
  const effort = args.effort?.trim() ?? "";
  const tools = (args.tools ?? []).map((tool) => tool.trim()).filter((tool) => tool !== "");
  if (effort !== "" && model === "") {
    throw new InvalidInput({ reason: "set a model with the effort, or leave both empty" });
  }
  return {
    name: args.name,
    ...(title !== "" ? { description: title } : {}),
    ...(persona !== "" ? { persona } : {}),
    ...(model !== "" ? { model: { id: model, effort } } : {}),
    ...(tools.length > 0 ? { toolAllowlist: tools } : {}),
    // create() merges policies over its own defaults; the fresh spread keeps
    // this object type-honest (full ProfilePolicies) without pinning values.
    ...(args.sandbox === false ? { policies: { ...defaultPolicies(), sandbox: false } } : {}),
  };
};

/** Refused before any card: not the main bot, or a home that does not exist. */
export const mainGuardOf = (deps: BotCreateDeps) => async (args: unknown, api: unknown) => {
  const refused = await adminGuard(deps)(args, api);
  if (refused !== undefined) return refused;
  try {
    createInputOf(args as BotCreateArgs);
    await resolveHome(deps, (args as BotCreateArgs).department);
    return undefined;
  } catch (cause) {
    return `not created: ${(cause as { reason?: string }).reason ?? String(cause)}`;
  }
};

const parameters = Type.Object({
  name: Type.String({ description: "The new bot's name.", minLength: 1, maxLength: 80 }),
  title: Type.Optional(
    Type.String({ description: "Its one-line role, e.g. 'Researches suppliers'.", maxLength: 500 }),
  ),
  department: Type.Optional(
    Type.String({
      description:
        'Its home: a department name or id (departments_list shows them), or "org" / empty for ' +
        "an org bot. It follows its department's Instructions.",
    }),
  ),
  persona: Type.Optional(
    Type.String({ description: "Who it is: personality and voice, free text.", maxLength: 8_000 }),
  ),
  instructions: Type.Optional(
    Type.String({ description: "How it works: standing rules for its job.", maxLength: 16_000 }),
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
  tools: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 200,
      description: "Tool names it may use; leave out for all installed tools.",
    }),
  ),
});

const toolOf = (deps: BotCreateDeps) =>
  defineTool({
    name: BOT_CREATE,
    description:
      "Create a new bot for your owner. Main bot only; it runs directly (no card), and your " +
      "owner sees the new bot in Crew and can edit every field there. Ask " +
      "the owner what the bot is for, " +
      "then propose a name, a one-line role, its home (a department, or the org), a short " +
      "persona and Instructions. Host access starts off (the owner's switch). The new bot " +
      "introduces itself in its own main chat right away.",
    parameters,
    callers: ["model"],
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("created", me);
      try {
        const departmentId = await resolveHome(deps, args.department);
        const input = { ...createInputOf(args), departmentId };
        const profile = await deps.profiles.create(me.owner, input);
        const instructions = args.instructions?.trim() ?? "";
        if (instructions !== "") {
          deps.profiles.files?.save(profile, "instructions", instructions, {
            by: "bot",
            reason: `Written by ${me.name} at creation`,
          });
        }
        const view = await orgOf(deps).view();
        const home = homeWords(departmentId, view.departments, view.org?.name ?? "Personal");
        return textReply(
          `created bot "${profile.name}" (id: ${profile.id}) in ${home}.` +
            " It is introducing itself in its own main chat now; tell the owner it is live.",
        );
      } catch (cause) {
        return failed("created", cause, "fix the fields and call again");
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
        ownerUnlessMain: true,
        editable: true,
        guard: mainGuardOf(deps),
        timeout: Duration.minutes(10),
      }),
      profileOf,
    ),
  ];
};
