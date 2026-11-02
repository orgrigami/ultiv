/**
 * The main bot's bot-management tools: `bot_details`, `bot_update` (name,
 * role, persona, Instructions, model, tools), `bot_move` (between homes),
 * `bot_pause` (pause or resume) and `bot_delete`. Main bot only (common.ts).
 * An update and a delete park an owner card first: an update rewrites what
 * another bot follows or may use, a delete purges it. The home rules hold
 * here as everywhere (the profiles service asks them): the main bot stays
 * in the org, the org keeps a bot. Host-access switches are never read
 * from the model; the approval mode is not offered at all.
 */
import { Duration } from "effect";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ProfileCreate, ProfileInfo } from "@spriessen/contracts";
import { InvalidInput } from "@spriessen/core";
import { defineTool } from "@spriessen/ext";
import { withApproval } from "../approvals.ts";
import { withAudit } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import { homeRuleProblem } from "../org/home-rules.ts";
import { readBotDetails } from "./bot-details.ts";
import {
  adminGuard,
  adminOf,
  auditChange,
  failed,
  orgOf,
  resolveBot,
  resolveHome,
  homeWords,
  type AdminDeps,
} from "./common.ts";

export const BOT_DETAILS = "bot_details";
export const BOT_UPDATE = "bot_update";
export const BOT_MOVE = "bot_move";
export const BOT_PAUSE = "bot_pause";
export const BOT_DELETE = "bot_delete";

const botParam = Type.String({ description: "The bot's name or id (bots_list shows them)." });

const detailsTool = (deps: AdminDeps) =>
  defineTool({
    name: BOT_DETAILS,
    description:
      "One bot's full settings: home, role, model and effort, tool allowlist, sandbox, paused, " +
      "whether it is main, its host-access switch (read only) and the start of its persona and " +
      "Instructions. Main bot only. Read this before bot_update so you change the right thing.",
    // Read-only, so script-callable: the main-bot-only rule stays in execute
    // (adminOf reads the live org view per call) — a script gets the same
    // word-for-word refusal a direct call would.
    parameters: Type.Object({ bot: botParam }),
    replay: "safe",
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("read", me);
      try {
        const bot = await resolveBot(deps, me.owner, args.bot);
        return textReply(await readBotDetails(deps, bot));
      } catch (cause) {
        return failed("read", cause);
      }
    },
  });

export interface BotUpdateArgs {
  readonly name?: string;
  readonly role?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: readonly string[] | "all";
}

/** The model's fields as a profile patch: only these keys, never a home, a switch or a mode. */
export const updatePatchOf = (args: BotUpdateArgs, bot: ProfileInfo): Partial<ProfileCreate> => {
  const name = args.name?.trim();
  if (name === "") throw new InvalidInput({ reason: "the new name is empty" });
  const model = args.model?.trim();
  const effort = args.effort?.trim();
  const modelId = model !== undefined && model !== "" ? model : bot.model?.id;
  if (effort !== undefined && effort !== "" && modelId === undefined) {
    throw new InvalidInput({
      reason: "set a model with the effort (the bot uses the default model)",
    });
  }
  const tools = args.tools;
  if (
    Array.isArray(tools) &&
    tools.some((tool) => typeof tool !== "string" || tool.trim() === "")
  ) {
    throw new InvalidInput({ reason: 'tools is a list of tool names, or "all"' });
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(args.role !== undefined ? { description: args.role.trim() } : {}),
    ...(args.persona !== undefined ? { persona: args.persona } : {}),
    ...((model !== undefined || (effort !== undefined && effort !== "")) && modelId !== undefined
      ? { model: { id: modelId, effort: effort ?? bot.model?.effort ?? "" } }
      : {}),
    ...(tools === "all" ? { toolAllowlist: null } : {}),
    ...(Array.isArray(tools) ? { toolAllowlist: tools.map((tool) => tool.trim()) } : {}),
  };
};

const updateTool = (deps: AdminDeps) =>
  defineTool({
    name: BOT_UPDATE,
    description:
      "Change another bot's name, role, persona, Instructions, model/effort or tool allowlist. " +
      "Main bot only; the owner confirms on a card. Give only the fields to change; persona and " +
      'Instructions replace the old text entirely. tools: a list of tool names, or "all". ' +
      "To change a bot's home use bot_move; host access is the owner's alone.",
    parameters: Type.Object({
      bot: botParam,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      role: Type.Optional(Type.String({ maxLength: 500, description: "One-line role." })),
      persona: Type.Optional(Type.String({ maxLength: 8_000 })),
      instructions: Type.Optional(Type.String({ maxLength: 16_000 })),
      model: Type.Optional(Type.String({ description: 'Model ref "provider/model".' })),
      effort: Type.Optional(Type.String({ description: "Thinking effort for the model." })),
      tools: Type.Optional(
        Type.Union([Type.Array(Type.String(), { maxItems: 200 }), Type.Literal("all")]),
      ),
    }),
    callers: ["model"],
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("changed", me);
      try {
        const bot = await resolveBot(deps, me.owner, args.bot);
        const patch = updatePatchOf(args, bot);
        const meta = { by: "bot" as const, reason: `Edited by ${me.name}` };
        const next =
          Object.keys(patch).length > 0
            ? await deps.profiles.update(me.owner, bot.id, patch, meta)
            : bot;
        if (args.instructions !== undefined) {
          if (deps.profiles.files === undefined)
            return failed("changed", "Instructions are not available here");
          deps.profiles.files.save(next, "instructions", args.instructions, meta);
        }
        auditChange(deps, bot.id, "bot-updated");
        return textReply(`updated bot "${next.name}"; it uses the change from its next turn.`);
      } catch (cause) {
        return failed("changed", cause);
      }
    },
  });

