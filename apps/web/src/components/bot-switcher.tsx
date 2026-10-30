/**
 * The chat-header pill (every width): tap it for the shared bot panel
 * (bots with role lines and activity, New bot, What-X-remembers, Bot talks).
 * The side nav has its own switcher block; the pill keeps the chat's own
 * context under the pointer. Link state stays in the SessionDetails popover.
 */
import { Popover } from "@base-ui/react/popover";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { BotPanel } from "@/components/bot-panel";
import { useApp } from "@/lib/app-state";

export function BotSwitcher({
  name,
  currentId,
  onMemory,
}: {
  /** The name on the pill (the chat's bot). */
  name: string;
  /** The bot whose chat is on screen. */
  currentId: string | undefined;
  /** Opens this bot's Memory panel (absent when there is no bot). */
  onMemory?: (() => void) | undefined;
}) {
  const { attention } = useApp();
  const [open, setOpen] = useState(false);
  // Another bot's gate may need the owner; this chat's own card handles its own.
  const waiting = [...attention].some((id) => id !== currentId);

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={`${name}: switch bot`}
          className="bg-background/60 supports-backdrop-filter:bg-background/40 hover:bg-muted/80 border-border/60 relative flex max-w-full min-w-0 cursor-pointer pointer-coarse:min-h-11 items-center gap-2 rounded-full border py-1 pr-2.5 pl-1 shadow-sm backdrop-blur-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BotAvatar name={name} />
          <span className="flex min-w-0 flex-col text-left leading-tight">
            <span className="truncate text-sm font-medium">{name}</span>
          </span>
          <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
          {waiting && (
            <span
              className="bg-destructive ring-background absolute top-0.5 left-6 size-2.5 rounded-full ring-2"
              aria-label="Another bot needs your approval"
            />
          )}
        </Popover.Trigger>
        <BotPanel currentId={currentId} onMemory={onMemory} />
      </Popover.Root>
    </>
  );
}
