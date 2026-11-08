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
import { titleOf, type TasksService } from "../tasks/tasks.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { messageTool, notifyTool, tasksVisibleTo, textReply } from "./task-live.ts";
import { backgroundModelFor } from "../tasks/model.ts";
import { resultSchemaProblem } from "../tasks/structured.ts";
import type { ProjectRef } from "../projects/links.ts";
import type { Json } from "@spriessen/contracts";

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
  project: Type.Optional(
    Type.String({
      description:
        "The #handle of your open project this task works toward; the project's show then " +
        "lists it.",
    }),
  ),
  result_schema: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "A JSON Schema the result must match, when you need data rather than prose (e.g. " +
          '{"type":"object","properties":{"price":{"type":"number"}},"required":["price"]}). ' +
          "The result then reaches you as validated JSON.",
      },
    ),
  ),
});

const StatusParams = Type.Object({ id: Type.String({ description: "The task id." }) });

/** Agent-spawned tasks are filed under their own owner label. Reserved: a principal may not NAME itself this. */
export const AGENT_OWNER = "agent";

const REFUSE_NESTED =
  "refused: you are already running AS a background task, and tasks cannot spawn sub-tasks (it " +
  "compounds cost). Do the work yourself in this conversation, or finish and let the parent decide.";

/**
 * What the spawning (or steering) turn was: `outside` when it had outside
 * content (learn.ts `turnIsOutside`; the task inherits it), `owner` when the
 * owner's own message started it (the task then rides the owner lane).
 * Absent: clean, and not the owner's.
 */
export type TurnFacts = (
  conversationId: string,
) => Promise<{ readonly outside: boolean; readonly owner: boolean }>;

/** The facts of a turn, failing safe: outside, and not the owner's. */
export const factsOf = async (
  turnOf: TurnFacts | undefined,
  conversationId: string,
): Promise<{ readonly outside: boolean; readonly owner: boolean }> =>
  turnOf === undefined
    ? { outside: false, owner: false }
    : await turnOf(conversationId).catch(() => ({ outside: true, owner: false }));

/** A spawn's `project` handle → the project id, or the refusal sentence. */
const linkOf = async (
  profiles: ProfilesService,
  projectRef: ProjectRef | undefined,
  spawning: string,
  ref: string | undefined,
): Promise<{ projectId?: string } | string> => {
  if (ref === undefined || ref.trim() === "") return {};
  const scope = profiles.scopeOf(spawning);
  if (projectRef === undefined || scope === undefined)
    return "refused: projects are not available here";
  const target = await projectRef(scope, ref);
  return typeof target === "string" ? `refused: ${target}` : { projectId: target.id };
};

const spawnTool = (
  tasks: TasksService,
  profiles: ProfilesService,
  turnOf: TurnFacts | undefined,
  knownModel: (ref: string) => boolean,
  projectRef: ProjectRef | undefined,
): Tool =>
  defineTool({
    name: "task_spawn",
    description:
      "Start a background task: your own sub-agent, run in its own durable conversation with " +
      "your full set of work tools. Work happens in tasks: research, reading pages or files, " +
      "scripts, edits, anything that needs your work tools. Write the prompt self-contained " +
      "(the task does not see this chat). When you spawn, tell your owner in a sentence what " +
      "is running, then END YOUR TURN: you are woken with the result, and links to the files " +
      "it saved, when it settles. Over your limit of tasks at once it waits in your queue and " +
      "starts by itself. For a follow-up on the same work, continue the task with " +
      "task_message instead of spawning a new one. Do NOT poll task_status in a loop.",
    parameters: SpawnParams,
    structuredOutputSchema: Type.Object({ id: Type.String(), status: Type.String() }),
    execute: async (args, api) => {
      const spawning = String(api.conversationId);
      if (await Effect.runPromise(tasks.isTaskConversation(spawning))) {
        return textReply(REFUSE_NESTED, true);
      }
      const choice = backgroundModelFor(
        profiles.profileOf(spawning),
        {
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
        },
        knownModel,
      );
      if (!choice.ok) return textReply(choice.reason, true);
      const schemaProblem =
        args.result_schema === undefined ? null : resultSchemaProblem(args.result_schema);
      if (schemaProblem !== null) return textReply(schemaProblem, true);
      const link = await linkOf(profiles, projectRef, spawning, args.project);
      if (typeof link === "string") return textReply(link, true);
      const facts = await factsOf(turnOf, spawning);
      const spawned = await Effect.runPromise(
        Effect.result(
          tasks.spawn({
            sessionId: args.sessionId ?? "",
            owner: AGENT_OWNER,
            conversationId: spawning,
            prompt: args.prompt,
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(facts.outside ? { outside: true } : {}),
            ...(facts.owner ? { lane: "owner" as const } : {}),
            ...(choice.model !== undefined ? { model: choice.model } : {}),
            // Tool arguments arrive as parsed JSON.
            ...(args.result_schema !== undefined
              ? { resultSchema: args.result_schema as Json }
              : {}),
            ...link,
          }),
        ),
      );
      if (spawned._tag === "Failure") {
        const error = spawned.failure;
        if (error._tag === "spriessen/InvalidInput")
          return textReply(`refused: ${error.reason}`, true);
        throw error;
      }
      const task = spawned.success;
      const state =
        task.status === "queued"
          ? "queued: it starts by itself when one of your running tasks finishes"
          : "running";
      return {
        ...textReply(
          `task ${task.id} ${state}. End your turn now; you will be woken with the result.`,
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
      structured: Type.Optional(Type.Unknown()),
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
        ...(task.structured !== undefined ? { structured: task.structured } : {}),
      };
      return { ...textReply(JSON.stringify(status)), structuredOutput: status };
    },
  });

const cancelTool = (tasks: TasksService): Tool =>
  defineTool({
    name: "task_cancel",
    description:
      "Stop a running or queued background task by id: its conversation is aborted and the " +
      "task is marked cancelled. Your owner can also stop tasks from the app.",
    parameters: StatusParams,
    structuredOutputSchema: Type.Object({ id: Type.String(), cancelled: Type.Boolean() }),
    execute: async (args) => {
      const cancelled = await Effect.runPromise(tasks.cancel(args.id));
      return {
        ...textReply(
          cancelled ? `task ${args.id} cancelled` : `task ${args.id} was not running or queued`,
        ),
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
    readonly turnOf?: TurnFacts | undefined;
    /** The live catalog check for a task's model; absent (bare tests): every ref passes. */
    readonly knownModel?: (ref: string) => boolean;
    /** Resolves `project` handles (projects/links.ts); absent: a `project` is refused. */
    readonly projectRef?: ProjectRef;
  } = {},
): readonly Tool[] => [
  spawnTool(
    tasks,
    profiles,
    options.turnOf,
    options.knownModel ?? (() => true),
    options.projectRef,
  ),
  statusTool(tasks),
  cancelTool(tasks),
  listTool(tasks, profiles),
  messageTool(tasks, profiles, options.turnOf),
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
