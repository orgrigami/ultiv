/**
 * What the chat shows around the transcript: a skeleton while the link
 * connects, a greeting with starter chips when the chat is empty, and the
 * one-line live status (avatar + what the bot is doing) that doubles as the
 * typing indicator.
 */
import type { PendingApproval, TranscriptEntry } from "@spreissen/contracts";
import { presentationOf } from "@/lib/tool-text";
import { BotAvatar, type ChatBot } from "@/components/chat-header";
import { Mark } from "@/components/state-mark";
import { SUGGESTIONS } from "@/components/composer";
import { Button } from "@/components/ui/button";

export function ChatSkeleton() {
  const bar = "bg-muted/70 animate-pulse rounded-lg";
  return (
    <li aria-hidden className="flex flex-col gap-3 pt-2">
      <div className={`${bar} h-10 w-2/3 self-start`} />
      <div className={`${bar} h-8 w-1/2 self-end`} />
      <div className={`${bar} h-16 w-3/4 self-start`} />
    </li>
  );
}

export function EmptyChat({
  bot,
  onPick,
}: {
  bot?: ChatBot | undefined;
  onPick: (text: string) => void;
}) {
  const name = bot?.name !== undefined && bot.name !== "" ? bot.name : "your bot";
  return (
    <li className="flex flex-col items-center gap-3 px-2 pt-10 text-center">
      <BotAvatar id={bot?.id} name={name} size="hero" />
      <div className="flex flex-col gap-1">
        <p className="font-heading text-title font-semibold tracking-tight">{name}</p>
        {bot !== undefined && bot.description !== "" && (
          <p className="text-muted-foreground max-w-sm text-sm">{bot.description}</p>
        )}
      </div>
      <div className="flex max-w-md flex-wrap justify-center gap-2 pt-2">
        {SUGGESTIONS.map((text) => (
          <Button
            key={text}
            variant="outline"
            size="sm"
            className="h-auto rounded-full py-1.5 whitespace-normal"
            onClick={() => onPick(text)}
          >
            {text}
          </Button>
        ))}
      </div>
    </li>
  );
}

/** What the bot is doing right now, from the newest transcript entries. */
function activityOf(transcript: TranscriptEntry[], pending: PendingApproval): string {
  if (pending !== null) return "Waiting for your approval";
  const last = transcript[transcript.length - 1];
  if (last?.kind === "tool" && last.step.status === "running") {
    const presentation = presentationOf(last.step);
    if (presentation.kind === "hidden") return "Working…";
    return presentation.view.live;
  }
  if (last?.kind === "output" && last.streaming) return "Writing…";
  if (last?.kind === "thinking") return "Thinking…";
  return "Working…";
}

export function StatusRow({
  bot,
  transcript,
  pending,
}: {
  bot?: ChatBot | undefined;
  transcript: TranscriptEntry[];
  pending: PendingApproval;
}) {
  return (
    <li className="text-muted-foreground flex items-center gap-2 self-start text-sm">
      <BotAvatar id={bot?.id} name={bot?.name ?? "?"} size="sm" mood="thinking" />
      <Mark kind="working" tone="live" className="size-3" />
      <span>{activityOf(transcript, pending)}</span>
    </li>
  );
}
