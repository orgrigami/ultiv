/**
 * The task's steps on one timeline, drawn like the chat it came from: tool
 * calls through the same presentation lens (consecutive calls form one run,
 * numbered by call), thinking as the same folded Trace row, the bot's
 * messages as prose and its progress notes as quiet lines. Every step leads
 * with a 16px mark in the same column, so the eye runs down one edge.
 */
import { MegaphoneIcon, MessageSquareIcon, UserIcon, type LucideIcon } from "lucide-react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { ThinkingTrace } from "@/components/thinking-trace";
import { ToolTrace } from "@/components/tool-trace";
import { Trace } from "@/components/ui/trace";
import { toolStepOf, type TimelineItem } from "@/lib/task-steps";
import { cn } from "@/lib/utils";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type Row =
  | { kind: "tools"; key: string; tools: { item: ToolItem; index: number }[] }
  | { kind: "step"; key: string; item: Exclude<TimelineItem, ToolItem> };

/** Consecutive tool calls become one run; the index counts calls only. */
export function rowsOf(items: readonly TimelineItem[]): Row[] {
  const rows: Row[] = [];
  let calls = 0;
  for (const item of items) {
    if (item.kind === "tool") {
      calls += 1;
      const last = rows.at(-1);
      if (last?.kind === "tools") last.tools.push({ item, index: calls });
      else rows.push({ kind: "tools", key: item.key, tools: [{ item, index: calls }] });
    } else rows.push({ kind: "step", key: item.key, item });
  }
  return rows;
}

const KIND_ICON: Record<"message" | "note" | "input", LucideIcon> = {
  message: MessageSquareIcon,
  note: MegaphoneIcon,
  input: UserIcon,
};

const LABEL = { note: "Update", input: "You", message: null } as const;

/** A said thing: the bot's interim message, a progress note, the parent's steer. */
function Said({ item }: { item: Extract<TimelineItem, { kind: "message" | "note" | "input" }> }) {
  const Icon = KIND_ICON[item.kind];
  const label = LABEL[item.kind];
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div
        className={cn(
          "min-w-0 flex-1 text-sm break-words",
          item.kind === "message" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label !== null && (
          <span className="text-foreground/80 me-1.5 text-xs font-medium">{label}</span>
        )}
        {item.kind === "message" ? (
          <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <LazyMarkdown text={item.text} />
          </div>
        ) : (
          <span className="whitespace-pre-wrap">{item.text}</span>
        )}
      </div>
    </div>
  );
}

export function Timeline({ items, running }: { items: readonly TimelineItem[]; running: boolean }) {
  if (items.length === 0)
    return (
      <p className="text-muted-foreground py-2 text-sm">
        {running ? "Getting started…" : "No steps to show."}
      </p>
    );
  const rows = rowsOf(items);
  return (
    <ol aria-label="Steps" className="flex min-w-0 flex-col gap-3">
      {rows.map((row, index) => (
        <li key={row.key} className="min-w-0">
          {row.kind === "tools" ? (
            <Trace>
              {row.tools.map(({ item, index: call }) => (
                <ToolTrace key={item.key} step={toolStepOf(item)} index={call} />
              ))}
            </Trace>
          ) : row.item.kind === "thinking" ? (
            <ThinkingTrace text={row.item.text} live={running && index === rows.length - 1} />
          ) : (
            <Said item={row.item} />
          )}
        </li>
      ))}
    </ol>
  );
}
