/**
 * Talking to running tasks: `task_message` steers one with new instructions
 * (owner-steering semantics), and the "running tasks" prompt section keeps
 * the bot aware of what it has in flight. The section shows a stable start
 * time, not a live age, so it does not churn the prompt every request.
 */
import { Effect } from "effect";
import { Type } from "typebox";
import type { PromptSection } from "@earendil-works/pi-durable";
import type { TaskInfo } from "@spreissen/contracts";
import { defineTool, type Tool } from "@spreissen/ext";
import { titleOf, type TasksService } from "../tasks/tasks.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

/** A plain text tool reply. */
export const textReply = (text: string, isError = false) =>
  isError
    ? { output: [{ type: "text" as const, text }], isError: true as const }
    : { output: [{ type: "text" as const, text }] };

/** The tasks a calling conversation may see: its bot's, else the ones it spawned. */
export const tasksVisibleTo = (
  profiles: ProfilesService,
  conversationId: string,
  list: readonly TaskInfo[],
): TaskInfo[] => {
  const scope = profiles.scopeOf(conversationId);
  return list.filter(
    (task) =>
      task.conversationId === conversationId ||
      (scope !== undefined &&
        task.bot?.owner === scope.owner &&
        task.bot.profileId === scope.profileId),
  );
};

const MessageParams = Type.Object({
  id: Type.String({ description: "The running task's id." }),
  text: Type.String({ description: "The new instruction, self-contained." }),
});

export const messageTool = (tasks: TasksService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "task_message",
    description:
      "Send new instructions to one of your RUNNING background tasks (a change of scope, an " +
      "answer it needs). It lands at the task's next step. Fails if the task is not running.",
    parameters: MessageParams,
    structuredOutputSchema: Type.Object({ id: Type.String(), sent: Type.Boolean() }),
    execute: async (args, api) => {
      const visible = tasksVisibleTo(
        profiles,
        String(api.conversationId),
        await Effect.runPromise(tasks.list()),
      );
      const task = visible.find((candidate) => candidate.id === args.id);
      const outcome =
        task === undefined
          ? "not_running"
          : await Effect.runPromise(tasks.message(args.id, args.text));
      if (outcome !== "sent") {
        const why =
          task === undefined
            ? `no task ${args.id} of yours`
            : `task ${args.id} is ${task.status === "running" ? "finishing" : task.status}`;
        return { ...textReply(`not sent: ${why}. Spawn a new task instead.`, true) };
      }
      return {
        ...textReply(`sent to task ${args.id}; it picks this up at its next step.`),
        structuredOutput: { id: args.id, sent: true },
      };
    },
  });

const NotifyParams = Type.Object({
  text: Type.String({ description: "One short progress line for your owner (≤280 chars)." }),
});

/** notify_owner: only inside a task; the line shows in the owner's chat, the parent sleeps on. */
export const notifyTool = (tasks: TasksService): Tool =>
  defineTool({
    name: "notify_owner",
    description:
      "Inside a background task: post one short progress line (a milestone or a blocker) " +
      "straight to your owner's chat. It does not wake your bot; the final result still " +
      "arrives as your reply. At most once every 2 minutes, ≤280 characters.",
    parameters: NotifyParams,
    structuredOutputSchema: Type.Object({ posted: Type.Boolean() }),
    execute: async (args, api) => {
      const task = await Effect.runPromise(tasks.taskOf(String(api.conversationId)));
      if (task === undefined) {
        return textReply("not posted: notify_owner works only inside a background task.", true);
      }
      const outcome = await Effect.runPromise(tasks.notify(task.id, args.text));
      if (outcome.status === "too_soon") {
        const seconds = Math.ceil(outcome.waitMs / 1000);
        return textReply(`not posted: one update per 2 minutes; next in ${seconds}s.`, true);
      }
      if (outcome.status === "not_running") return textReply("not posted: task is over.", true);
      return { ...textReply("posted to your owner."), structuredOutput: { posted: true } };
    },
  });

/** "14:05" in the bot's zone (server zone when it has none). */
const clock = (at: number, zone: string | undefined): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      ...(zone !== undefined && zone !== "" ? { timeZone: zone } : {}),
    }).format(at);
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
};

/** The running-tasks lines for one conversation; undefined when nothing runs. */
export const runningTasksText = (
  running: readonly TaskInfo[],
  zone: string | undefined,
): string | undefined => {
  if (running.length === 0) return undefined;
  const lines = running.map(
    (task) => `- ${task.id} "${titleOf(task)}" (started ${clock(task.createdAt, zone)})`,
  );
  return `Running tasks (steer with task_message; results wake you):\n${lines.join("\n")}`;
};

/** The section: only for the bot's own chats, never inside a task. */
export const runningTasksSection = (
  tasks: TasksService,
  profiles: ProfilesService,
): PromptSection => ({
  key: "running_tasks",
  render: async (input) => {
    const cid = String(input.conversationId);
    if (profiles.scopeOf(cid)?.kind === "task") return undefined;
    const all = await Effect.runPromise(tasks.list());
    const running = tasksVisibleTo(profiles, cid, all).filter((task) => task.status === "running");
    return runningTasksText(running, profiles.profileOf(cid)?.timezone);
  },
});
