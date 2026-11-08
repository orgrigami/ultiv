/**
 * Talking to tasks: `task_message` steers a running one, adds to a queued
 * one's input, or continues a finished one with its own context
 * (tasks/continue.ts), and the "running tasks" prompt section keeps the bot
 * aware of what it has in flight. The section shows a stable start time, not
 * a live age, so it does not churn the prompt every request.
 */
import { factsOf, type TurnFacts } from "./task-tools.ts";
import { Effect } from "effect";
import { bool, obj, str } from "@earendil-works/pi-schema";
import type { PromptSection } from "@earendil-works/pi-durable";
import type { TaskInfo } from "@spriessen/contracts";
import { defineTool, type Tool } from "@spriessen/ext";
import { titleOf, type MessageOutcome, type TasksService } from "../tasks/tasks.ts";
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

const MessageParams = obj(
  {
    id: str({ description: "The task's id (running, queued or finished)." }),
    text: str({ description: "The new instruction, self-contained." }),
  },
  { open: true },
);

/** The tool's reply per outcome; errors are the refusals. */
const MESSAGE_REPLIES: Record<MessageOutcome, { readonly text: string; readonly error?: true }> = {
  sent: { text: "sent; it picks this up at its next step." },
  continued: {
    text: "continued: it runs again with its earlier work in context. End your turn; you are woken with the result.",
  },
  queued: {
    text: "continued, queued: it runs again when one of your running tasks finishes. End your turn.",
  },
  finishing: {
    text: "not sent: it is reporting its result right now. You are woken with it; send again then.",
    error: true,
  },
  full: { text: "not sent: your task queue is full.", error: true },
  unknown: { text: "not sent: no such task of yours.", error: true },
};

export const messageTool = (
  tasks: TasksService,
  profiles: ProfilesService,
  turnOf?: TurnFacts,
): Tool =>
  defineTool({
    name: "task_message",
    description:
      "Send new instructions to one of your background tasks. A running task picks them up at " +
      "its next step; a queued one starts with them; a FINISHED one (done, failed or " +
      "cancelled) is continued: it runs again with all of its earlier work in context and " +
      'wakes you with the new result. Use it for follow-ups on the same work ("make it ' +
      'shorter", "add prices") instead of spawning a fresh task.',
    parameters: MessageParams,
    structuredOutputSchema: obj({ id: str(), sent: bool() }, { open: true }),
    execute: async (args, api) => {
      const visible = tasksVisibleTo(
        profiles,
        String(api.conversationId),
        await Effect.runPromise(tasks.list()),
      );
      const task = visible.find((candidate) => candidate.id === args.id);
      const facts =
        task === undefined ? undefined : await factsOf(turnOf, String(api.conversationId));
      const outcome: MessageOutcome =
        task === undefined || facts === undefined
          ? "unknown"
          : await Effect.runPromise(
              tasks.message(args.id, args.text, {
                ...(facts.outside ? { outside: true } : {}),
                ...(facts.owner ? { lane: "owner" as const } : {}),
              }),
            );
      const reply = MESSAGE_REPLIES[outcome];
      if (reply.error === true) return textReply(`task ${args.id} ${reply.text}`, true);
      return {
        ...textReply(`task ${args.id} ${reply.text}`),
        structuredOutput: { id: args.id, sent: true },
        details: { id: args.id, outcome },
      };
    },
  });

const NotifyParams = obj(
  {
    text: str({ description: "One short progress line for your owner (≤280 chars)." }),
  },
  { open: true },
);

/** notify_owner: only inside a task; the line shows in the owner's chat, the parent sleeps on. */
export const notifyTool = (tasks: TasksService): Tool =>
  defineTool({
    name: "notify_owner",
    description:
      "Inside a background task: post one short progress line (a milestone or a blocker) " +
      "straight to your owner's chat. It does not wake your bot; the final result still " +
      "arrives as your reply. At most once every 2 minutes, ≤280 characters.",
    parameters: NotifyParams,
    structuredOutputSchema: obj({ posted: bool() }, { open: true }),
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
  live: readonly TaskInfo[],
  zone: string | undefined,
): string | undefined => {
  if (live.length === 0) return undefined;
  const lines = live.map((task) =>
    task.status === "queued"
      ? `- ${task.id} "${titleOf(task)}" (queued)`
      : `- ${task.id} "${titleOf(task)}" (started ${clock(task.startedAt ?? task.createdAt, zone)})`,
  );
  return `Your tasks in flight (task_message steers one; results wake you):\n${lines.join("\n")}`;
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
    const live = tasksVisibleTo(profiles, cid, all).filter(
      (task) => task.status === "running" || task.status === "queued",
    );
    return runningTasksText(live, profiles.profileOf(cid)?.timezone);
  },
});
