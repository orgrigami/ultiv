/** System, light or dark, remembered per device (Settings › Appearance). */
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";
import { setThemeChoice, themeChoice, type ThemeChoice } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CHOICES: readonly { value: ThemeChoice; label: string; icon: typeof SunIcon }[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

export function ThemeSwitch({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(themeChoice());
  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn("bg-muted/60 flex items-center gap-1 rounded-xl p-1", className)}
    >
      {CHOICES.map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          variant="segment"
          aria-pressed={choice === value}
          onClick={() => {
            setChoice(value);
            setThemeChoice(value);
          }}
          className="flex-1"
        >
          <Icon className="size-4" />
          {label}
        </Button>
      ))}
    </div>
  );
}
