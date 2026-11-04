/**
 * The transcript body: markdown output, collapsed reasoning, tool traces and
 * machinery notes, grouped so consecutive tool steps read as one sequence.
 */
import { memo } from "react";
import { AttachmentChips } from "@/components/attachment-chips";
import { useApp } from "@/lib/app-state";
import { formatDivider, formatFull } from "@/lib/format";
import { readNote } from "@/lib/note-text";
import { parseSystem } from "@/lib/system-text";
import { SystemCard } from "@/components/system/system-card";
import { ToolGroup } from "@/components/tool-trace";
import { latestPlans } from "@/lib/chat-tool-views";
import type { TaskInfo, ToolStep, TranscriptEntry } from "@spriessen/contracts";
import { BrainIcon, CircleSlashIcon } from "lucide-react";
import type { JevNotice } from "@/lib/jev-text";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { ChatProse, isFoldable } from "@/components/chat-prose";
import { MessageActions, TurnHead } from "@/components/message-parts";
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
  user: "self-end max-w-[85%] rounded-2xl rounded-br-md bg-muted/70 px-4 py-2.5 text-chat whitespace-pre-wrap break-words sm:max-w-[75%]",
} as const;

// Past this much text a finished reply folds; the fold budget and the
// prose container live in chat-prose.tsx (shared with the rooms timeline).

/** A new divider when this much time passed since the previous message. */
const DIVIDER_GAP_MS = 10 * 60_000;

/**
 * Bot output is markdown; the newest block streams with a caret at the end
 * of its last line (still under reduced motion). A finished message gets one
 * action row: copy, plus "Interrupted" when Stop or Redirect cut it short (the
 * partial reply keeps its text). Memoised: only the message whose text
 * changes re-renders while streaming.
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
  // Cut while thinking: nothing was said, so only the marker shows.
  const empty = text === "" && !streaming;
  return (
    <>
      {!empty && <ChatProse text={text} streaming={streaming} foldable={isFoldable(text)} />}
      {!streaming && (
        <MessageActions
          text={text}
          status={
            interrupted && (
              <span className="flex items-center gap-1">
                <CircleSlashIcon className="size-3" aria-hidden />
                {empty ? "Interrupted before replying" : "Interrupted"}
              </span>
            )
          }
        />
      )}
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
          <p className="text-muted-foreground text-sm whitespace-pre-wrap">{text}</p>
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

const isOwnerInput = (group: Group | undefined): boolean =>
  group !== undefined && !("tools" in group) && group.entry.kind === "input";

/** The bot's side begins: output, reasoning or tools right after the owner spoke. */
function startsBotTurn(group: Group, previous: Group | undefined): boolean {
  if (isOwnerInput(group)) return false;
  if (!("tools" in group) && group.entry.kind === "note") return false;
  return previous === undefined || isOwnerInput(previous);
}

/** The group that opens the newest bot turn, or -1 when the owner spoke last. */
function lastHeadIndex(groups: readonly Group[]): number {
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (group === undefined || isOwnerInput(group)) return -1;
    if (startsBotTurn(group, groups[index - 1])) return index;
  }
  return -1;
}

/** Every transcript entry, in order, as list items. busy marks the last reasoning as live. */
export function TranscriptItems({
  transcript,
  busy = false,
  tasks = [],
  jevNotices,
  onOpenMemory,
  bot,
}: {
  transcript: TranscriptEntry[];
  busy?: boolean;
  /** This chat's background tasks, so task cards can show title and duration. */
  tasks?: readonly TaskInfo[];
  /** Jev's gate decisions by tool call id. */
  jevNotices?: ReadonlyMap<string, JevNotice> | undefined;
  /** Opens this chat's bot Memory panel with a search pre-filled (memory chips). */
  onOpenMemory?: ((query: string) => void) | undefined;
  /** The chat's bot: its face and name head each of its turns. */
  bot?: { id?: string | undefined; name: string } | undefined;
}) {
  const groups = groupTranscript(latestPlans(transcript));
  // The newest bot turn's face thinks while the bot works.
  const liveHead = busy ? lastHeadIndex(groups) : -1;
  return (
    <>
      {groups.map((group, index) => {
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
        const head =
          bot !== undefined && startsBotTurn(group, previous) ? (
            <li key={`head-${group.key}`} className="-mb-1 self-start pt-2">
              <TurnHead
                id={bot.id}
                name={bot.name}
                at={group.at}
                mood={index === liveHead ? "thinking" : "idle"}
              />
            </li>
          ) : null;
        return [
          divider,
          head,
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
      className="group/msg flex w-full min-w-0 flex-col items-start gap-0.5 self-start sm:max-w-[85%]"
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
