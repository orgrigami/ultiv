/**
 * The one bot list. The desktop rail, the bot-pill switcher and the Crew
 * page all render this, each in its own density (see crew-row.tsx). Order
 * is the same everywhere: the main bot first, hidden bots last and only on
 * the page. With teams, the list groups by home: the org and its own
 * bots on top, then each team, collapsible (crew-groups.tsx). With
 * none (personal mode) it is the flat list it always was.
 */
import type { ProfileInfo } from "@spriessen/contracts";
import { CrewGroups } from "@/components/crew-groups";
import { CrewRow, lastActiveOf, orderCrew, type CrewVariant } from "@/components/crew-row";
import { useApp } from "@/lib/app-state";
import { groupByHome } from "@/lib/org-view";
import { useOrg } from "@/lib/use-org";
import { cn } from "@/lib/utils";

export { lastActiveOf, orderCrew, type CrewVariant };

export function CrewList({
  variant,
  activeId,
  onPick,
  onOpenTeam,
  onNewTeam,
  now = Date.now(),
  className,
}: {
  variant: CrewVariant;
  /** The bot whose chat or profile is on screen. */
  activeId: string | undefined;
  onPick: (id: string) => void;
  /** Opens a team's page; the default navigates there. */
  onOpenTeam?: ((id: string) => void) | undefined;
  /** Starts a new team; the default opens the dialog in place. */
  onNewTeam?: (() => void) | undefined;
  now?: number;
  className?: string;
}) {
  const { sessions, mainId, attention, busy } = useApp();
  const { view } = useOrg(sessions.profiles.length);
  const bots = orderCrew(sessions.profiles, mainId, variant === "page");
  const latest = variant === "menu" ? lastActiveOf(sessions.sessions) : new Map<string, number>();
  const row = (bot: ProfileInfo) => (
    <CrewRow
      key={bot.id}
      bot={bot}
      variant={variant}
      active={bot.id === activeId}
      main={bot.id === mainId}
      needsYou={attention.has(bot.id)}
      working={busy.has(bot.id)}
      at={latest.get(bot.id)}
      now={now}
      models={sessions.models}
      onPick={onPick}
    />
  );
  const teams = view?.teams ?? [];
  if (teams.length > 0) {
    return (
      <CrewGroups
        variant={variant}
        groups={groupByHome(bots, teams, view?.org?.name ?? "Org")}
        row={row}
        activeId={activeId}
        onOpenTeam={onOpenTeam}
        onNewTeam={onNewTeam}
        className={className}
      />
    );
  }
  return (
    <ul
      aria-label="Crew"
      className={cn(
        "flex flex-col",
        variant === "page" && "divide-border bg-card divide-y rounded-xl border p-1",
        className,
      )}
    >
      {bots.map(row)}
    </ul>
  );
}