const moveTool = (deps: AdminDeps) =>
  defineTool({
    name: BOT_MOVE,
    description:
      'Move a bot to another home: a department (name or id) or "org". Main bot only. The bot ' +
      "follows its new department's Instructions from its next turn. Refused for the main bot " +
      "(it stays in the org) and for the org's last bot.",
    parameters: Type.Object({
      bot: botParam,
      to: Type.String({ description: 'A department name or id, or "org".' }),
    }),
    callers: ["model"],
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("moved", me);
      try {
        const bot = await resolveBot(deps, me.owner, args.bot);
        const to = await resolveHome(deps, args.to);
        if ((bot.departmentId ?? null) === to)
          return textReply(`"${bot.name}" already lives there.`);
        await deps.profiles.update(me.owner, bot.id, { departmentId: to });
        auditChange(deps, bot.id, "bot-moved");
        const view = await orgOf(deps).view();
        return textReply(
          `moved "${bot.name}" to ${homeWords(to, view.departments, view.org?.name ?? "Personal")}.`,
        );
      } catch (cause) {
        return failed("moved", cause);
      }
    },
  });

const pauseTool = (deps: AdminDeps) =>
  defineTool({
    name: BOT_PAUSE,
    description:
      "Pause a bot (it stops taking messages and turns; nothing is deleted) or resume it with " +
      "paused false. Main bot only. The main bot and the org's last bot cannot be paused.",
    parameters: Type.Object({
      bot: botParam,
      paused: Type.Boolean({ description: "true to pause, false to resume." }),
    }),
    callers: ["model"],
    execute: async (args, api) => {
      const verb = args.paused ? "paused" : "resumed";
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed(verb, me);
      try {
        const bot = await resolveBot(deps, me.owner, args.bot);
        await deps.profiles.setArchived(me.owner, bot.id, args.paused);
        auditChange(deps, bot.id, args.paused ? "bot-paused" : "bot-resumed");
        return textReply(`${verb} "${bot.name}".`);
      } catch (cause) {
        return failed(verb, cause);
      }
    },
  });

/** Why this bot may not be deleted (main bot, the org's last bot); undefined when it may. */
export const deleteBotProblem = async (deps: AdminDeps, owner: string, bot: ProfileInfo) => {
  const rows = await deps.profiles.list(owner);
  const mainId = await deps.profiles.mainOf(owner);
  return homeRuleProblem(rows, owner, mainId, { kind: "remove", id: bot.id }) ?? undefined;
};

const deleteTool = (deps: AdminDeps) =>
  defineTool({
    name: BOT_DELETE,
    description:
      "Delete a bot for good: its chats, memory, files and schedules go with it. Main bot only; " +
      "the owner confirms on a card. Prefer bot_pause when it may be wanted again. Refused for " +
      "the main bot and the org's last bot.",
    parameters: Type.Object({ bot: botParam }),
    callers: ["model"],
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("deleted", me);
      try {
        const bot = await resolveBot(deps, me.owner, args.bot);
        const problem = await deleteBotProblem(deps, me.owner, bot);
        if (problem !== undefined) return failed("deleted", problem);
        await (deps.admin?.purgeBot?.(me.owner, bot.id) ?? deps.profiles.remove(me.owner, bot.id));
        auditChange(deps, bot.id, "bot-removed");
        return textReply(`deleted bot "${bot.name}".`);
      } catch (cause) {
        return failed("deleted", cause);
      }
    },
  });

/** Refused before the card: not the main bot, an unknown bot, or one the rules keep. */
const deleteGuard = (deps: AdminDeps) => async (args: unknown, api: unknown) => {
  const refused = await adminGuard(deps)(args, api);
  if (refused !== undefined) return refused;
  const me = deps.profiles.profileOf(String((api as { conversationId: unknown }).conversationId));
  try {
    const bot = await resolveBot(
      deps,
      me?.owner ?? "",
      String((args as { bot?: unknown }).bot ?? ""),
    );
    const problem = await deleteBotProblem(deps, me?.owner ?? "", bot);
    return problem === undefined ? undefined : `not deleted: ${problem}`;
  } catch (cause) {
    return `not deleted: ${(cause as { reason?: string }).reason ?? String(cause)}`;
  }
};

export const botAdminTools = (deps: AdminDeps): readonly ToolRegistration[] => {
  const profileOf = (conversationId: string): string | null =>
    deps.profiles.profileOf(conversationId)?.id ?? null;
  const card = { owner: true, timeout: Duration.minutes(10) } as const;
  return [
    withAudit(deps.audit, detailsTool(deps), profileOf),
    withAudit(
      deps.audit,
      withApproval(deps.approvals, updateTool(deps), { ...card, guard: adminGuard(deps) }),
      profileOf,
    ),
    withAudit(deps.audit, moveTool(deps), profileOf),
    withAudit(deps.audit, pauseTool(deps), profileOf),
    withAudit(
      deps.audit,
      withApproval(deps.approvals, deleteTool(deps), { ...card, guard: deleteGuard(deps) }),
      profileOf,
    ),
  ];
};
