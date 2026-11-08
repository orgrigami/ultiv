/**
 * One team on one screen: its bots, settings (name, Instructions, VM
 * size, host access), people, shared folder, shared memory, templates,
 * activity across homes, and removal. Reached from the crew groups in the
 * rail, the bot pill and the Crew page, from Settings → Organization, and
 * from the command palette.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_TEAM_SHARED_CAP_BYTES, type TeamSummary } from "@spriessen/contracts";
import { plural } from "@spriessen/present/plural";
import { TeamBots } from "@/components/team/team-bots";
import { TeamMemory } from "@/components/team/team-memory";
import { TeamRemove } from "@/components/team/team-remove";
import { TeamSettings } from "@/components/team/team-settings";
import { TeamTemplates } from "@/components/team/team-templates";
import { ReachActivity } from "@/components/team/reach-activity";
import { Page } from "@/components/page";
import { BackLink } from "@/components/back-link";
import { ListCard } from "@/components/ui/list-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { orgApi } from "@/lib/org-api";
import { vmLabel } from "@/lib/org-view";
import { useOrg } from "@/lib/use-org";

export const Route = createFileRoute("/crew/team/$teamId")({
  component: TeamPage,
});

function BackToCrew() {
  const navigate = useNavigate();
  return <BackLink label="Crew" onClick={() => void navigate({ to: "/crew" })} />;
}

/** Counts from the summary: tool calls this week, open approvals, the last call. */
function useSummary(id: string, epoch: unknown): TeamSummary | null {
  const [summary, setSummary] = useState<TeamSummary | null>(null);
  useEffect(() => {
    let live = true;
    orgApi
      .summary(id)
      .then((next) => live && setSummary(next))
      .catch(() => live && setSummary(null));
    return () => {
      live = false;
    };
  }, [id, epoch]);
  return summary;
}

/** A folder cap in the unit the owner set it in: "1 GiB", "512 MiB". */
const capText = (bytes: number): string => {
  const one = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
  const gib = bytes / 1_073_741_824;
  return gib >= 1 ? `${one.format(gib)} GiB` : `${Math.round(bytes / 1_048_576)} MiB`;
};

function People({ capBytes }: { capBytes: number }) {
  return (
    <ListCard>
      <div className="flex min-h-11 items-center gap-3 px-3 py-2.5">
        <UserRoundIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm flex-1">You</span>
        <span className="text-xs text-muted-foreground">Owner</span>
      </div>
      <div className="flex min-h-11 items-start gap-3 px-3 py-2.5">
        <FolderIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <span className="text-sm flex-1">
          Shared folder
          <span className="text-xs text-muted-foreground block">
            /home/shared in this team's VM: every bot here reads and writes it, up to{" "}
            {capText(capBytes)} (past that it turns read-only until files are removed). Org bots see
            it as /home/team-shared/&lt;team id&gt;.
          </span>
        </span>
      </div>
    </ListCard>
  );
}

function TeamPage() {
  const { teamId } = Route.useParams();
  const { sessions } = useApp();
  const { view } = useOrg(sessions.profiles.length);
  const team = view?.teams.find((row) => row.id === teamId);
  const summary = useSummary(teamId, sessions.profiles);
  if (view === null) {
    return (
      <Page title="Team" back={<BackToCrew />}>
        <SkeletonRows label="Team" rows={3} />
      </Page>
    );
  }
  if (team === undefined) {
    return (
      <Page title="Team not found" back={<BackToCrew />}>
        <EmptyState>This team was removed, or the link is from another workspace.</EmptyState>
      </Page>
    );
  }
  const count = sessions.profiles.filter((bot) => bot.teamId === team.id).length;
  const activity = summary?.activity;
  return (
    <Page
      back={<BackToCrew />}
      title={team.name}
      lead={`Team · ${count} ${plural(count, "bot", "bots")} · ${vmLabel(team.vm)} · host access ${team.hostAccess ? "on" : "off"}`}
    >
      <TeamBots teamId={team.id} />
      <SectionHeader title="Settings" className="mt-2" />
      <TeamSettings team={team} orgHostAccess={view.org?.hostAccess === true} />
      <SectionHeader title="People and files" className="mt-2" />
      <People capBytes={team.sharedCapBytes ?? DEFAULT_TEAM_SHARED_CAP_BYTES} />
      <SectionHeader title="Shared memory" className="mt-2" />
      <TeamMemory teamId={team.id} />
      <SectionHeader title="Templates" className="mt-2" />
      <TeamTemplates teamId={team.id} />
      <SectionHeader title="Activity" className="mt-2" />
      {activity !== undefined && (
        <p className="text-xs text-muted-foreground">
          {activity.toolCalls7d} tool calls this week · {activity.openApprovals} waiting for you
          {activity.lastToolCallAt !== null ? ` · last ${formatWhen(activity.lastToolCallAt)}` : ""}
        </p>
      )}
      <ReachActivity teamId={team.id} />
      <TeamRemove team={team} />
    </Page>
  );
}
