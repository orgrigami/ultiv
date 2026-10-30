/**
 * The shared bot panel: the content of every bot-switcher popover, in one
 * place. The current bot leads (bigger avatar, role line, a spinner while it
 * runs a task); the rest follow with role lines and their latest activity.
 * Utility rows under a divider: this bot's memory, a new bot, bot talks,
 * and a Connect apps footer into the Tools page. Hosts (the nav switcher
 * and the chat-header pill) render only a trigger.
 */
import { Popover } from "@base-ui/react/popover";
import { useNavigate } from "@tanstack/react-router";
import { BrainIcon, CheckIcon, PlugIcon, PlusIcon, StarIcon, UsersIcon } from "lucide-react";
import { Mark } from "@/components/state-mark";
import { useState } from "react";
import { NewBotDialog } from "@/components/bot-dialog";
import { BotAvatar } from "@/components/bot-avatar";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const row =
  "hover:bg-muted focus-visible:bg-muted flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none";

/**
 * One activity timestamp per bot: the latest lastMessageAt across its
 * sessions. The all-sessions list is always loaded app-wide, so this is a
 * pure client-side fold.
 */
function lastActiveOf(
  rows: readonly { profile: string; lastMessageAt: number }[],
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const session of rows) {
    const at = latest.get(session.profile);
    if (at === undefined || session.lastMessageAt > at) {
      latest.set(session.profile, session.lastMessageAt);
    }
  }
  return latest;
}

export function BotPanel({
  currentId,
  onMemory,
}: {
  /** The bot whose chat is on screen (the lead block); undefined = none. */
  currentId: string | undefined;
  /** Opens the host's Memory panel; the panel instance lives in the host. */
  onMemory?: (() => void) | undefined;
}) {
  const { sessions, mainId, attention, busy, refreshAll } = useApp();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const now = useNow(30_000, true);

  const bots = sessions.profiles.filter((bot) => bot.archivedAt === null);
  const current = bots.find((bot) => bot.id === currentId);
  const rest = bots
    .filter((bot) => bot.id !== current?.id)
    .sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  const latest = lastActiveOf(sessions.sessions);
  const name = current?.name ?? "";

  const pick = (id: string): void => {
    void navigate({ to: "/", search: id === mainId ? {} : { bot: id } });
  };

  return (
    <>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="center" sideOffset={8} className="z-50">
          <Popover.Popup className="bg-popover/95 text-popover-foreground flex max-h-[min(28rem,70dvh)] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-y-auto rounded-xl border p-1.5 shadow-lg backdrop-blur-xl outline-none">
            {current !== undefined && (
              <div className="flex items-center gap-3 px-2 pt-2 pb-1" aria-current="true">
                <span className="relative">
                  <BotAvatar name={current.name} size="xl" />
                  {attention.has(current.id) && (
                    <Mark
                      kind="attention"
                      tone="signal"
                      className="ring-popover absolute -top-1 -right-1.5 size-3.5 rounded-full ring-2"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-medium">
                    <span className="truncate">{current.name}</span>
                    {current.id === mainId && (
                      <StarIcon
                        className="size-3.5 shrink-0 fill-live text-live"
                        aria-label="Main bot"
                      />
                    )}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {attention.has(current.id)
                      ? "Needs your approval"
                      : current.description !== ""
                        ? current.description
                        : "No role yet"}
                  </span>
                </span>
                {busy.has(current.id) && (
                  <Mark kind="working" tone="live" className="live-breathe" />
                )}
                <CheckIcon className="size-4 shrink-0" aria-label="Open now" />
              </div>
            )}
            <ul className="flex flex-col">
              {rest.map((bot) => {
                const needsYou = attention.has(bot.id);
                const at = latest.get(bot.id);
                return (
                  <li key={bot.id}>
                    <Popover.Close
                      render={<button type="button" className={row} />}
                      aria-current={bot.id === currentId ? "true" : undefined}
                      onClick={() => pick(bot.id)}
                    >
                      <span className="relative">
                        <BotAvatar name={bot.name} />
                        {needsYou && (
                          <Mark
                            kind="attention"
                            tone="signal"
                            className="ring-popover absolute -top-1 -right-1.5 size-3.5 rounded-full ring-2"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 text-sm font-medium">
                          <span className="truncate">{bot.name}</span>
                          {bot.id === mainId && (
                            <StarIcon
                              className="size-3.5 shrink-0 fill-live text-live"
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
                      {busy.has(bot.id) && (
                        <Mark
                          kind="working"
                          tone="live"
                          className="live-breathe size-3"
                          aria-label="Running a task"
                        />
                      )}
                      {at !== undefined && (
                        <time className="text-muted-foreground shrink-0 text-xs">
                          {formatWhen(at, new Date(now))}
                        </time>
                      )}
                    </Popover.Close>
                  </li>
                );
              })}
            </ul>
            <div className="bg-border my-1 h-px" />
            {onMemory !== undefined && name !== "" && (
              <Popover.Close
                className={row}
                onClick={() => {
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
            <Popover.Close
              className={row}
              onClick={() => void navigate({ to: "/tools", search: { tab: "connectors" } })}
            >
              <span className="bg-muted inline-flex size-7 items-center justify-center rounded-full">
                <PlugIcon className="size-4" />
              </span>
              <span className="text-sm font-medium">Connect apps</span>
            </Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
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
