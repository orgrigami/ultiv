/**
 * The rail's foundation: the owner's block at the bottom of the nav.
 * The owner's name, the theme control (system, light, dark), and the
 * way into full crew management. The theme choice persists per device.
 */
import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { MonitorIcon, MoonIcon, SunIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { setThemeChoice, themeChoice, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

const CHOICES: readonly { value: ThemeChoice; label: string; icon: typeof SunIcon }[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** The owner's block: identity, theme, and crew management, one quiet block. */
export function OwnerBlock({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [choice, setChoice] = useState<ThemeChoice>(themeChoice());
  return (
    <div className={cn("border-sidebar-border border-t p-3", className)}>
      <div className="flex items-center gap-2.5">
        <span className="bg-secondary text-secondary-foreground ring-sidebar-border inline-flex size-8 shrink-0 items-center justify-center rounded-full ring-1">
          <UserIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">Owner</span>
        <OwnerMenu onCrew={() => void navigate({ to: "/bots" })} />
      </div>
      <div className="border-sidebar-border/70 mt-2.5 flex items-center gap-0.5 rounded-lg border p-0.5">
        {CHOICES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={choice === value}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => {
              setChoice(value);
              setThemeChoice(value);
            }}
            className={cn(
              "text-muted-foreground hover:text-foreground flex h-7 flex-1 items-center justify-center rounded-md outline-none",
              choice === value && "bg-background text-foreground shadow-xs",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}

function OwnerMenu({ onCrew }: { onCrew: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="Account menu" />}>
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
          <circle cx="8" cy="3" r="1.25" fill="currentColor" />
          <circle cx="8" cy="8" r="1.25" fill="currentColor" />
          <circle cx="8" cy="13" r="1.25" fill="currentColor" />
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="bg-popover text-popover-foreground w-56 rounded-xl border p-1 shadow-lg outline-none">
            <Menu.Item
              className="data-highlighted:bg-muted pointer-coarse:min-h-10 flex cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-sm outline-none"
              onClick={onCrew}
            >
              Crew settings
              <span className="text-muted-foreground text-xs">
                Roles, models, hidden bots, notifications
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
