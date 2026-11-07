/** How the task ended: the result as markdown with copy, or the failure in plain words. */
import { useState } from "react";
import type { TaskInfo } from "@spriessen/contracts";
import { CheckIcon, CircleAlertIcon, CopyIcon } from "lucide-react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { Button } from "@/components/ui/button";
import { writeClipboard } from "@/lib/clipboard";
import { Tile } from "@/components/ui/tile";
import { Heading } from "@/components/ui/heading";

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    try {
      await writeClipboard(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1_500);
  };
  return (
    <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label="Copy result">
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy"}
      </span>
    </Button>
  );
}

export function ResultCard({ task }: { task: TaskInfo }) {
  if (task.status === "failed")
    return (
      <Tile tone="danger" className="flex gap-2.5 p-3 text-sm">
        <CircleAlertIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">It didn't finish</p>
          <p className="text-muted-foreground mt-0.5 break-words">
            {task.error ?? "Unknown failure."}
          </p>
        </div>
      </Tile>
    );
  if (task.status === "cancelled")
    return <p className="text-muted-foreground text-center text-sm">You stopped this task.</p>;
  if (task.status !== "done") return null;
  const text = task.result ?? "";
  // A structured result is data: shown as a JSON block, with a note when the
  // task's reply never matched the format it was asked for.
  const shaped = task.resultSchema !== undefined;
  const missed = shaped && (task.structured === null || task.structured === undefined);
  const shown = shaped && !missed ? `\`\`\`json\n${text}\n\`\`\`` : text;
  return (
    <Tile tone="surface" render={<section aria-label="Result" />} className="p-3">
      <div className="flex items-center gap-2">
        <Heading level={3} size="sm" className="flex-1">
          {shaped && !missed ? "Result (JSON)" : "Result"}
        </Heading>
        {text !== "" && <CopyButton text={text} />}
      </div>
      {text === "" ? (
        <p className="text-muted-foreground mt-1 text-sm">Finished without a written result.</p>
      ) : (
        <div className="prose prose-sm dark:prose-invert mt-1 max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {missed && (
            <p className="text-muted-foreground text-sm">
              The task's reply didn't match the format it was asked for. Its raw reply:
            </p>
          )}
          <LazyMarkdown text={shown} />
        </div>
      )}
    </Tile>
  );
}
