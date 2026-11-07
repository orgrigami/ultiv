/**
 * The Tasks faculty as native tools of the agent loop (`task_spawn`,
 * `task_status`, `task_cancel`, `task_list`, `task_message`, `notify_owner`): the entity can hand background
 * work to itself — research, batch jobs, follow-ups — without holding a turn
 * open. Spawning work is internal compute, not a side effect on the world:
 * ungated, like the decision tools. A task runs AS the spawning bot, and a
 * bot sees only its own tasks.
 */
import { Effect } from "effect";
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin, type Tool } from "@spriessen/ext";
import { defineTool } from "@spriessen/ext";
import {
  MAX_RUNNING_TASKS,
  runningCapMessage,
  titleOf,
  type TasksService,
} from "../tasks/tasks.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { messageTool, notifyTool, tasksVisibleTo, textReply } from "./task-live.ts";
import { backgroundModelFor } from "../tasks/model.ts";

const SpawnParams = Type.Object({
  prompt: Type.String({
    description:
      "The full, self-contained instruction for the background task: the goal, the steps " +
      "and what to report back.",
  }),
  title: Type.Optional(
    Type.String({
      description:
        "A short title your owner sees in the task list, ≤40 chars (e.g. 'Flight prices').",
    }),
  ),
  sessionId: Type.Optional(
    Type.String({ description: "App session to file the task under; optional." }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "A provider/model id for this task only. Omit it: tasks run on your background model.",
    }),
  ),
  effort: Type.Optional(
    Type.String({ description: "Reasoning effort for this task only, e.g. low or high." }),
  ),
});

const StatusParams = Type.Object({ id: Type.String({ description: "The task id." }) });

/** Agent-spawned tasks are filed under their own owner label. Reserved: a principal may not NAME itself this. */
export const AGENT_OWNER = "agent";

const REFUSE_NESTED =
  "refused: you are already running AS a background task, and tasks cannot spawn sub-tasks (it " +
  "compounds cost). Do the work yourself in this conversation, or finish and let the parent decide.";

/**
 * Whether a conversation's current turn had outside content (learn.ts
 * `turnIsOutside`); a spawned or steered task inherits it. Absent: clean.
 */
export type OutsideTurn = (conversationId: string) => Promise<boolean>;

const spawnTool = (
  tasks: TasksService,
  profiles: ProfilesService,
  outsideTurn: OutsideTurn | undefined,
  knownModel: (ref: string) => boolean,
): Tool =>
  defineTool({
    name: "task_spawn",
    description:
      "Start a background task: your own sub-agent turn, run in its own durable conversation. " +
      "Prefer it whenever the work needs more than two or three tool rounds: research across " +
      "several pages, reading many files, long scripts, batch jobs, anything you " +
      "would rather not hold this conversation open for. Keep inline only what is quick or " +
      "needs your owner's taste mid-way. When you spawn, tell your owner in a sentence what " +
      "is running and that you will report the result, then END YOUR TURN: you are woken " +
      "automatically with the result as a new input when the task settles. Do NOT poll " +
      "task_status in a loop.",
    parameters: SpawnParams,
    structuredOutputSchema: Type.Object({ id: Type.String(), status: Type.String() }),
    execute: async (args, api) => {
      const spawning = String(api.conversationId);
      if (await Effect.runPromise(tasks.isTaskConversation(spawning))) {
        return textReply(REFUSE_NESTED, true);
      }
      const running = tasksVisibleTo(
        profiles,
        spawning,
        await Effect.runPromise(tasks.list()),
      ).filter((task) => task.status === "running");
      if (running.length >= MAX_RUNNING_TASKS) return textReply(runningCapMessage(running), true);
      const choice = backgroundModelFor(
        profiles.profileOf(spawning),
        {
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
        },
        knownModel,
      );
      if (!choice.ok) return textReply(choice.reason, true);
      const outside = (await outsideTurn?.(spawning).catch(() => true)) ?? false;
      const task = await Effect.runPromise(
        tasks.spawn({
          sessionId: args.sessionId ?? "",
          owner: AGENT_OWNER,
          conversationId: spawning,
          prompt: args.prompt,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(outside ? { outside: true } : {}),
          ...(choice.model !== undefined ? { model: choice.model } : {}),
        }),
      );
      return {
        ...textReply(
          `task ${task.id} running. End your turn now; you will be woken with the result.`,
        ),
        structuredOutput: { id: task.id, status: task.status },
      };
    },
  });

