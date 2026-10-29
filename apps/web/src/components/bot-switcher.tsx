/**
 * The header pill is the bot switcher: tap it for every bot (avatar, name,
 * role, a star on the main bot, a dot when one needs your approval) plus
 * "New bot". Picking one opens that bot's main chat. A popover on every size,
 * anchored under the pill, so nothing in the layout moves.
 */
import { Popover } from "@base-ui/react/popover";
import { useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  PlugIcon,
  SettingsIcon,
  StarIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { NewBotDialog } from "@/components/bot-dialog";
import { BotAvatar, linkLabel, type LinkState } from "@/components/bot-avatar";
import { useApp } from "@/lib/app-state";

const row =
  "hover:bg-muted focus-visible:bg-muted flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none";

export function BotSwitcher({
  name,
  currentId,
  link,
  onMemory,
}: {
  /** The name on the pill (the chat's bot). */
  name: string;
  /** The bot whose chat is on screen. */
  currentId: string | undefined;
  link: LinkState;
  /** Opens this bot's Memory panel (absent when there is no bot). */
  onMemory?: (() => void) | undefined;
}) {
  const { sessions, mainId, attention, refreshAll } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const bots = sessions.profiles
    .filter((bot) => bot.archivedAt === null)
    .sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  const waiting = [...attention].some((id) => id !== currentId);

  const pick = (id: string): void => {
    void navigate({ to: "/", search: id === mainId ? {} : { bot: id } });
  };

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
            {link !== "live" && (
              <span
                className={`text-xs ${link === "lost" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {linkLabel[link]}
              </span>
            )}
          </span>
          <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
          {waiting && (
            <span
              className="bg-destructive ring-background absolute top-0.5 left-6 size-2.5 rounded-full ring-2"
              aria-label="Another bot needs your approval"
            />
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="center" sideOffset={8} className="z-50">
            <Popover.Popup className="bg-popover/95 text-popover-foreground flex max-h-[min(28rem,70dvh)] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-y-auto rounded-xl border p-1.5 shadow-lg backdrop-blur-xl outline-none">
              <p className="text-muted-foreground px-2 pt-1 pb-1.5 text-xs font-medium">
                Switch bot
              </p>
              <ul className="flex flex-col">
                {bots.map((bot) => {
                  const needsYou = attention.has(bot.id);
                  const current = bot.id === currentId;
                  return (
                    <li key={bot.id}>
                      <Popover.Close
                        render={<button type="button" className={row} />}
                        aria-current={current ? "true" : undefined}
                        onClick={() => pick(bot.id)}
                      >
                        <span className="relative">
                          <BotAvatar name={bot.name} />
                          {needsYou && (
                            <span className="bg-destructive ring-popover absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1 text-sm font-medium">
                            <span className="truncate">{bot.name}</span>
                            {bot.id === mainId && (
                              <StarIcon
                                className="size-3.5 shrink-0 fill-amber-400 text-amber-400"
                                aria-label="Main bot"
                              />
                            )}
                          </span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {needsYou
                              ? "Needs your approval"
                              : bot.description !== ""
                                ? bot.description
                                : "No role yet"}
                          </span>
                        </span>
                        {current && <CheckIcon className="size-4 shrink-0" aria-label="Open now" />}
                      </Popover.Close>
                    </li>
                  );
                })}
              </ul>
              <div className="bg-border my-1 h-px" />
              {onMemory !== undefined && (
                <Popover.Close
                  className={row}
                  onClick={() => {
                    setOpen(false);
                    onMemory();
                  }}
                >
                  <span className="bg-muted inline-flex size-7 items-center justify-center rounded-full">
                    <BrainIcon className="size-4" />
                  </span>
                  <span className="text-sm font-medium">What {name} remembers</span>
                </Popover.Close>
              )}
              <button
                type="button"
                className={row}
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <span className="bg-muted inline-flex size-7 items-center justify-center rounded-full">
                  <PlusIcon className="size-4" />
                </span>
                <span className="text-sm font-medium">New bot</span>
              </button>
              <Popover.Close
                className={row}
                onClick={() =>
                  void navigate({
                    to: "/rooms",
                    search: currentId !== undefined ? { bot: currentId } : {},
                  })
                }
              >
                <span className="bg-muted inline-flex size-7 items-center justify-center rounded-full">
                  <UsersIcon className="size-4" />
                </span>
                <span className="text-sm font-medium">Bot talks</span>
              </Popover.Close>
              <Popover.Close className={row} onClick={() => void navigate({ to: "/connectors" })}>
                <span className="bg-muted inline-flex size-7 items-center justify-center rounded-full">
                  <PlugIcon className="size-4" />
                </span>
                <span className="text-sm font-medium">Connectors</span>
              </Popover.Close>
              <Popover.Close className={row} onClick={() => void navigate({ to: "/bots" })}>
                <span className="bg-muted inline-flex size-7 items-center justify-center rounded-full">
                  <SettingsIcon className="size-4" />
                </span>
                <span className="text-sm font-medium">Manage bots</span>
              </Popover.Close>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <NewBotDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (id) => {
          await refreshAll();
          pick(id);
        }}
      />
    </>
  );
}
