/**
 * The chat's browser chip, beside the tasks chip: it shows only while this
 * chat's bot has a browser session going, and turns to the signal colour
 * when the bot asked you to take the controls (its call is waiting). A tap
 * opens Browsers on the right (the work dock; Crew › bot › Browser where
 * there is no dock), where the ask is driven and the rest can be watched.
 */
import { useNavigate } from "@tanstack/react-router";
import { GlobeIcon } from "lucide-react";
import { useBrowsers } from "@/lib/use-browsers";
import { useOpenWork } from "@/lib/work-pane";
import { cn } from "@/lib/utils";

export function BrowserChip({ botId }: { botId: string | undefined }) {
  const { asks, watching } = useBrowsers(botId ?? "");
  const openWork = useOpenWork();
  const navigate = useNavigate();
  if (botId === undefined) return null;
  const asking = (asks?.length ?? 0) > 0;
  const open = (asks?.length ?? 0) + (watching?.length ?? 0);
  if (open === 0) return null;
  const label = asking ? "Take the controls" : "Browser";
  return (
    <button
      type="button"
      aria-label={asking ? "The bot asks you to take its browser's controls" : "Its browser"}
      onClick={() => {
        if (openWork !== null) openWork({ kind: "browsers" });
        else void navigate({ to: "/crew/$botId", params: { botId }, search: { tab: "browser" } });
      }}
      className={cn(
        "chrome-float focus-visible:ring-ring/50 inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none focus-visible:ring-3 pointer-coarse:h-11",
        asking ? "text-signal" : "text-muted-foreground",
      )}
    >
      <GlobeIcon className={cn("size-3.5", asking && "motion-safe:animate-pulse")} aria-hidden />
      <span className="max-sm:hidden">{label}</span>
    </button>
  );
}
