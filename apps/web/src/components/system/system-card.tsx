/** One parsed system message as its card or line (see lib/system-text). */
import type { TaskInfo } from "@spreissen/contracts";
import type { SystemMessage } from "@/lib/system-text";
import { taskTitle } from "@/lib/task-text";
import { BotCard, NackCard } from "./bot-card";
import { EventLine } from "./event-line";
import { TaskCard } from "./task-card";
import { WebhookCard } from "./webhook-card";

export function SystemCard({
  message,
  at,
  tasks,
}: {
  message: Exclude<SystemMessage, { kind: "hidden" }>;
  at: number;
  tasks: readonly TaskInfo[];
}) {
  switch (message.kind) {
    case "task":
      return (
        <TaskCard message={message} at={at} task={tasks.find((t) => t.id === message.taskId)} />
      );
    case "task-update": {
      const task = tasks.find((t) => t.id === message.taskId);
      const title = task === undefined ? undefined : taskTitle(task);
      // Bots often start the update with the task's name; don't say it twice.
      const text =
        title !== undefined && message.text.startsWith(`${title}:`)
          ? message.text.slice(title.length + 1).trim()
          : message.text;
      return <EventLine kind="update" text={text} at={at} label={title} />;
    }
    case "webhook":
      return <WebhookCard message={message} at={at} />;
    case "cron":
      return <EventLine kind="cron" text={message.text} at={at} />;
    case "sensor":
      return <EventLine kind="sensor" text={message.text} at={at} label={message.source} />;
    case "bot":
      return <BotCard message={message} at={at} />;
    case "nack":
      return <NackCard message={message} at={at} />;
    case "quiet":
      return <EventLine kind="quiet" text={message.text} at={at} />;
  }
}
