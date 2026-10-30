/**
 * The side nav's bot switcher: an account-style block (big avatar, name and
 * role, an up-down chevron) anchoring the sidebar, from sm: up. A spinner
 * shows while this bot runs a task, a destructive dot when a gate needs the
 * owner. Onboarding keeps a disabled placeholder (no popover).
 * "What X remembers" opens a MemoryPanel owned HERE, in the nav tree, so it
 * works from every page.
 */
import { Popover } from "@base-ui/react/popover";
import { ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { BotPanel } from "@/components/bot-panel";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { Spinner } from "@/components/ui/spinner";
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
        className="border-sidebar-border bg-sidebar-accent/30 flex w-full items-center gap-3 rounded-xl border p-2.5 shadow-xs"
      >
        <BotAvatar name="?" size="xl" />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
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
          className="border-sidebar-border bg-sidebar-accent/50 hover:bg-sidebar-accent focus-visible:ring-sidebar-ring/40 pointer-coarse:min-h-11 relative flex w-full cursor-pointer items-center gap-3 rounded-xl border p-2.5 text-left shadow-xs outline-none focus-visible:ring-2"
        >
          <span className="ring-sidebar-border relative shrink-0 rounded-full ring-1">
            <BotAvatar name={bot.name} size="xl" />
            {needsYou && (
              <span className="bg-destructive ring-background absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2" />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium">{bot.name}</span>
            <span className="text-muted-foreground truncate text-xs">
              {needsYou
                ? "Needs your approval"
                : bot.description !== ""
                  ? bot.description
                  : "No role yet"}
            </span>
          </span>
          {busy.has(bot.id) && <Spinner className="size-3.5 shrink-0 text-emerald-500" />}
          <span className="bg-background/40 border-sidebar-border text-muted-foreground ms-auto flex shrink-0 items-center rounded-md border p-1">
            <ChevronsUpDownIcon className="size-3.5" />
          </span>
        </Popover.Trigger>
        <BotPanel currentId={bot.id} onMemory={() => setMemoryOpen(true)} />
      </Popover.Root>
      <MemoryPanel
        profileId={bot.id}
        name={bot.name}
        open={memoryOpen}
        onOpenChange={setMemoryOpen}
      />
    </>
  );
}
