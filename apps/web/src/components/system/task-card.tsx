/**
 * A background task's outcome in the chat: status icon, its title, how long
 * it ran, a one-line preview and "Show full result" (markdown, copyable).
 * Failed and stopped tasks read differently at a glance.
 */
import { useId, useState } from "react";
import type { TaskInfo } from "@spreissen/contracts";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { TaskStatusIcon } from "@/components/task-status-icon";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import type { SystemMessage } from "@/lib/system-text";
import { firstLine } from "@/lib/system-text";
import { taskElapsed, taskTitle } from "@/lib/task-text";
import { CardShell, ShowMore } from "./card-shell";

type TaskMessage = Extract<SystemMessage, { kind: "task" }>;

const HEAD = { done: "Task finished", failed: "Task failed", cancelled: "Task stopped" } as const;

/** The wake digest without the bot-facing "[truncated — …]" pointer. */
const cleanDigest = (body: string): string =>
  body.replace(/\n\[truncated — [^\]]*\]\s*$/, "").trim();

function FullResult({ text, ran }: { text: string; ran: string | undefined }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preview = firstLine(text);
  const more = text.trim() !== preview;
  return (
    <div className="flex flex-col items-start gap-0.5">
      {!open && <p className="text-muted-foreground line-clamp-2 break-words">{preview}</p>}
      {open && (
        <div
          id={id}
          className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        >
          <LazyMarkdown text={text} />
        </div>
      )}
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {ran !== undefined && <span>Ran {ran}</span>}
        {more && (
          <ShowMore
            open={open}
            onToggle={() => setOpen((v) => !v)}
            more="Show full result"
            controls={id}
          />
        )}
        <CodeBlockCopyButton
          value={text}
          aria-label="Copy result"
          className="text-muted-foreground"
        />
      </span>
    </div>
  );
}

export function TaskCard({
  message,
  at,
  task,
}: {
  message: TaskMessage;
  at: number;
  task: TaskInfo | undefined;
}) {
  const title = task !== undefined ? taskTitle(task) : "Background task";
  const duration =
    task !== undefined && task.finishedAt !== null ? taskElapsed(task, at) : undefined;
  const tone =
    message.outcome === "failed" ? "danger" : message.outcome === "cancelled" ? "muted" : "plain";
  return (
    <CardShell
      icon={<TaskStatusIcon status={message.outcome} />}
      title={
        <>
          {HEAD[message.outcome]}
          <span className="text-muted-foreground font-normal"> · {title}</span>
        </>
      }
      at={at}
      tone={tone}
    >
      {message.outcome === "done" && (
        <FullResult text={task?.result ?? cleanDigest(message.body)} ran={duration} />
      )}
      {message.outcome === "failed" && (
        <p className="text-destructive break-words">
          {firstLine(task?.error ?? message.body, 280)}
        </p>
      )}
      {message.outcome === "cancelled" && (
        <p className="text-muted-foreground">
          Stopped before it finished{duration !== undefined ? `, after ${duration}` : ""}.
        </p>
      )}
    </CardShell>
  );
}
