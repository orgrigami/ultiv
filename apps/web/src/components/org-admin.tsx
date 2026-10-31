/**
 * Org admin UI (phase 3): the organization section on Settings (org
 * host-access toggle, departments with theirs, new department) and the
 * per-bot host-access switch on a bot's Access tab, each showing the
 * effective value and, when blocked, which level blocks it (F4). Only the
 * org owner may change a switch; the server refuses everyone else (F3).
 */
import { useCallback, useEffect, useState } from "react";
import type { ProfileInfo } from "@spriessen/contracts";
import { api, type DepartmentInfo, type HostAccessMatrix, type OrgView } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
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
  const [view, setView] = useState<OrgView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await api.org());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error !== null) return <ErrorState message={error} onRetry={() => void load()} />;
  if (view === null) return <SkeletonRows label="Organization" rows={2} />;
  const org = view.org;
  if (org === null) return null;
  const setOrgFlag = async (hostAccess: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.patchOrg({ hostAccess });
      await load();
    } finally {
      setBusy(false);
    }
  };
  const setDeptFlag = async (id: string, hostAccess: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.patchDepartment(id, { hostAccess });
      await load();
    } finally {
      setBusy(false);
    }
  };
  const addDepartment = async (): Promise<void> => {
    if (name.trim() === "") return;
    setBusy(true);
    try {
      await api.createDepartment({ name: name.trim() });
      setName("");
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Organization">
      <SectionHeader title="Organization" />
      <div className="flex flex-col gap-3">
        <div className={card}>
          <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
            <Checkbox
              className="mt-0.5"
              checked={org.hostAccess}
              disabled={busy}
              onCheckedChange={(checked) => void setOrgFlag(checked === true)}
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
          {view.departments.map((department) => (
            <DepartmentRow
              key={department.id}
              department={department}
              busy={busy}
              onFlag={(checked) => void setDeptFlag(department.id, checked)}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={name}
            placeholder="New department"
            className="max-w-56"
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || name.trim() === ""}
            onClick={() => void addDepartment()}
          >
            Add
          </Button>
        </div>
      </div>
    </section>
  );
}

function DepartmentRow(props: {
  department: DepartmentInfo;
  busy: boolean;
  onFlag: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
      <Checkbox
        className="mt-0.5"
        checked={props.department.hostAccess}
        disabled={props.busy}
        onCheckedChange={(checked) => props.onFlag(checked === true)}
      />
      <span className="text-ui">
        {props.department.name}
        <span className="text-meta text-muted-foreground block">
          {props.department.hostAccess
            ? "On for this department."
            : "Off. This department's bots stay off this computer."}
        </span>
      </span>
    </label>
  );
}

/** The per-bot switch on the Access tab, with the effective verdict (F4). */
export function HostAccessSwitch({ bot }: { bot: ProfileInfo }) {
  const { refreshAll } = useApp();
  const [matrix, setMatrix] = useState<HostAccessMatrix | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      setMatrix(await api.hostAccess());
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