const statusTool = (tasks: TasksService): Tool =>
  defineTool({
    name: "task_status",
    description:
      "One-shot status check for a background task by id. Tasks you spawned wake you with their " +
      "result automatically; use this only for an on-demand check, never to poll in a loop. " +
      "Shows its last few steps.",
    parameters: StatusParams,
    structuredOutputSchema: Type.Object({
      status: Type.String(),
      title: Type.String(),
      steps: Type.Array(Type.String()),
      result: Type.Union([Type.String(), Type.Null()]),
      error: Type.Union([Type.String(), Type.Null()]),
    }),
    execute: async (args) => {
      const task = await Effect.runPromise(tasks.get(args.id));
      if (task === undefined) return textReply(`unknown task: ${args.id}`, true);
      const status = {
        status: task.status,
        title: titleOf(task),
        steps: await tasks.steps(args.id),
        result: task.result,
        error: task.error,
      };
      return { ...textReply(JSON.stringify(status)), structuredOutput: status };
    },
  });

const cancelTool = (tasks: TasksService): Tool =>
  defineTool({
    name: "task_cancel",
    description:
      "Stop a running background task by id: its conversation is aborted and the task is marked " +
      "cancelled. Your owner can also stop tasks from the app.",
    parameters: StatusParams,
    structuredOutputSchema: Type.Object({ id: Type.String(), cancelled: Type.Boolean() }),
    execute: async (args) => {
      const cancelled = await Effect.runPromise(tasks.cancel(args.id));
      return {
        ...textReply(cancelled ? `task ${args.id} cancelled` : `task ${args.id} was not running`),
        structuredOutput: { id: args.id, cancelled },
      };
    },
  });

const listTool = (tasks: TasksService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "task_list",
    description: "List your recent background tasks with their ids, titles and statuses.",
    parameters: Type.Object({}),
    structuredOutputSchema: Type.Array(
      Type.Object({ id: Type.String(), title: Type.String(), status: Type.String() }),
    ),
    execute: async (_args, api) => {
      const all = await Effect.runPromise(tasks.list());
      const recent = tasksVisibleTo(profiles, String(api.conversationId), all)
        .slice(-20)
        .reverse()
        .map((task) => ({ id: task.id, title: titleOf(task), status: task.status }));
      return { ...textReply(JSON.stringify(recent)), structuredOutput: recent };
    },
  });

/** The task tools in registry order. */
export const taskTools = (
  tasks: TasksService,
  profiles: ProfilesService,
  options: {
    readonly outsideTurn?: OutsideTurn | undefined;
    /** The live catalog check for a task's model; absent (bare tests): every ref passes. */
    readonly knownModel?: (ref: string) => boolean;
  } = {},
): readonly Tool[] => [
  spawnTool(tasks, profiles, options.outsideTurn, options.knownModel ?? (() => true)),
  statusTool(tasks),
  cancelTool(tasks),
  listTool(tasks, profiles),
  messageTool(tasks, profiles, options.outsideTurn),
  notifyTool(tasks),
];

/** The mind's background-task faculty as an installable plugin. */
export const taskPlugin = (tasks: TasksService, profiles: ProfilesService): Plugin =>
  definePlugin({
    id: "ultiv.mind.tasks",
    version: "1.2.0",
    description: "The mind's background tasks: spawn, track and read back its own sub-agent work.",
    capabilities: taskTools(tasks, profiles).map(toolCapability),
  });
