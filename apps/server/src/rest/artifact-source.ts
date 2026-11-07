/**
 * Where a file came from: the chat whose conversation wrote it, or the chat
 * that spawned the background task that wrote it. Resolved per request over
 * the owner's own sessions and visible tasks only, so another owner's chat
 * never names itself here. The maps are built once per list, lazily for
 * tasks (only when some file was not written in a chat directly).
 */
import type { ArtifactSource, SessionInfo, TaskInfo } from "@spriessen/contracts";
import { taskConversationKey } from "@spriessen/mind";
import { Effect } from "effect";
import { canSeeTask } from "./can.ts";
import type { RouteArgs } from "./types.ts";

type ChatOf = Omit<ArtifactSource, "task">;

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);

const chatsByConversation = async (
  args: RouteArgs,
  profiles: readonly string[],
): Promise<{ byConversation: Map<string, ChatOf>; byId: Map<string, ChatOf> }> => {
  const rows: SessionInfo[] = (
    await Promise.all(
      profiles.map((profile) => args.mind.profiles.listSessions(args.owner, profile)),
    )
  ).flat();
  const byConversation = new Map<string, ChatOf>();
  const byId = new Map<string, ChatOf>();
  await Promise.all(
    rows.map(async (row) => {
      const chat: ChatOf = {
        sessionId: row.id,
        title: row.title,
        main: row.kind === "main",
        botId: row.profile,
      };
      byId.set(row.id, chat);
      const key = await args.mind.profiles.keyOfRow(row);
      const conversation = await run(args.mind.converse.conversationIdOf(key));
      if (conversation !== undefined && conversation !== null)
        byConversation.set(conversation, chat);
    }),
  );
  return { byConversation, byId };
};

const tasksByConversation = async (args: RouteArgs): Promise<Map<string, TaskInfo>> => {
  const tasks = (await run(args.mind.tasks.list())).filter((task) => canSeeTask(args.owner, task));
  const entries = await Promise.all(
    tasks.map(async (task) => {
      const conversation = await run(
        args.mind.converse.conversationIdOf(taskConversationKey(task.id)),
      );
      return conversation === undefined || conversation === null
        ? []
        : [[conversation, task] as const];
    }),
  );
  return new Map(entries.flat());
};

/** A resolver for the files of these profiles: conversation id → source (or null). */
export const artifactSources = async (
  args: RouteArgs,
  profiles: readonly string[],
): Promise<(conversationId: string | null) => Promise<ArtifactSource | null>> => {
  const { byConversation, byId } = await chatsByConversation(args, profiles);
  let tasks: Promise<Map<string, TaskInfo>> | undefined;
  return async (conversationId) => {
    if (conversationId === null) return null;
    const direct = byConversation.get(conversationId);
    if (direct !== undefined) return direct;
    tasks ??= tasksByConversation(args);
    const task = (await tasks).get(conversationId);
    if (task === undefined) return null;
    const parent =
      (task.conversationId !== null ? byConversation.get(task.conversationId) : undefined) ??
      byId.get(task.sessionId);
    if (parent === undefined) return null;
    return { ...parent, task: { id: task.id, title: task.title ?? task.prompt.slice(0, 40) } };
  };
};
