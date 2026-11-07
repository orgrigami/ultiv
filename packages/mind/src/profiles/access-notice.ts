/**
 * Access-change notices: when the owner changes what a bot may do (its tool
 * list, the sandbox, host access, its approval mode), the bot's work that is
 * RUNNING right now is told what changed, so a task half-way through a plan
 * does not keep reaching for a tool that is gone or assume a call will run
 * unasked. Only running work hears it (dsh-superagent's rule: a change is
 * delivered to the live work it bears on, and nothing else gets a notice);
 * an idle chat simply starts its next turn on the new tool list. The notice
 * is a note (`ultiv.access-notice`): the turn reads it at its next step, no
 * turn starts for it, and nothing is pushed.
 */
import { Effect } from "effect";
import type { ProfileInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { taskConversationKey } from "../tasks/store.ts";
import type { TasksService } from "../tasks/tasks.ts";
import type { ProfilesService } from "./profiles.ts";

export const ACCESS_NOTICE_KIND = "ultiv.access-notice";
/** Tool names listed per side before "and N more". */
const LISTED = 8;

const MODE_WORDS: Record<string, string> = {
  manual: "Manual (your owner approves each gated call)",
  jev: "Jev (your decision faculty approves clear calls; the rest ask your owner)",
  yolo: "YOLO (gated calls run without asking, except the ones that always ask)",
};

const listed = (names: readonly string[]): string =>
  names.length <= LISTED
    ? names.join(", ")
    : `${names.slice(0, LISTED).join(", ")} and ${names.length - LISTED} more`;

/** A bot's tools as the agent states them: a fixed list, a remove filter, or every tool. */
export type AgentTools =
  | readonly { readonly name: string }[]
  | { readonly remove: readonly { readonly name: string }[] }
  | null
  | undefined;

type ToolSet = { readonly only: readonly string[] } | { readonly except: readonly string[] };

const setOf = (tools: AgentTools): ToolSet => {
  if (tools === null || tools === undefined) return { except: [] };
  if ("remove" in tools) return { except: tools.remove.map((tool) => tool.name) };
  return { only: tools.map((tool) => tool.name) };
};

const minus = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((name) => !b.includes(name));

/** What changed in the tool set; null when nothing did. */
const toolChange = (before: AgentTools, after: AgentTools): string | null => {
  const was = setOf(before);
  const now = setOf(after);
  let removed: string[];
  let added: string[];
  if ("only" in was && "only" in now) {
    removed = minus(was.only, now.only);
    added = minus(now.only, was.only);
  } else if ("except" in was && "except" in now) {
    removed = minus(now.except, was.except);
    added = minus(was.except, now.except);
  } else if ("only" in now) {
    return `your tools are limited to: ${listed(now.only)}`;
  } else {
    return now.except.length === 0
      ? "every tool is allowed now"
      : `every tool is allowed now except: ${listed(now.except)}`;
  }
  const parts = [
    ...(removed.length > 0 ? [`removed: ${listed(removed)}`] : []),
    ...(added.length > 0 ? [`added: ${listed(added)}`] : []),
  ];
  return parts.length === 0 ? null : `tools ${parts.join("; ")}`;
};

/** The notice for a change of access, in the bot's terms; null when nothing bears on its work. */
export const accessChangeText = (
  before: ProfileInfo,
  after: ProfileInfo,
  toolsOf: (profile: ProfileInfo) => AgentTools,
): string | null => {
  const changes: string[] = [];
  const tools = toolChange(toolsOf(before), toolsOf(after));
  if (tools !== null) changes.push(tools);
  if (before.policies.approvalMode !== after.policies.approvalMode) {
    const mode = after.policies.approvalMode;
    changes.push(`approval mode is now ${MODE_WORDS[mode] ?? mode}`);
  }
  if (changes.length === 0) return null;
  return (
    `[access changed] Your owner changed what you may do: ${changes.join("; ")}. ` +
    "Do not retry a removed tool another way; if the work needs it, say so."
  );
};

/** Leave the notice with every running conversation of the bot; returns how many heard it. */
export const noticeRunningWork = async (
  deps: {
    readonly converse: ConverseService;
    readonly profiles: Pick<ProfilesService, "listSessions" | "keyOfRow">;
    readonly tasks: Pick<TasksService, "list">;
  },
  profile: ProfileInfo,
  text: string,
): Promise<number> => {
  const keys: string[] = [];
  for (const row of await deps.profiles.listSessions(profile.owner, profile.id)) {
    if (row.profile === profile.id) keys.push(await deps.profiles.keyOfRow(row));
  }
  for (const task of await Effect.runPromise(deps.tasks.list())) {
    const mine = task.bot?.owner === profile.owner && task.bot.profileId === profile.id;
    if (mine && task.status === "running") keys.push(taskConversationKey(task.id));
  }
  let heard = 0;
  for (const key of keys) {
    try {
      const id = await Effect.runPromise(deps.converse.conversationIdOf(key));
      if (id === undefined) continue;
      const conversation = await Effect.runPromise(deps.converse.open(String(id)));
      if (conversation === undefined) continue;
      // Only work in flight: an idle chat starts its next turn on the new list.
      const live = await Effect.runPromise(deps.converse.liveOf(conversation));
      if (live?.run === undefined) continue;
      await Effect.runPromise(deps.converse.note(conversation, ACCESS_NOTICE_KIND, {}, text));
      heard += 1;
    } catch (cause) {
      console.error("access notice failed:", cause);
    }
  }
  return heard;
};
