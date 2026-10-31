/**
 * The transcript body: markdown output, collapsed reasoning, tool traces and
 * machinery notes, grouped so consecutive tool steps read as one sequence.
 */
import { memo, useState } from "react";
import { AttachmentChips } from "@/components/attachment-chips";
import { useApp } from "@/lib/app-state";
import { formatDivider, formatFull } from "@/lib/format";
import { readNote } from "@/lib/note-text";
import { parseSystem } from "@/lib/system-text";
import { SystemCard } from "@/components/system/system-card";
import { ToolGroup } from "@/components/tool-trace";
import type { TaskInfo, ToolStep, TranscriptEntry } from "@ultiv/contracts";
import { BrainIcon, CircleSlashIcon } from "lucide-react";
import type { JevNotice } from "@/lib/jev-text";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

// The bot speaks on the open transcript; the owner
// writes on a quiet raised card to the right.
const roleStyles = {
  user: "self-end max-w-[80%] rounded-xl bg-muted/70 px-3.5 py-2.5 text-chat whitespace-pre-wrap break-words",
} as const;

// Past this much text a finished reply folds; the fold is a reading aid,
// never a wall.
const FOLD_CHARS = 1200;
const FOLD_LINES = 24;

/** A new divider when this much time passed since the previous message. */
const DIVIDER_GAP_MS = 10 * 60_000;

/**
 * Bot output is markdown; the newest block streams with a caret (still under
 * reduced motion). Finished messages get a copy action under the bubble.
 * A reply cut short by Stop or Redirect now keeps its text, marked "Interrupted".
 * Memoised: only the message whose text changes re-renders while streaming.
 */
const Output = memo(function Output({
  text,
  streaming,
  interrupted,
}: {
  text: string;
  streaming: boolean;
  interrupted: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Cut while thinking: nothing was said, so only the marker shows.
  const empty = text === "" && !streaming;
  const foldable =
    !streaming && !open && (text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES);
  const copy = !streaming && !empty && (
    <div className="opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 pointer-coarse:opacity-100">
      <CodeBlockCopyButton
        value={text}
        aria-label="Copy message"
        className="text-muted-foreground"
      />
    </div>
  );
  return (
    <>
      {!empty && (
        <div className="min-w-0 max-w-full">
          <div
            className={
              "prose prose-sm chat-prose dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5 [&_hr]:my-3 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_pre]:my-2 [&_code]:[overflow-wrap:anywhere] " +
              (foldable
                ? "max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_72%,transparent)]"
                : "")
            }
          >
            <LazyMarkdown text={text} />
            {streaming && (
              <span aria-hidden className="motion-safe:animate-pulse">
                ▍
              </span>
            )}
          </div>
          {foldable && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="readout text-muted-foreground hover:text-foreground mt-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 outline-none"
            >
              Show more
            </button>
          )}
          {open && text.length > FOLD_CHARS && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="readout text-muted-foreground hover:text-foreground mt-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 outline-none"
            >
              Show less
            </button>
          )}
        </div>
      )}
      {interrupted && (
        <span className="text-muted-foreground flex items-center gap-1 px-1 text-xs">
          <CircleSlashIcon className="size-3" aria-hidden />
          {empty ? "Interrupted before replying" : "Interrupted"}
        </span>
      )}
      {copy}
    </>
  );
});

/** Reasoning as a collapsed Trace step: "Thinking…" while live, then past tense. */
const Thinking = memo(function Thinking({ text, live }: { text: string; live: boolean }) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <BrainIcon />
            </TraceIcon>
            <TraceTitle>{live ? "Thinking…" : "Thought for a moment"}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p className="text-sm whitespace-pre-wrap italic">{text}</p>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});

/** A machinery note: small caption + markdown body, in owner-facing words. */
const Note = memo(function Note({ text }: { text: string }) {
  const { sessions } = useApp();
  const note = readNote(text, (id) => sessions.profiles.find((bot) => bot.id === id)?.name);
  return (
    <>
      <span className="text-foreground/70 text-xs font-medium">{note.header}</span>
      <div className="break-words [&_p:first-child]:mt-1 [&_p:last-child]:mb-0">
        <LazyMarkdown text={note.body} />
      </div>
    </>
  );
});

/** Consecutive tool steps render as one Trace so a run reads as a sequence. */
type Group =
  | { key: string; at: number; tools: ToolStep[] }
  | { key: string; at: number; entry: TranscriptEntry };

