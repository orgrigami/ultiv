/**
 * What earns a push, and the words it carries. Every payload names the bot
 * and the kind of event only: no tool input, no message or reply text, no
 * URLs a bot fetched. A tap opens the chat the event belongs to.
 */
import { Effect } from "effect";
import type { MailboxEntry, TaskInfo } from "@spreissen/contracts";
import type { MindService } from "@spreissen/mind";
import type { DeliverySource } from "../deliver.ts";
import type { Notifier, PushPayload } from "./notifier.ts";

/** Where routine replies come from; each reads as one short phrase. */
export type RoutineSource = DeliverySource;

const ROUTINE_PHRASE: Record<RoutineSource, string> = {
  webhook: "after a webhook call",
  cron: "after a scheduled run",
  sensor: "after a calendar sensor fired",
};

const chatUrl = (sessionId: string | undefined): string =>
  sessionId !== undefined && sessionId !== "" ? `/c/${encodeURIComponent(sessionId)}` : "/";

const botName = async (mind: MindService, owner: string, profileId: string): Promise<string> =>
  (await mind.profiles.get(owner, profileId))?.name ?? "Your bot";

/** The app session a conversation is shown in: its task's chat, a session row, else the bot's main chat. */
export const sessionOfConversation = async (
  mind: MindService,
  owner: string,
  profileId: string,
  conversationId: string,
): Promise<string | undefined> => {
  const task = await Effect.runPromise(mind.tasks.taskOf(conversationId)).catch(() => undefined);
  if (task !== undefined && task.sessionId !== "") return task.sessionId;
  for (const row of await mind.profiles.listSessions(owner, profileId)) {
    const key = await mind.profiles.keyOfRow(row);
    const id = await Effect.runPromise(mind.converse.conversationIdOf(key)).catch(() => undefined);
    if (id === conversationId) return row.id;
  }
  return (await mind.profiles.ensureMain(owner, profileId)).id;
};

export const taskPayload = (task: TaskInfo, bot: string): PushPayload => {
  const title = task.title ?? task.prompt.slice(0, 40);
  return {
    title: task.status === "done" ? `${bot} finished a task` : `${bot}'s task failed`,
    body: title,
    url: chatUrl(task.sessionId),
    tag: `task:${task.id}`,
  };
};

export const approvalPayload = (bot: string, tool: string, sessionId: string | undefined) => ({
  title: `${bot} needs your approval`,
  body: `Wants to run ${tool}. Open the chat to allow or deny.`,
  url: chatUrl(sessionId),
  tag: `approval:${sessionId ?? bot}`,
  urgency: "high" as const,
});

export const mailboxPayload = (bot: string, to: string, sessionId: string | undefined) => ({
  title: `${bot} got no reply from ${to}`,
  body: "A message between your bots timed out.",
  url: chatUrl(sessionId),
  tag: `mailbox:${sessionId ?? bot}`,
});

export const routinePayload = (bot: string, source: RoutineSource, sessionId: string) => ({
  title: `${bot} replied`,
  body: `New reply ${ROUTINE_PHRASE[source]}.`,
  url: chatUrl(sessionId),
  tag: `routine:${sessionId}`,
});

const logged = (what: string) => (cause: unknown) =>
  console.error(`push (${what}) failed:`, String(cause).slice(0, 200));

const onTask = async (mind: MindService, notifier: Notifier, task: TaskInfo): Promise<void> => {
  const bot = task.bot !== undefined ? await botName(mind, task.owner, task.bot.profileId) : "";
  await notifier.notify(task.owner, taskPayload(task, bot === "" ? "Your bot" : bot));
};

const onApproval = async (
  mind: MindService,
  notifier: Notifier,
  conversationId: string,
  tool: string,
): Promise<void> => {
  const scope = mind.profiles.scopeOf(conversationId);
  if (scope === undefined) return;
  const [bot, sessionId] = await Promise.all([
    botName(mind, scope.owner, scope.profileId),
    sessionOfConversation(mind, scope.owner, scope.profileId, conversationId),
  ]);
  await notifier.notify(scope.owner, approvalPayload(bot, tool, sessionId));
};

const onExpired = async (
  mind: MindService,
  notifier: Notifier,
  entry: MailboxEntry,
): Promise<void> => {
  const owner = entry.owner ?? "guest";
  const { from, to } = entry.envelope;
  const [bot, target, sessionId] = await Promise.all([
    botName(mind, owner, from),
    botName(mind, owner, to),
    mind.profiles.ensureMain(owner, from).then((row) => row.id),
  ]);
  await notifier.notify(owner, mailboxPayload(bot, target, sessionId));
};

/** Subscribe the notifier to the mind's events; returns the unsubscribe. */
export const wirePushEvents = (mind: MindService, notifier: Notifier): (() => void) => {
  const stops = [
    mind.tasks.listen((task) => void onTask(mind, notifier, task).catch(logged("task"))),
    mind.approvals.listen(
      (conversationId, request) =>
        void onApproval(mind, notifier, conversationId, request.name).catch(logged("approval")),
    ),
    mind.mailbox.onExpired(
      (entry) => void onExpired(mind, notifier, entry).catch(logged("mailbox")),
    ),
  ];
  return () => {
    for (const stop of stops) stop();
  };
};

/** A routine (webhook/cron/sensor) turn settled with a reply in this session. */
export const pushRoutineReply = async (
  mind: MindService,
  notifier: Notifier,
  sessionId: string,
  source: RoutineSource,
): Promise<void> => {
  const row = await mind.profiles.rowOf(sessionId);
  if (row === undefined) return;
  const bot = await botName(mind, row.owner, row.profile);
  await notifier.notify(row.owner, routinePayload(bot, source, sessionId));
};
