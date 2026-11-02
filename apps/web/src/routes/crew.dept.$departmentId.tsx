/**
 * One department on one screen: its bots, settings (name, Instructions, VM
 * size, host access), people, shared folder, shared memory, templates,
 * activity across homes, and removal. Reached from the crew groups in the
 * rail, the bot pill and the Crew page, from Settings → Organization, and
 * from the command palette.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronLeftIcon, FolderIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { DepartmentSummary } from "@spriessen/contracts";
import { DeptBots } from "@/components/department/dept-bots";
import { DeptMemory } from "@/components/department/dept-memory";
import { DeptRemove } from "@/components/department/dept-remove";
import { DeptSettings } from "@/components/department/dept-settings";
import { DeptTemplates } from "@/components/department/dept-templates";
import { ReachActivity } from "@/components/department/reach-activity";
import { Page } from "@/components/page";
import { ListCard } from "@/components/ui/list-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { orgApi } from "@/lib/org-api";
import { vmLabel } from "@/lib/org-view";
import { useOrg } from "@/lib/use-org";

export const Route = createFileRoute("/crew/dept/$departmentId")({
  component: DepartmentPage,
});

function BackToCrew() {
  return (
    <Link
      to="/crew"
      className="text-muted-foreground hover:text-foreground -ml-1 inline-flex min-h-11 items-center gap-1 self-start rounded-lg pr-2 text-sm sm:min-h-8"
    >
      <ChevronLeftIcon className="size-4" /> Crew
    </Link>
  );
}

/** Counts from the summary: tool calls this week, open approvals, the last call. */
function useSummary(id: string, epoch: unknown): DepartmentSummary | null {
  const [summary, setSummary] = useState<DepartmentSummary | null>(null);
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

function People() {
  return (
    <ListCard>
      <div className="flex min-h-11 items-center gap-3 px-3 py-2.5">
        <UserRoundIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="text-ui flex-1">You</span>
        <span className="text-meta text-muted-foreground">Owner</span>
      </div>
      <div className="flex min-h-11 items-start gap-3 px-3 py-2.5">
        <FolderIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <span className="text-ui flex-1">
          Shared folder
          <span className="text-meta text-muted-foreground block">
            Comes with department VMs (Phase 4). Until then each bot keeps its own files.
          </span>
        </span>
      </div>
    </ListCard>
  );
}

function DepartmentPage() {
  const { departmentId } = Route.useParams();
  const { sessions } = useApp();
  const { view } = useOrg(sessions.profiles.length);
  const department = view?.departments.find((row) => row.id === departmentId);
  const summary = useSummary(departmentId, sessions.profiles);
  if (view === null) {
    return (
      <Page title="Department" back={<BackToCrew />}>
        <SkeletonRows label="Department" rows={3} />
      </Page>
    );
  }
  if (department === undefined) {
    return (
      <Page title="Department not found" back={<BackToCrew />}>
        <EmptyState>This department was removed, or the link is from another workspace.</EmptyState>
      </Page>
    );
  }
  const count = sessions.profiles.filter((bot) => bot.departmentId === department.id).length;
  const activity = summary?.activity;
  return (
    <Page
      back={<BackToCrew />}
      title={department.name}
      lead={`Department · ${count === 1 ? "1 bot" : `${count} bots`} · ${vmLabel(department.vm)} · host access ${department.hostAccess ? "on" : "off"}`}
    >
      <DeptBots departmentId={department.id} />
      <SectionHeader title="Settings" className="mt-2" />
      <DeptSettings department={department} orgHostAccess={view.org?.hostAccess === true} />
      <SectionHeader title="People and files" className="mt-2" />
      <People />
      <SectionHeader title="Shared memory" className="mt-2" />
      <DeptMemory departmentId={department.id} />
      <SectionHeader title="Templates" className="mt-2" />
      <DeptTemplates departmentId={department.id} />
      <SectionHeader title="Activity" className="mt-2" />
      {activity !== undefined && (
        <p className="text-meta text-muted-foreground">
          {activity.toolCalls7d} tool calls this week · {activity.openApprovals} waiting for you
          {activity.lastToolCallAt !== null ? ` · last ${formatWhen(activity.lastToolCallAt)}` : ""}
        </p>
      )}
      <ReachActivity departmentId={department.id} />
      <DeptRemove department={department} />
    </Page>
  );
}
