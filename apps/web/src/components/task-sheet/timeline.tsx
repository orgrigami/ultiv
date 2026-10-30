/**
 * The task's steps on one timeline: tool calls render through the same
 * presentation lens as the main transcript (numbered rows, shaped bodies),
 * thinking folds, the bot's messages read as prose. The newest step marks
 * itself live while the task runs.
 */
import {
  LightbulbIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { Mark } from "@/components/state-mark";
import { ToolTrace } from "@/components/tool-trace";
import { toolStepOf, type TimelineItem } from "@/lib/task-steps";
import { cn } from "@/lib/utils";

const KIND_ICON = {
  thinking: LightbulbIcon,
  message: MessageSquareIcon,
  note: MegaphoneIcon,
  input: UserIcon,
} as const;

/** The gutter mark: live work breathes, the rest stays quiet ink. */
function Gutter({ icon: Icon, live }: { icon: LucideIcon; live: boolean }) {
  if (live) return <Mark kind="working" tone="live" className="top-1.5 absolute left-1" />;
  return (
    <Icon
      aria-hidden
      className="text-muted-foreground/70 absolute top-2.5 left-1 size-4 shrink-0"
    />
  );
}

/** A thinking row that folds open. */
function ThinkFold({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="group/think py-1">
      <summary className="text-muted-foreground hover:text-foreground flex min-h-9 w-fit cursor-pointer list-none items-center gap-2 text-sm outline-none">
        {live ? "Thinking…" : "Thought for a moment"}
      </summary>
      <p className="text-muted-foreground mt-1 text-sm break-words whitespace-pre-wrap">{text}</p>
    </details>
  );
}

function Step({ item, live, index }: { item: TimelineItem; live: boolean; index: number }) {
  if (item.kind === "tool") {
    return (
      <div className="py-0.5">
        <ToolTrace step={toolStepOf(item)} index={index} />
      </div>
    );
  }
  const icon = KIND_ICON[item.kind];
  if (item.kind === "thinking") {
    return (
      <>
        <Gutter icon={icon} live={false} />
        <ThinkFold text={item.text} live={live} />
      </>
    );
  }
  return (
    <>
      <Gutter icon={icon} live={false} />
      <div
        className={cn("py-2 text-sm break-words", item.kind === "note" && "text-muted-foreground")}
      >
        {item.kind === "note" && <span className="section-label me-2">Update</span>}
        {item.kind === "input" && <span className="section-label me-2">You</span>}
        {item.kind === "message" ? (
          <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <LazyMarkdown text={item.text} />
          </div>
        ) : (
          <span className="whitespace-pre-wrap">{item.text}</span>
        )}
      </div>
    </>
  );
}

export function Timeline({ items, running }: { items: readonly TimelineItem[]; running: boolean }) {
  if (items.length === 0)
    return (
      <p className="text-muted-foreground py-2 text-sm">
        {running ? "Getting started…" : "No steps to show."}
      </p>
    );
  return (
    <ol aria-label="Steps" className="flex flex-col">
      {items.map((item, index) => (
        <li
          key={item.key}
          className="relative pl-7 last:before:hidden before:bg-border before:absolute before:top-8 before:bottom-0 before:left-[0.4375rem] before:w-px"
        >
          <Step item={item} live={running && index === items.length - 1} index={index + 1} />
        </li>
      ))}
    </ol>
  );
}
