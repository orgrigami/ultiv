/**
 * A bot's home, as a label and as "Move to…". The label (a small link to
 * the team page) sits in the chat header and the bot's profile; the
 * move field sits in the profile's Manage card. Both stay out of sight in
 * personal mode (no teams).
 */
import { Link } from "@tanstack/react-router";
import { Building2Icon } from "lucide-react";
import { useState } from "react";
import type { ProfileInfo } from "@spriessen/contracts";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { loadOrg, useOrg } from "@/lib/use-org";
import { cn } from "@/lib/utils";
import { HomeSelect } from "./home-select";

/** The home in words for a header line; null in personal mode or with no bot. */
export function useHomeWord(teamId: string | null | undefined, known: boolean): string | null {
  const { view } = useOrg();
  if (!known || view === null || view.teams.length === 0) return null;
  return view.teams.find((row) => row.id === teamId)?.name ?? view.org?.name ?? "Org";
}

export function HomeLabel({ bot, className }: { bot: ProfileInfo; className?: string }) {
  const { view } = useOrg();
  if (view === null || view.teams.length === 0) return null;
  const team = view.teams.find((row) => row.id === bot.teamId);
  const label = team?.name ?? view.org?.name ?? "Org";
  const classes = cn(
    "text-muted-foreground text-meta inline-flex max-w-40 items-center gap-1 truncate rounded-full",
    className,
  );
  if (team === undefined)
    return (
      <span className={classes} title="An org bot">
        <Building2Icon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  return (
    <Link
      to="/crew/team/$teamId"
      params={{ teamId: team.id }}
      className={cn(classes, "hover:text-foreground")}
      title={`In ${label}`}
    >
      <Building2Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

export function BotHomeField({ bot, isMain }: { bot: ProfileInfo; isMain: boolean }) {
  const { refreshAll } = useApp();
  const [error, setError] = useState<string | null>(null);
  const move = async (teamId: string): Promise<void> => {
    setError(null);
    try {
      await api.updateProfile(bot.id, { teamId: teamId === "" ? null : teamId });
      await refreshAll();
      void loadOrg();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <HomeSelectRow>
      <HomeSelect
        label="Move to…"
        value={bot.teamId ?? ""}
        onChange={(id) => void move(id)}
        lockedReason={isMain ? "The main bot lives in the org." : undefined}
        hint="It follows its new team's Instructions from its next turn."
      />
      {error !== null && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </HomeSelectRow>
  );
}

/** The padding of a Manage row, collapsing to nothing when the field hides. */
function HomeSelectRow({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2.5 empty:hidden">{children}</div>;
}
