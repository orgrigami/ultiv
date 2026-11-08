/**
 * Crew: every bot in one list (the same list the rail and the bot pill
 * show), grouped by team once there are teams. A row opens the
 * bot's profile; New bot, New team, cross-team activity, all
 * routines, bot talks and past chats live here instead of in the main nav.
 */
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, HistoryIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { NewTeamDialog } from "@/components/team/new-team-dialog";
import { ReachActivity } from "@/components/team/reach-activity";
import { NewBotDialog } from "@/components/new-bot-dialog";
import { CrewList } from "@/components/crew-list";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { useApp } from "@/lib/app-state";
import { useOrg } from "@/lib/use-org";

export const Route = createFileRoute("/crew/")({
  component: CrewPage,
});

const linkRow =
  "hover:bg-muted focus-visible:ring-ring/50 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm outline-none focus-visible:ring-3 [&_svg]:text-muted-foreground [&_svg]:size-4";

function CrewPage() {
  const { refreshAll } = useApp();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const { view } = useOrg();
  const hasTeams = (view?.teams.length ?? 0) > 0;
  return (
    <Page
      title="Crew"
      lead="Your bots, their memory, routines and access."
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => setCreatingTeam(true)}>
            <PlusIcon /> New team
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            New bot
          </Button>
        </>
      }
    >
      <SectionHeader title="Bots" />
      <CrewList
        variant="page"
        activeId={undefined}
        onPick={(id) => void navigate({ to: "/crew/$botId", params: { botId: id } })}
        onNewTeam={() => setCreatingTeam(true)}
      />
      <NewTeamDialog open={creatingTeam} onOpenChange={setCreatingTeam} />
      <NewBotDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (id) => {
          await refreshAll();
          void navigate({ to: "/crew/$botId", params: { botId: id } });
        }}
      />
      {hasTeams && (
        <>
          <SectionHeader title="Across teams" className="mt-2" />
          <ReachActivity />
        </>
      )}
      <SectionHeader title="Across the crew" className="mt-2" />
      <nav aria-label="Across the crew" className="bg-card flex flex-col rounded-xl border p-1">
        <Link to="/routines" className={linkRow}>
          <CalendarClockIcon /> All routines
        </Link>
        <Link to="/rooms" className={linkRow}>
          <MessagesSquareIcon /> Bot talks
        </Link>
        <Link to="/history" className={linkRow}>
          <HistoryIcon /> Past chats
        </Link>
      </nav>
    </Page>
  );
}
