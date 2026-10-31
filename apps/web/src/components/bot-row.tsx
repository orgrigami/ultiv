/**
 * One bot on the Bots page: avatar, name and role open its main chat; the
 * "…" menu holds memory, edit, make-main, hide and remove, each in words.
 * Hiding is the safe option (reversible, moves the bot under "Hidden");
 * remove purges everything and asks for the name.
 */
import { Menu } from "@base-ui/react/menu";
import { EllipsisIcon, StarIcon } from "lucide-react";
import { useState } from "react";
import { EditBotDialog } from "@/components/bot-dialog";
import { Mark } from "@/components/state-mark";
import { BotAvatar } from "@/components/bot-avatar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { cn } from "@/lib/utils";
import type { ModelInfo, ProfileInfo } from "@spreissen/contracts";

const item =
  "data-highlighted:bg-muted flex cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-sm outline-none data-disabled:cursor-not-allowed data-disabled:opacity-60 pointer-coarse:min-h-11";

/** "Claude Sonnet 4.5" for a set model, the workspace default otherwise. */
const modelName = (bot: ProfileInfo, models: ModelInfo[]): string =>
  bot.model === null
    ? "Default model"
    : (models.find((model) => model.id === bot.model?.id)?.label ?? bot.model.id);

type Open = "memory" | "edit" | "remove" | null;

export interface BotRowProps {
  bot: ProfileInfo;
  /** The bot whose chat is on screen — highlighted. */
  active: boolean;
  mainId: string | null;
  deletable: boolean;
  needsYou: boolean;
  models: ModelInfo[];
  act: (run: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
  onOpenMain: (profileId: string) => void;
}

export function BotRow(props: BotRowProps) {
  const { bot, active, mainId, needsYou, models, onOpenMain } = props;
  const { busy } = useApp();
  const archived = bot.archivedAt !== null;
  const role = bot.description !== "" ? bot.description : "No role yet";
  const sub = `${needsYou ? "Needs your approval" : role} · ${modelName(bot, models)}`;
  return (
    <li className={cn("flex items-center gap-1 py-1 pr-1 pl-1", archived && "opacity-60")}>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => onOpenMain(bot.id)}
        className={cn(
          "hover:bg-muted/60 focus-visible:ring-ring/50 flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-3",
          active && "bg-muted",
        )}
      >
        <span className="relative">
          <BotAvatar
            id={bot.id}
            name={bot.name}
            mood={needsYou ? "alert" : busy.has(bot.id) ? "thinking" : "idle"}
          />
          {needsYou && (
            <Mark
              kind="attention"
              tone="signal"
              className="ring-background absolute -top-1 -right-1.5 size-3.5 rounded-full ring-2"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{bot.name}</span>
            {bot.id === mainId && (
              <StarIcon className="size-3.5 shrink-0 fill-live text-live" aria-label="Main bot" />
            )}
            {archived && <Badge variant="outline">Hidden</Badge>}
            {busy.has(bot.id) && (
              <Mark kind="working" tone="live" className="live-breathe size-3" />
            )}
          </span>
          <span
            className={cn(
              "truncate text-xs",
              needsYou ? "text-destructive" : "text-muted-foreground",
            )}
            title={sub}
          >
            {sub}
          </span>
        </span>
      </button>
      <BotMenu {...props} />
    </li>
  );
}

function BotMenu({ bot, mainId, deletable, models, act, refresh }: BotRowProps) {
  const [open, setOpen] = useState<Open>(null);
  const archived = bot.archivedAt !== null;
  const isMain = bot.id === mainId;
  // Mirrors the server's 409s, so the reason shows before the click.
  const deleteBlocked = !deletable
    ? "You need at least one bot."
    : isMain
      ? "Make another bot the main one first."
      : null;
  const show = (which: Open) => (next: boolean) => setOpen(next ? which : null);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={<Button variant="ghost" size="icon" aria-label={`Options for ${bot.name}`} />}
        >
          <EllipsisIcon />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
            <Menu.Popup className="bg-popover text-popover-foreground w-60 rounded-xl border p-1 shadow-lg outline-none">
              <Menu.Item className={item} onClick={() => setOpen("memory")}>
                What {bot.name} remembers
              </Menu.Item>
              <Menu.Item className={item} onClick={() => setOpen("edit")}>
                Edit role, personality and model
              </Menu.Item>
              {!isMain && (
                <Menu.Item className={item} onClick={() => void act(() => api.setMain(bot.id))}>
                  Make main bot
                  <span className="text-muted-foreground text-xs">Opens first when you start.</span>
                </Menu.Item>
              )}
              {!isMain && (
                <Menu.Item
                  className={item}
                  onClick={() =>
                    void act(() =>
                      archived ? api.unarchiveProfile(bot.id) : api.archiveProfile(bot.id),
                    )
                  }
                >
                  {archived ? "Unhide" : "Hide"}
                  {!archived && (
                    <span className="text-muted-foreground text-xs">
                      Moves it under Hidden. Nothing is deleted.
                    </span>
                  )}
                </Menu.Item>
              )}
              <Menu.Item
                className={cn(item, "text-destructive")}
                disabled={deleteBlocked !== null}
                onClick={() => setOpen("remove")}
              >
                Delete bot…
                {deleteBlocked !== null && (
                  <span className="text-muted-foreground text-xs">{deleteBlocked}</span>
                )}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <MemoryPanel
        profileId={bot.id}
        name={bot.name}
        open={open === "memory"}
        onOpenChange={show("memory")}
      />
      <EditBotDialog
        bot={bot}
        models={models}
        open={open === "edit"}
        onOpenChange={show("edit")}
        refresh={refresh}
      />
      <ConfirmDialog
        title={`Delete ${bot.name}?`}
        warning="This permanently removes the bot with all of their chats, memory and artifacts. It cannot be undone."
        typed={bot.name}
        confirmLabel="Delete bot"
        open={open === "remove"}
        onOpenChange={show("remove")}
        onConfirm={async () => {
          await api.deleteProfile(bot.id);
          await refresh();
        }}
      />
    </>
  );
}
