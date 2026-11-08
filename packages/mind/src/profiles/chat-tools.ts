/**
 * Chats coordinate, tasks work. A bot's chats (main, sessions, DM threads,
 * webhook threads: every conversation that is not a task) are offered only
 * the tools that talk, remember, plan and administer; the tools that read
 * or act on the world (web, shell, files, code, outside requests, connector
 * tools, codemode) are offered only in its task conversations. So work goes
 * to a task (`task_spawn`) by the shape of the chat, not by the model's
 * judgment of what is "quick" — prompting alone does not get a model to
 * delegate reliably.
 *
 * Two layers: the chat's stored `modelTools` filter is exactly this list (by
 * name, so a tool installed later never widens it), and a `beforeTool` hook
 * refuses any other tool a chat calls anyway — a filter written before an
 * upgrade, or a nested call.
 */
import type { AgentChange } from "@earendil-works/pi-durable";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { SessionKind } from "@spriessen/contracts";

/** Every tool a chat may call; anything else runs in a task. */
export const CHAT_TOOLS: readonly string[] = [
  // Handing work off and following it.
  "task_spawn",
  "task_message",
  "task_status",
  "task_list",
  "task_cancel",
  // Talking: the owner, other bots, the plan on screen.
  "ask_user_question",
  "message",
  "room",
  "react",
  "checklist",
  "graph",
  "now",
  // The bot's own judgment.
  "jev",
  "jev_score",
  "jev_pick",
  "jev_rate",
  // Memory and its own past chats.
  "memory_core",
  "memory_recall",
  "memory_write",
  "memory_update",
  "memory_forget",
  "memory_history",
  "memory_related",
  "history_search",
  "state_get",
  "state_set",
  "state_list",
  "state_delete",
  // Goals, routines, triggers.
  "project",
  "schedule_set",
  "schedule_list",
  "schedule_remove",
  "sensor_set",
  "sensor_list",
  "sensor_remove",
  "webhook_create",
  "webhook_list",
  "webhook_remove",
  // Skills (the library, not the work they describe).
  "skill_list",
  "skill_load",
  "skill_file",
  "skill_write",
  "skill_edit",
  "skill_learn",
  "skill_delete",
  "skill_install",
  "skill_propose",
  "skill_evolve",
  // Administration: connectors, credentials, files on record, bots, teams.
  "connector_list",
  "connector_add",
  "connector_update",
  "connector_reconnect",
  "secret_request",
  "vault_list",
  "vault_contacts",
  "artifact_list",
  "artifact_delete",
  "bots_list",
  "bot_info",
  "bot_create",
  "bot_details",
  "bot_update",
  "bot_move",
  "bot_pause",
  "bot_delete",
  "teams_list",
  "team_create",
  "team_update",
  "team_delete",
];

const CHAT_SET = new Set(CHAT_TOOLS);

/** Whether a conversation of this kind is a chat (coordinates) rather than a task (works). */
export const isChatKind = (kind: SessionKind | undefined): boolean =>
  kind !== undefined && kind !== "task";

/** Whether a chat may call this tool. */
export const chatMayCall = (name: string): boolean => CHAT_SET.has(name);

/**
 * The chat's `modelTools` filter: exactly the chat tools, by name. Names the
 * registry does not have are inert, so the list never needs the registry.
 */
export const chatModelTools = (): NonNullable<AgentChange["modelTools"]> =>
  CHAT_TOOLS.map((name) => ({ name })) as unknown as NonNullable<AgentChange["modelTools"]>;

/** The refusal a chat gets for a work tool, in words it can act on. */
export const chatToolRefusal = (name: string): string =>
  `${name} runs in background tasks, not in a chat. Start a task with task_spawn (or continue ` +
  "one with task_message) and end your turn; you are woken with its result.";

/** How a chat works, rendered into every chat's prompt (never a task's). */
export const CHAT_ROLE =
  "How you work: in this chat you talk with your owner, plan, remember and coordinate. Your " +
  "work tools (web, shell, files, code, outside services) run in background tasks: hand each " +
  "piece of work to task_spawn with a self-contained prompt, tell your owner in a sentence " +
  "what is running, and end your turn. You are woken with the result and links to the files " +
  "it saved; pass the links on as they are. A follow-up on the same work continues that task " +
  "with task_message, so it keeps what it already found.";

/**
 * The chat side of the split: the role line in every chat's prompt, and the
 * backstop — a chat's call to anything outside the list is refused before
 * it runs.
 */
export const chatToolsExtension = (kindOf: (conversationId: string) => SessionKind | undefined) =>
  defineExtension({
    name: "ultius.mind.chat-tools",
    sections: [
      {
        key: "chat_role",
        render: (input) =>
          isChatKind(kindOf(String(input.conversationId))) ? CHAT_ROLE : undefined,
      },
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) =>
          isChatKind(kindOf(String(api.conversationId))) && !chatMayCall(call.name)
            ? { block: chatToolRefusal(call.name) }
            : undefined,
      }),
    ],
  });

/** What the boot heal reads and writes: each indexed chat's offered tools. */
export interface ChatToolsHeal {
  readonly chats: () => Promise<readonly string[]>;
  readonly offered: (conversationId: string) => Promise<readonly string[] | undefined>;
  readonly restrict: (conversationId: string) => Promise<void>;
}

/**
 * Give every existing chat the chat-only filter when it is still offered a
 * work tool (chats made before the split, or whose filter a fork dropped).
 * Best effort per chat; returns how many changed.
 */
export const healChatTools = async (heal: ChatToolsHeal): Promise<number> => {
  let changed = 0;
  for (const conversationId of await heal.chats()) {
    try {
      const offered = await heal.offered(conversationId);
      if (offered === undefined || offered.every(chatMayCall)) continue;
      await heal.restrict(conversationId);
      changed += 1;
    } catch {
      // One stale chat never blocks the rest.
    }
  }
  return changed;
};
