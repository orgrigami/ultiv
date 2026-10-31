/**
 * Bot discovery: `bots_list` (the owner's bots, with roles and whether you may
 * message each) and `bot_info` (one bot's public profile). Read-only, no
 * approval; never another bot's memory, files, vault or chats.
 */
import { Effect } from "effect";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@spreissen/ext";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import { findBot, infoText, listLine } from "./bots.ts";
import type { ProfilesService } from "./profiles.ts";
import type { TasksService } from "../tasks/tasks.ts";

export const BOTS_LIST = "bots_list";
export const BOT_INFO = "bot_info";

export interface BotsToolDeps {
  readonly profiles: ProfilesService;
  readonly audit: AuditService;
  /** "busy (2 background tasks)" / "idle", when cheap to know; else null. */
  readonly activity?: (profileId: string) => Promise<string | null>;
}

const meOf = (deps: BotsToolDeps, conversationId: string) =>
  deps.profiles.profileOf(conversationId);

const listTool = (deps: BotsToolDeps) =>
  defineTool({
    name: BOTS_LIST,
    description:
      "List your owner's bots: id, name, one-line role, whether you may message each, and " +
      "their tool groups. Archived bots only with includeArchived.",
    parameters: Type.Object({
      includeArchived: Type.Optional(Type.Boolean({ description: "Also list archived bots." })),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (args, api) => {
      const me = meOf(deps, String(api.conversationId));
      if (me === undefined) return textReply("this conversation belongs to no bot", true);
      const bots = (await deps.profiles.list(me.owner)).filter(
        (bot) => args.includeArchived === true || bot.archivedAt === null,
      );
      return textReply(
        `${bots.length} bot(s):\n${bots.map((bot) => listLine(me, bot)).join("\n")}`,
      );
    },
  });

const infoTool = (deps: BotsToolDeps) =>
  defineTool({
    name: BOT_INFO,
    description:
      "One bot's public profile by name or id: role, persona's first line, whether you may " +
      "message it (and it you), tool groups, busy/idle. Not its memory or files.",
    parameters: Type.Object({ bot: Type.String({ description: "The bot's name or id." }) }),
    callers: ["model"],
    replay: "safe",
    execute: async (args, api) => {
      const me = meOf(deps, String(api.conversationId));
      if (me === undefined) return textReply("this conversation belongs to no bot", true);
      const found = findBot(await deps.profiles.list(me.owner), args.bot);
      if (!("bot" in found)) {
        const close = found.close.length > 0 ? ` Did you mean: ${found.close.join(", ")}?` : "";
        return textReply(`no such bot "${args.bot}".${close} (bots_list shows all)`, true);
      }
      const activity =
        found.bot.archivedAt === null ? ((await deps.activity?.(found.bot.id)) ?? null) : null;
      return textReply(infoText(me, found.bot, activity));
    },
  });

export const botsTools = (deps: BotsToolDeps): ToolRegistration[] => {
  const profileOf = (conversationId: string) => deps.profiles.profileOf(conversationId)?.id ?? null;
  return [listTool(deps), infoTool(deps)].map((tool) =>
    withAudit(deps.audit, tool as unknown as ToolRegistration, profileOf),
  );
};

/** Busy/idle from the in-memory task list: running background tasks per bot. */
export const taskActivity =
  (tasks: TasksService) =>
  async (profileId: string): Promise<string | null> => {
    const all = await Effect.runPromise(tasks.list()).catch(() => null);
    if (all === null) return null;
    const running = all.filter(
      (task) => task.status === "running" && task.bot?.profileId === profileId,
    );
    return running.length > 0 ? `busy (${running.length} background task(s) running)` : "idle";
  };
