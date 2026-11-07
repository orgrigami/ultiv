/**
 * A background shell job's end in the chat: finished (with its exit code) or
 * lost in a restart, the script's first line, and its output on expand.
 */
import { useId, useState } from "react";
import { TaskStatusIcon } from "@/components/task-status-icon";
import type { SystemMessage } from "@/lib/system-text";
import { CardShell, ShowMore } from "./card-shell";

type JobMessage = Extract<SystemMessage, { kind: "job" }>;

const headOf = (message: JobMessage): string =>
  message.outcome === "lost"
    ? "Background job lost in a restart"
    : message.exitCode === 0
      ? "Background job finished"
      : `Background job failed (exit ${message.exitCode ?? "?"})`;

export function JobCard({ message, at }: { message: JobMessage; at: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const status =
    message.outcome === "lost" ? "cancelled" : message.exitCode === 0 ? "done" : "failed";
  return (
    <CardShell
      icon={<TaskStatusIcon status={status} />}
      title={
        <>
          {headOf(message)}
          {message.title !== "" && (
            <span className="text-muted-foreground font-normal"> · {message.title}</span>
          )}
        </>
      }
      at={at}
      tone={status === "failed" ? "danger" : status === "cancelled" ? "muted" : "plain"}
    >
      {message.body !== "" && (
        <div className="flex flex-col items-start gap-1">
          <ShowMore
            open={open}
            onToggle={() => setOpen((value) => !value)}
            more={message.outcome === "lost" ? "Show details" : "Show output"}
            controls={id}
          />
          {open && (
            <pre
              id={id}
              className="readout bg-muted max-h-80 w-full overflow-auto rounded-lg p-2 text-xs whitespace-pre-wrap"
            >
              {message.body}
            </pre>
          )}
        </div>
      )}
    </CardShell>
  );
}
