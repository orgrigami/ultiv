/**
 * Org admin UI (phase 3): the organization section on Settings (org
 * host-access toggle, each department linking to its page, new department) and the
 * per-bot host-access switch on a bot's Access tab, each showing the
 * effective value and, when blocked, which level blocks it (F4). Only the
 * org owner may change a switch; the server refuses everyone else (F3).
 */
import { Link } from "@tanstack/react-router";
import { Building2Icon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProfileInfo } from "@spriessen/contracts";
import { NewDepartmentDialog } from "@/components/department/new-department-dialog";
import { NetAllowlistEditor } from "@/components/net-allowlist";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { orgApi, type DepartmentInfo, type HostAccessMatrix } from "@/lib/org-api";
import { vmLabel } from "@/lib/org-view";
import { useOrg } from "@/lib/use-org";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { SectionHeader } from "@/components/ui/section-header";

const card = "bg-card divide-border flex flex-col divide-y rounded-xl border";

/** The level that blocks, in plain words. */
export const blockedLine = (blockedBy: HostAccessMatrix["bots"][number]["blockedBy"]): string =>
  blockedBy === "org"
    ? "Blocked: the org switch is off."
    : blockedBy === "department"
      ? "Blocked: the department switch is off."
      : blockedBy === "bot"
        ? "Blocked: this bot's own switch is off."
        : "";

export function OrgSection() {
  const { view, error, reload } = useOrg();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (error !== null && view === null)
    return <ErrorState message={error} onRetry={() => void reload()} />;
  if (view === null) return <SkeletonRows label="Organization" rows={2} />;
  const org = view.org;
  if (org === null) return null;
  const change = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await run();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Organization">
      <SectionHeader
        title="Organization"
        action={
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <PlusIcon /> New department
          </Button>
        }
      />
      <div className={card}>
        <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
          <Checkbox
            className="mt-0.5"
            checked={org.hostAccess}
            disabled={busy}
            onCheckedChange={(checked) =>
              void change(() => orgApi.patchOrg({ hostAccess: checked === true }))
            }
          />
          <span className="text-ui">
            Host access for the org
            <span className="text-meta text-muted-foreground block">
              {org.hostAccess
                ? "On. Bots can run things on this computer when every level below is on too."
                : "Off. No bot can run things on this computer."}
            </span>
          </span>
        </label>
        <NetAllowlistEditor
          title="Org VM network"
          entries={org.netAllowlist ?? []}
          open={org.netOpen === true}
          meta={
            org.netOpen === true
              ? "Open: the org VM reaches everything. The allowlist below is ignored until you close it again."
              : org.netAllowlist === undefined || org.netAllowlist.length === 0
                ? "Offline: the org VM reaches no hosts. Add the ones its bots need."
                : `The org VM reaches exactly these hosts (${org.netAllowlist.length} of at most 64).`
          }
          onSave={async (draft, open) => {
            await orgApi.patchOrg({ netAllowlist: draft, netOpen: open });
          }}
        />
        {view.departments.map((department) => (
          <DepartmentRow key={department.id} department={department} />
        ))}
      </div>
      {problem !== null && (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {problem}
        </p>
      )}
      <p className="text-meta text-muted-foreground mt-2">
        A department groups bots under shared Instructions, a VM size and its own host-access
        switch. Open one to change it.
      </p>
      <NewDepartmentDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}

function DepartmentRow({ department }: { department: DepartmentInfo }) {
  return (
    <Link
      to="/crew/dept/$departmentId"
      params={{ departmentId: department.id }}
      className="hover:bg-muted focus-visible:ring-ring/50 flex min-h-11 items-center gap-3 px-3 py-2.5 outline-none focus-visible:ring-2"
    >
      <Building2Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="text-ui min-w-0 flex-1">
        <span className="block truncate">{department.name}</span>
        <span className="text-meta text-muted-foreground block">
          {vmLabel(department.vm)} · host access {department.hostAccess ? "on" : "off"} ·{" "}
          {department.netOpen === true
            ? "network open"
            : department.netAllowlist === undefined || department.netAllowlist.length === 0
              ? "network off"
              : `network: ${department.netAllowlist.length} host${department.netAllowlist.length === 1 ? "" : "s"}`}
        </span>
      </span>
      <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
    </Link>
  );
}

/** The per-bot switch on the Access tab, with the effective verdict (F4). */
export function HostAccessSwitch({ bot }: { bot: ProfileInfo }) {
  const { refreshAll } = useApp();
  const [matrix, setMatrix] = useState<HostAccessMatrix | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      setMatrix(await orgApi.hostAccess());
    } catch {
      setMatrix(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, bot.id]);
  const mine = matrix?.bots.find((row) => row.profileId === bot.id) ?? null;
  const setOwn = async (checked: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.updateProfile(bot.id, { hostAccess: checked });
      await load();
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={card}>
      <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
        <Checkbox
          className="mt-0.5"
          checked={bot.hostAccess === true}
          disabled={busy}
          onCheckedChange={(checked) => void setOwn(checked === true)}
        />
        <span className="text-ui">
          This bot may run things on this computer
          <span className="text-meta text-muted-foreground block">
            Effective:{" "}
            {mine?.allowed === true ? (
              <Badge variant="secondary">allowed</Badge>
            ) : (
              <Badge variant="secondary">off</Badge>
            )}{" "}
            {mine !== null ? blockedLine(mine.blockedBy) : ""}
          </span>
        </span>
      </label>
    </div>
  );
}
