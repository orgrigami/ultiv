/**
 * The phone tab bar's two sheet tabs: Tools (Connectors, Skills, Vault) and
 * More (History, Bot talks). Dialogs are already bottom sheets under sm:.
 * Rows are plain buttons + navigate (no DialogClose-rendered Links, so no
 * nativeButton dance), and each tab closes the sheet before navigating.
 */
import { useNavigate } from "@tanstack/react-router";
import {
  HistoryIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlugIcon,
  SparklesIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ListRow } from "@/components/ui/list-row";

/** The tab-slot look every fifth of the bar shares (matches TabLink). */
const slot =
  "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-lg pointer-coarse:min-h-11";

/** One row inside a sheet: icon, label, chevron; closes + navigates. */
function SheetRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <ListRow
      leading={<Icon className="size-4" />}
      title={label}
      trailing={<span className="text-muted-foreground text-xs">→</span>}
      onClick={onClick}
    />
  );
}

/**
 * One sheet tab: the trigger looks like any tab (and marks aria-current when
 * one of the sheet's targets is the current section); the sheet lists its
 * destinations. `open` lives here so the tab is self-contained.
 */
function SheetTab({
  icon: Icon,
  label,
  active,
  title,
  open,
  onOpenChange,
  children,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <button
            type="button"
            className={(active ? "text-foreground" : "text-muted-foreground") + " " + slot}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-current={active ? "true" : undefined}
          >
            <Icon className="size-5 shrink-0" />
            {label}
          </button>
        }
      />
      <DialogContent className="sm:w-[min(24rem,92vw)]">
        <DialogTitle>{title}</DialogTitle>
        <div className="mt-2 flex flex-col gap-0.5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function ToolsSheet({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const go = (to: "/connectors" | "/skills" | "/vault"): void => {
    setOpen(false);
    void navigate({ to });
  };
  return (
    <SheetTab
      icon={WrenchIcon}
      label="Tools"
      active={active}
      title="Tools"
      open={open}
      onOpenChange={setOpen}
    >
      <SheetRow icon={PlugIcon} label="Connectors" onClick={() => go("/connectors")} />
      <SheetRow icon={SparklesIcon} label="Skills" onClick={() => go("/skills")} />
      <SheetRow icon={KeyRoundIcon} label="Vault" onClick={() => go("/vault")} />
    </SheetTab>
  );
}

export function MoreSheet({ active, botId }: { active: boolean; botId: string | undefined }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const go = (to: "/history" | "/rooms"): void => {
    setOpen(false);
    void navigate({ to, search: {} });
  };
  const goRooms = (): void => {
    setOpen(false);
    void navigate({ to: "/rooms", search: botId !== undefined ? { bot: botId } : {} });
  };
  return (
    <SheetTab
      icon={MoreHorizontalIcon}
      label="More"
      active={active}
      title="More"
      open={open}
      onOpenChange={setOpen}
    >
      <SheetRow icon={HistoryIcon} label="History" onClick={() => go("/history")} />
      <SheetRow icon={UsersIcon} label="Bot talks" onClick={() => goRooms()} />
    </SheetTab>
  );
}