function groupTranscript(transcript: TranscriptEntry[]): Group[] {
  const groups: Group[] = [];
  for (const entry of transcript) {
    const last = groups[groups.length - 1];
    if (entry.kind === "tool") {
      if (last !== undefined && "tools" in last) {
        last.tools.push(entry.step);
        continue;
      }
      groups.push({ key: String(entry.id), at: entry.at, tools: [entry.step] });
      continue;
    }
    groups.push({ key: String(entry.id), at: entry.at, entry });
  }
  return groups;
}

/** Every transcript entry, in order, as list items. busy marks the last reasoning as live. */
export function TranscriptItems({
  transcript,
  busy = false,
  tasks = [],
  jevNotices,
  onOpenMemory,
}: {
  transcript: TranscriptEntry[];
  busy?: boolean;
  /** This chat's background tasks, so task cards can show title and duration. */
  tasks?: readonly TaskInfo[];
  /** Jev's gate decisions by tool call id. */
  jevNotices?: ReadonlyMap<string, JevNotice> | undefined;
  /** Opens this chat's bot Memory panel with a search pre-filled (memory chips). */
  onOpenMemory?: ((query: string) => void) | undefined;
}) {
  return (
    <>
      {groupTranscript(transcript).map((group, index, groups) => {
        const previous = groups[index - 1];
        const divider =
          previous === undefined || group.at - previous.at >= DIVIDER_GAP_MS ? (
            <li
              key={`divider-${group.key}`}
              role="separator"
              className="text-muted-foreground/70 flex items-center gap-3 self-stretch py-1"
            >
              <span className="bg-border h-px flex-1" />
              <span className="readout">{formatDivider(group.at)}</span>
              <span className="bg-border h-px flex-1" />
            </li>
          ) : null;
        return [
          divider,
          renderGroup(group, busy && index === groups.length - 1, tasks, jevNotices, onOpenMemory),
        ];
      })}
    </>
  );
}

/**
 * Bracketed machinery (task results, webhooks, cron, sensors, bot mail) as a
 * compact card; undefined when the text is not one, null when it is hidden.
 */
function systemItem(entry: TranscriptEntry, key: string, tasks: readonly TaskInfo[]) {
  if (entry.kind !== "input" && entry.kind !== "note") return undefined;
  const message = parseSystem(entry.text);
  if (message === null) return undefined;
  if (message.kind === "hidden") return null;
  return (
    <li key={key} className="w-full">
      <SystemCard message={message} at={entry.at} tasks={tasks} />
    </li>
  );
}

function renderGroup(
  group: Group,
  last: boolean,
  tasks: readonly TaskInfo[],
  jevNotices?: ReadonlyMap<string, JevNotice> | undefined,
  onOpenMemory?: ((query: string) => void) | undefined,
) {
  const system = "tools" in group ? undefined : systemItem(group.entry, group.key, tasks);
  if (system !== undefined) return system;
  return "tools" in group ? (
    <li key={group.key} className="w-full">
      <Trace>
        <ToolGroup tools={group.tools} jevNotices={jevNotices} onOpenMemory={onOpenMemory} />
      </Trace>
    </li>
  ) : group.entry.kind === "input" ? (
    <li key={group.key} className={roleStyles.user} title={formatFull(group.entry.at)}>
      {group.entry.text}
      {group.entry.attachments !== undefined && group.entry.attachments.length > 0 && (
        <AttachmentChips attachments={group.entry.attachments} />
      )}
    </li>
  ) : group.entry.kind === "output" ? (
    <li
      key={group.key}
      className="group/msg flex max-w-[80%] min-w-0 flex-col items-start gap-0.5 self-start"
      title={formatFull(group.entry.at)}
    >
      <Output
        text={group.entry.text}
        streaming={group.entry.streaming}
        interrupted={group.entry.interrupted === true}
      />
    </li>
  ) : group.entry.kind === "thinking" ? (
    <li key={group.key} className="w-full">
      <Thinking text={group.entry.text} live={last} />
    </li>
  ) : group.entry.kind === "note" ? (
    <li
      key={group.key}
      className="border-border/70 text-muted-foreground w-full rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed"
      title={formatFull(group.entry.at)}
    >
      <Note text={group.entry.text} />
    </li>
  ) : null;
}
