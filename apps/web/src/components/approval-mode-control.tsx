/**
 * The approval mode, in two shapes: the small chip beside the bot pill in
 * chat (a menu) and the choice list on a bot's Access tab. Both route every
 * switch through one place, so moving into YOLO always asks first and says
 * what still asks you.
 */
import { Menu } from "@base-ui/react/menu";
import { CheckIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";
import type { ProfileApprovalMode } from "@ultiv/contracts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { APPROVAL_MODES, MODE_CHIP, needsConfirm, YOLO_STILL_ASKS } from "@/lib/approval-mode";
import { cn } from "@/lib/utils";

const ICON = { manual: ShieldCheckIcon, jev: ShieldIcon, yolo: ShieldAlertIcon } as const;

/** Holds a pending YOLO switch until the owner confirms it. */
function useModeSwitch(
  mode: ProfileApprovalMode,
  onChange: (next: ProfileApprovalMode) => Promise<void>,
) {
  const [pending, setPending] = useState<ProfileApprovalMode | null>(null);
  const request = (next: ProfileApprovalMode): void => {
    if (next === mode) return;
    if (needsConfirm(mode, next)) setPending(next);
    else void onChange(next);
  };
  return { pending, setPending, request };
}

function YoloConfirm({
  botName,
  open,
  onOpenChange,
  onConfirm,
}: {
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <ConfirmDialog
      title={`Stop asking before ${botName} acts?`}
      warning="In YOLO mode steps run without your approval, including commands on this computer. You can switch back at any time."
      detail={
        <div className="flex flex-col gap-1.5 text-sm">
          <p className="font-medium">These still ask you:</p>
          <ul className="text-muted-foreground list-disc pl-5">
            {YOLO_STILL_ASKS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      }
      confirmLabel="Switch to YOLO"
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );
}

const itemClass =
  "data-highlighted:bg-muted flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 text-sm outline-none";

/** The chat chip: current mode in a word; opens a three-way menu. */
export function ApprovalModeChip({
  botName,
  mode,
  onChange,
}: {
  botName: string;
  mode: ProfileApprovalMode;
  onChange: (next: ProfileApprovalMode) => Promise<void>;
}) {
  const { pending, setPending, request } = useModeSwitch(mode, onChange);
  const chip = MODE_CHIP[mode];
  const Icon = ICON[mode];
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Approval mode: ${chip.label}. Change approval mode`}
          className={cn(
            "chrome-float focus-visible:ring-ring/50 inline-flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium outline-none focus-visible:ring-3 pointer-coarse:h-11",
            chip.tone === "warning" ? "text-warning" : "text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {chip.label}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="center" sideOffset={6} className="z-50">
            <Menu.Popup className="bg-popover text-popover-foreground w-72 rounded-xl border p-1 shadow-lg outline-none">
              <p className="text-muted-foreground px-3 pt-2 pb-1 text-xs">
                Who approves {botName}'s steps
              </p>
              <Menu.RadioGroup
                value={mode}
                onValueChange={(value: ProfileApprovalMode) => request(value)}
              >
                {APPROVAL_MODES.map((value) => (
                  <Menu.RadioItem key={value} value={value} className={itemClass}>
                    <span className="flex size-4 shrink-0 items-center pt-0.5">
                      <Menu.RadioItemIndicator>
                        <CheckIcon className="size-4" />
                      </Menu.RadioItemIndicator>
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{MODE_CHIP[value].label}</span>
                      <span className="text-muted-foreground text-xs">{MODE_CHIP[value].hint}</span>
                    </span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <YoloConfirm
        botName={botName}
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        onConfirm={async () => {
          if (pending !== null) await onChange(pending);
        }}
      />
    </>
  );
}

/** The Access tab's version: the three modes as a radio list. */
export function ApprovalModeChoice({
  botName,
  mode,
  help,
  onChange,
}: {
  botName: string;
  mode: ProfileApprovalMode;
  help: Record<ProfileApprovalMode, string>;
  onChange: (next: ProfileApprovalMode) => Promise<void>;
}) {
  const { pending, setPending, request } = useModeSwitch(mode, onChange);
  return (
    <>
      <div role="radiogroup" aria-label="Approval mode" className="flex flex-col gap-1">
        {APPROVAL_MODES.map((value) => {
          const Icon = ICON[value];
          const selected = value === mode;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => request(value)}
              className={cn(
                "focus-visible:ring-ring/50 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-3",
                selected ? "border-ring bg-muted" : "hover:bg-muted/60 border-transparent",
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  value === "yolo" ? "text-warning" : "text-muted-foreground",
                )}
                aria-hidden
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{MODE_CHIP[value].label}</span>
                <span className="text-muted-foreground text-xs">{help[value]}</span>
              </span>
            </button>
          );
        })}
      </div>
      <YoloConfirm
        botName={botName}
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        onConfirm={async () => {
          if (pending !== null) await onChange(pending);
        }}
      />
    </>
  );
}
