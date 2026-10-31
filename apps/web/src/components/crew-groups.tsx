/**
 * The crew grouped by home: the org on top with its own bots right under
 * it, then each department as a collapsible group (remembered per browser;
 * opening a bot in a collapsed group opens it), then "New department". A
 * department's name toggles the group; the gear beside it opens the
 * department's page.
 */
import { useNavigate } from "@tanstack/react-router";
import { Building2Icon, ChevronDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProfileInfo } from "@spriessen/contracts";
import { NewDepartmentDialog } from "@/components/department/new-department-dialog";
import type { CrewVariant } from "@/components/crew-row";
import type { CrewGroup } from "@/lib/org-view";
import { useCollapsed } from "@/lib/use-collapsed";
import { cn } from "@/lib/utils";

const headRow = (variant: CrewVariant): string =>
  cn(
    "focus-visible:ring-ring/50 flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left outline-none focus-visible:ring-2",
    variant === "rail"
      ? "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground text-xs font-medium"
      : "hover:bg-muted text-muted-foreground text-meta font-medium",
  );

const listClass = (variant: CrewVariant): string =>
  variant === "page" ? "divide-border bg-card divide-y rounded-xl border p-1" : "flex flex-col";

function GroupHead({
  group,
  variant,
  open,
  onToggle,
  onOpen,
}: {
  group: CrewGroup<ProfileInfo>;
  variant: CrewVariant;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" aria-expanded={open} onClick={onToggle} className={headRow(variant)}>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
        <span className="truncate">{group.name}</span>
        {!open && <span className="readout ml-auto shrink-0 opacity-70">{group.bots.length}</span>}
      </button>
      <button
        type="button"
        aria-label={`Open ${group.name}`}
        title={`Open ${group.name}`}
        onClick={onOpen}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none focus-visible:ring-2 sm:size-8"
      >
        <SettingsIcon className="size-3.5" />
      </button>
    </div>
  );
}

export function CrewGroups({
  variant,
  groups,
  row,
  activeId,
  onOpenDepartment,
  onNewDepartment,
  className,
}: {
  variant: CrewVariant;
  groups: CrewGroup<ProfileInfo>[];
  row: (bot: ProfileInfo) => React.ReactNode;
  activeId: string | undefined;
  onOpenDepartment?: ((id: string) => void) | undefined;
  onNewDepartment?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const navigate = useNavigate();
  const { collapsed, toggle, expand } = useCollapsed();
  const [creating, setCreating] = useState(false);
  const open = (id: string): void =>
    onOpenDepartment !== undefined
      ? onOpenDepartment(id)
      : void navigate({ to: "/crew/dept/$departmentId", params: { departmentId: id } });
  const [org, ...departments] = groups;
  // Opening a bot whose group is collapsed opens that group once; after
  // that the chevron is the user's again.
  const activeGroup = departments.find((group) => group.bots.some((bot) => bot.id === activeId));
  const activeGroupId = activeGroup?.id ?? null;
  useEffect(() => {
    if (activeGroupId !== null) expand(activeGroupId);
  }, [activeGroupId, expand]);
  return (
    <div className={cn("flex flex-col", variant === "page" ? "gap-3" : "gap-0.5", className)}>
      {org !== undefined && (
        <section aria-label={org.name} className="flex flex-col gap-0.5">
          <h3 className={cn(headRow(variant), "cursor-default hover:bg-transparent")}>
            <Building2Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{org.name}</span>
          </h3>
          {org.bots.length > 0 && (
            <ul aria-label={`Crew — ${org.name}`} className={listClass(variant)}>
              {org.bots.map(row)}
            </ul>
          )}
        </section>
      )}
      {departments.map((group) => {
        const id = group.id ?? "";
        const isOpen = !collapsed.has(id);
        return (
          <section key={id} aria-label={group.name} className="flex flex-col gap-0.5">
            <GroupHead
              group={group}
              variant={variant}
              open={isOpen}
              onToggle={() => toggle(id)}
              onOpen={() => open(id)}
            />
            {isOpen &&
              (group.bots.length > 0 ? (
                <ul
                  aria-label={`Crew — ${group.name}`}
                  className={cn(listClass(variant), variant === "rail" && "pl-3")}
                >
                  {group.bots.map(row)}
                </ul>
              ) : (
                <p className="text-muted-foreground px-2.5 pb-1 pl-8 text-xs">No bots yet</p>
              ))}
          </section>
        );
      })}
      <button
        type="button"
        onClick={() => (onNewDepartment !== undefined ? onNewDepartment() : setCreating(true))}
        className={cn(headRow(variant), "flex-none")}
      >
        <PlusIcon aria-hidden className="size-3.5 shrink-0" />
        New department
      </button>
      {onNewDepartment === undefined && (
        <NewDepartmentDialog open={creating} onOpenChange={setCreating} />
      )}
    </div>
  );
}
