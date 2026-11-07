/**
 * The bot pill's popover: the shared crew list (main bot first, role lines
 * and latest activity), then this bot's memory and profile, a new bot, and
 * the whole crew. The pill is the only bot switcher inside chat; the rail
 * and the Crew page render the same list.
 */
import { Popover } from "@base-ui/react/popover";
import { RowButton } from "@/components/ui/row-button";
import {
  PopoverSheetBackdrop,
  SheetHeading,
  SheetSeparator,
  sheetPopup,
  sheetPositioner,
  sheetRow,
} from "@/components/ui/menu-sheet";
import { useNavigate } from "@tanstack/react-router";
import { BrainIcon, PlusIcon, UserRoundCogIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { NewTeamDialog } from "@/components/team/new-team-dialog";
import { NewBotDialog } from "@/components/new-bot-dialog";
import { CrewList } from "@/components/crew-list";
import { useApp } from "@/lib/app-state";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const row = sheetRow;

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
  const [creatingTeam, setCreatingTeam] = useState(false);
  const now = useNow(30_000, true);
  const current = sessions.profiles.find((bot) => bot.id === currentId);
  // "New bot" from a team bot's pill starts in that team.
  const currentTeam = current?.teamId ?? null;

  const pick = (id: string): void => {
    onClose();
    void navigate({ to: "/", search: id === mainId ? {} : { bot: id } });
  };

  return (
    <>
      <Popover.Portal>
        <PopoverSheetBackdrop />
        <Popover.Positioner side="bottom" align="center" sideOffset={8} {...sheetPositioner}>
          <Popover.Popup
            className={cn(
              sheetPopup,
              "max-h-[min(32rem,var(--available-height))] w-80 overflow-y-auto p-1.5",
            )}
          >
            <Popover.Title render={<SheetHeading>Switch bot</SheetHeading>} />
            <CrewList
              variant="menu"
              activeId={currentId}
              onPick={pick}
              onOpenTeam={(id) => {
                onClose();
                void navigate({ to: "/crew/team/$teamId", params: { teamId: id } });
              }}
              onNewTeam={() => setCreatingTeam(true)}
              now={now}
            />
            <SheetSeparator />
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
            <RowButton className={row} onClick={() => setCreating(true)}>
              <span className="bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-full">
                <PlusIcon className="size-4" />
              </span>
              New bot
            </RowButton>
            <UtilityRow
              icon={UsersIcon}
              label="All of the crew"
              onClick={() => void navigate({ to: "/crew" })}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
      <NewTeamDialog
        open={creatingTeam}
        onOpenChange={setCreatingTeam}
        onCreated={(id) => {
          onClose();
          void navigate({ to: "/crew/team/$teamId", params: { teamId: id } });
        }}
      />
      <NewBotDialog
        teamId={currentTeam}
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
