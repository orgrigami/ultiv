/**
 * The side nav's bot switcher (sm+): the shared bot panel anchored to an
 * avatar button — avatar-only on the rail, a name+role row from lg: up. A
 * spinner shows while this bot runs a task, a destructive dot when a gate
 * needs the owner. Onboarding keeps a disabled placeholder (no popover).
 * "What X remembers" opens a MemoryPanel owned HERE, in the nav tree, so it
 * works from every page.
 */
import { Popover } from "@base-ui/react/popover";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { BotPanel } from "@/components/bot-panel";
import { Spinner } from "@/components/ui/spinner";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { useApp } from "@/lib/app-state";

export function NavSwitcher({ botId }: { botId: string | undefined }) {
  const { sessions, attention, busy } = useApp();
  const [open, setOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const bot = sessions.profiles.find((candidate) => candidate.id === botId);

  if (sessions.phase !== "live" || sessions.profiles.length === 0 || bot === undefined) {
    return (
      <span
        title="Create a bot first"
        className="flex items-center gap-3 rounded-lg p-2 lg:px-2 lg:py-1.5"
      >
        <BotAvatar name="?" size="lg" />
        <span className="hidden min-w-0 flex-1 flex-col leading-tight lg:flex">
          <span className="truncate text-sm font-medium">No bot yet</span>
          <span className="text-muted-foreground truncate text-xs">Create one to start</span>
        </span>
      </span>
    );
  }

  const needsYou = attention.has(bot.id);
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={`${bot.name}: switch bot`}
          className="hover:bg-muted focus-visible:ring-ring/50 pointer-coarse:min-h-11 flex min-w-0 cursor-pointer items-center gap-3 rounded-lg p-2 text-left outline-none focus-visible:ring-3 lg:px-2 lg:py-1.5"
        >
          <span className="relative shrink-0">
            <BotAvatar name={bot.name} size="lg" />
            {needsYou && (
              <span className="bg-destructive ring-background absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2" />
            )}
          </span>
          <span className="hidden min-w-0 flex-1 flex-col leading-tight lg:flex">
            <span className="flex items-center gap-1 text-sm font-medium">
              <span className="truncate">{bot.name}</span>
            </span>
            <span className="text-muted-foreground block truncate text-xs">
              {needsYou
                ? "Needs your approval"
                : bot.description !== ""
                  ? bot.description
                  : "No role yet"}
            </span>
          </span>
          {busy.has(bot.id) && (
            <Spinner className="hidden size-3.5 shrink-0 text-emerald-500 lg:block" />
          )}
          <ChevronDownIcon className="text-muted-foreground hidden size-4 shrink-0 lg:block" />
        </Popover.Trigger>
        <BotPanel currentId={bot.id} onMemory={() => setMemoryOpen(true)} />
      </Popover.Root>
      {bot !== undefined && (
        <MemoryPanel
          profileId={bot.id}
          name={bot.name}
          open={memoryOpen}
          onOpenChange={setMemoryOpen}
        />
      )}
    </>
  );
}
