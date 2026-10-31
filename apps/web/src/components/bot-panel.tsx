/**
 * The bot pill's popover: the shared crew list (main bot first, role lines
 * and latest activity), then this bot's memory and profile, a new bot, and
 * the whole crew. The pill is the only bot switcher inside chat; the rail
 * and the Crew page render the same list.
 */
import { Popover } from "@base-ui/react/popover";
import { useNavigate } from "@tanstack/react-router";
import { BrainIcon, PlusIcon, UserRoundCogIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { NewBotDialog } from "@/components/bot-dialog";
import { CrewList } from "@/components/crew-list";
import { useApp } from "@/lib/app-state";
import { useNow } from "@/lib/use-now";

const row =
  "hover:bg-muted focus-visible:bg-muted flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none";

function UtilityRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Popover.Close className={row} onClick={onClick}>
      <span className="bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-full">
        <Icon className="size-4" />
      </span>
      <span className="truncate">{label}</span>
    </Popover.Close>
  );
}

export function BotPanel({
  currentId,
  onMemory,
  onClose,
}: {
  /** The bot whose chat is on screen; undefined = none. */
  currentId: string | undefined;
  /** Opens the host's Memory panel; the panel instance lives in the host. */
  onMemory?: (() => void) | undefined;
  /** Closes the popover after a pick. */
  onClose: () => void;
}) {
  const { sessions, mainId, refreshAll } = useApp();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const now = useNow(30_000, true);
  const current = sessions.profiles.find((bot) => bot.id === currentId);

  const pick = (id: string): void => {
    onClose();
    void navigate({ to: "/", search: id === mainId ? {} : { bot: id } });
  };

  return (
    <>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="center" sideOffset={8} className="z-50">
          <Popover.Popup className="bg-popover/95 text-popover-foreground flex max-h-[min(28rem,70dvh)] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-y-auto rounded-xl border p-1.5 shadow-lg backdrop-blur-xl outline-none">
            <CrewList variant="menu" activeId={currentId} onPick={pick} now={now} />
            <div className="bg-border my-1 h-px" />
            {current !== undefined && onMemory !== undefined && (
              <UtilityRow
                icon={BrainIcon}
                label={`What ${current.name} remembers`}
                onClick={onMemory}
              />
            )}
            {current !== undefined && (
              <UtilityRow
                icon={UserRoundCogIcon}
                label={`${current.name}'s profile`}
                onClick={() => void navigate({ to: "/crew/$botId", params: { botId: current.id } })}
              />
            )}
            <button type="button" className={row} onClick={() => setCreating(true)}>
              <span className="bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-full">
                <PlusIcon className="size-4" />
              </span>
              New bot
            </button>
            <UtilityRow
              icon={UsersIcon}
              label="All of the crew"
              onClick={() => void navigate({ to: "/crew" })}
            />
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
