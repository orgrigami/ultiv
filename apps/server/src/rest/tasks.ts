/** Task routes: spawn/status/list/remove/activity over the mind's tasks faculty. */
import type { LiveState } from "@earendil-works/pi-durable";
import {
  AGENT_OWNER,
  MAX_RUNNING_TASKS,
  runningCapMessage,
  taskConversationKey,
  tasksVisibleTo,
} from "@ultiv/mind";
import { projectTranscript } from "@ultiv/mind";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import { queryOr, type RouteArgs } from "./types.ts";
import { activitySteps, type ActivityStep } from "./task-steps.ts";

function liveOf(view: unknown): LiveState | undefined {
  const docs = (view as { docs?: Record<string, unknown> }).docs;
  return docs?.["pi.live"] as LiveState | undefined;
}

/**
 * Which tasks a principal may see and manage: its own rows (never the
 * `agent` sentinel — a principal cannot BE the agent, and the identity seam
 * refuses the label anyway), agent-spawned rows whose BOT is its own (the
 * row's `bot.owner` is the principal the spawn bound), and nothing else.
 * Owner identity rides the client-supplied `x-ultiv-user` header, so "some
 * other named principal" is not a boundary; agent rows without a bot
 * binding stay hidden (fail safe), and any foreign task 404s without
 * disclosing that it exists.
 */
const maySee = (
  owner: string,
  task: { owner: string; bot?: { owner: string; profileId: string } },
): boolean =>
  owner !== AGENT_OWNER &&
  (task.owner === owner || (task.owner === AGENT_OWNER && task.bot?.owner === owner));

export async function taskRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/tasks" && method === "GET") {
    const list = (await Effect.runPromise(mind.tasks.list())).filter((task) =>
      maySee(args.owner, task),
    );
    // Running tasks carry their latest step for the task pill (a few at most)
    // and any approval waiting on the task conversation, so the chat that
    // spawned the task can surface the card without opening the task sheet.
    // A task turn parks at most one gate (a gated tool awaits before the turn
    // proceeds), so the first pending entry is the one.
    const withSteps = await Promise.all(
      list.map(async (task) => {
        if (task.status !== "running") return task;
        const [last] = (await mind.tasks.steps(task.id, 1).catch(() => [])).slice(-1);
        const conversationId =
          (await Effect.runPromise(mind.converse.conversationIdOf(taskConversationKey(task.id)))) ??
          null;
        const waiting =
          conversationId === null ? undefined : mind.approvals.pendingFor(conversationId)[0];
        return {
          ...task,
          ...(last === undefined ? {} : { lastStep: last }),
          taskConversationId: conversationId,
          ...(waiting === undefined
            ? {}
            : {
                waitingApproval: {
                  callId: waiting.callId,
                  name: waiting.name,
                  input: waiting.input,
                  reason: waiting.reason ?? null,
                },
              }),
        };
      }),
    );
    json(200, withSteps);
    return true;
  }
  if (path === "/api/tasks" && method === "POST") {
    const body = await args.readJson<{ sessionId?: string; prompt?: string }>(req);
    if (body.prompt === undefined || body.prompt.trim() === "") {
      json(400, { error: "prompt is required" });
      return true;
    }
    const spawnerConversationId =
      body.sessionId !== undefined && body.sessionId !== ""
        ? ((await Effect.runPromise(
            mind.converse.conversationIdOf(
              await mind.profiles.keyForSession(args.owner, body.sessionId),
            ),
          )) ?? null)
        : null;
    if (spawnerConversationId !== null) {
      const running = tasksVisibleTo(
        mind.profiles,
        spawnerConversationId,
        await Effect.runPromise(mind.tasks.list()),
      ).filter((task) => task.status === "running");
      if (running.length >= MAX_RUNNING_TASKS) {
        json(429, { error: runningCapMessage(running) });
        return true;
      }
    }
    // The task runs AS the bot whose session spawned it (spawn binds it before
    // the first turn) — unscoped only when no session context was given.
    const task = await Effect.runPromise(
      mind.tasks.spawn({
        sessionId: body.sessionId ?? "",
        owner: args.owner,
        conversationId: spawnerConversationId,
        prompt: body.prompt,
      }),
    );
    json(200, task);
    return true;
  }
  // The activity view: progress (projected transcript tail), the task's own
  // conversation id (files hang off it), and any approval waiting on it.
  // Before the generic single-task branch, which would otherwise shadow it.
  const activity = path.match(/^\/api\/tasks\/([^/]+)\/activity$/);
  if (activity !== null && method === "GET") {
    const id = activity[1] ?? "";
    const task = await Effect.runPromise(mind.tasks.get(id));
    // 404, not 403: existence of a foreign task is not disclosed either.
    if (task === undefined || !maySee(args.owner, task)) {
      json(404, { error: "unknown task" });
      return true;
    }
    const conversationId =
      (await Effect.runPromise(mind.converse.conversationIdOf(taskConversationKey(id)))) ?? null;
    let waiting: {
      callId: string;
      name: string;
      input: unknown;
      reason: string | null;
    } | null = null;
    let steps: ActivityStep[] = [];
    if (conversationId !== null) {
      const pending = mind.approvals.pendingFor(conversationId)[0];
      if (pending !== undefined) {
        waiting = {
          callId: pending.callId,
          name: pending.name,
          input: pending.input,
          reason: pending.reason ?? null,
        };
      }
      const chat = await Effect.runPromise(mind.converse.open(conversationId));
      if (chat !== undefined) {
        const value = (await chat.viewState(BACKGROUND_CONTEXT)).value;
        if (value !== undefined) {
          steps = activitySteps(
            projectTranscript(value.entries, liveOf(value), task.status === "running"),
          );
        }
      }
    }
    json(200, { conversationId, waiting, steps });
    return true;
  }
  // Stop one running task (the pill's Stop): the row stays, marked cancelled,
  // and the bot is told once. Foreign tasks 404 — same rule as every read.
  const cancel = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancel !== null && method === "POST") {
    const task = await Effect.runPromise(mind.tasks.get(cancel[1] ?? ""));
    if (task === undefined || !maySee(args.owner, task)) {
      json(404, { error: "unknown task" });
      return true;
    }
    json(200, { cancelled: await Effect.runPromise(mind.tasks.cancel(task.id)) });
    return true;
  }
  if (path.startsWith("/api/tasks/") && method === "GET") {
    const task = await Effect.runPromise(mind.tasks.get(segment("/api/tasks/")));
    if (task === undefined || !maySee(args.owner, task)) json(404, { error: "unknown task" });
    else json(200, task);
    return true;
  }
  if (path.startsWith("/api/tasks/") && method === "DELETE") {
    const id = segment("/api/tasks/");
    const task = await Effect.runPromise(mind.tasks.get(id));
    if (task === undefined || !maySee(args.owner, task)) {
      json(404, { error: "unknown task" });
      return true;
    }
    json(200, { ok: true, ...(await Effect.runPromise(mind.tasks.remove(id))) });
    return true;
  }
  void queryOr;
  return false;
}
