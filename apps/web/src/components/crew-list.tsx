/**
 * The one bot list. The desktop rail, the bot-pill switcher and the Crew
 * page all render this, each in its own density: "rail" (one line), "menu"
 * (role line and last activity) and "page" (role and model, opens the
 * profile). Order is the same everywhere: the main bot first, hidden bots
 * last and only on the page.
 */
import { ChevronRightIcon, StarIcon } from "lucide-react";
import type { ModelInfo, ProfileInfo } from "@ultiv/contracts";
import { BotAvatar } from "@/components/bot-avatar";
import { Mark } from "@/components/state-mark";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";

export type CrewVariant = "rail" | "menu" | "page";

/** Main bot first, then the rest in list order; hidden bots after them. */
export function orderCrew(
  profiles: readonly ProfileInfo[],
  mainId: string | null,
  includeHidden: boolean,
): ProfileInfo[] {
  const visible = profiles.filter((bot) => bot.archivedAt === null);
  const sorted = [...visible].sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  return includeHidden ? [...sorted, ...profiles.filter((bot) => bot.archivedAt !== null)] : sorted;
}

/** The latest message time per bot, folded from the app-wide session list. */
export function lastActiveOf(
  rows: readonly { profile: string; lastMessageAt: number }[],
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const session of rows) {
    const at = latest.get(session.profile);
    if (at === undefined || session.lastMessageAt > at)
      latest.set(session.profile, session.lastMessageAt);
  }
  return latest;
}

const modelName = (bot: ProfileInfo, models: readonly ModelInfo[]): string =>
  bot.model === null
    ? "Default model"
    : (models.find((model) => model.id === bot.model?.id)?.label ?? bot.model.id);

function CrewRow({
  bot,
  variant,
  active,
  main,
  needsYou,
  working,
  at,
  now,
  models,
  onPick,
}: {
  bot: ProfileInfo;
  variant: CrewVariant;
  active: boolean;
  main: boolean;
  needsYou: boolean;
  working: boolean;
  at: number | undefined;
  now: number;
  models: readonly ModelInfo[];
  onPick: (id: string) => void;
}) {
  const hidden = bot.archivedAt !== null;
  const role = bot.description !== "" ? bot.description : "No role yet";
  const sub = needsYou
    ? "Needs your approval"
    : variant === "page"
      ? `${role} · ${modelName(bot, models)}`
      : role;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(bot.id)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "focus-visible:ring-ring/50 flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left outline-none focus-visible:ring-2",
          variant === "rail" ? "hover:bg-sidebar-accent/60 py-1" : "hover:bg-muted py-1.5",
          active && (variant === "rail" ? "bg-sidebar-accent text-sidebar-foreground" : "bg-muted"),
          variant === "rail" && !active && "text-muted-foreground hover:text-sidebar-foreground",
          hidden && "opacity-60",
        )}
      >
        <span className="relative">
          <BotAvatar name={bot.name} size={variant === "rail" ? "sm" : "md"} />
          {needsYou && (
            <Mark
              kind="attention"
              tone="signal"
              label="Needs your approval"
              className="ring-background absolute -top-1 -right-1.5 size-3.5 rounded-full ring-2"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn("truncate text-sm", (active || variant !== "rail") && "font-medium")}
            >
              {bot.name}
            </span>
            {main && (
              <StarIcon className="fill-live text-live size-3.5 shrink-0" aria-label="Main bot" />
            )}
            {hidden && <Badge variant="outline">Hidden</Badge>}
          </span>
          {variant !== "rail" && (
            <span
              className={cn("truncate text-xs", needsYou ? "text-signal" : "text-muted-foreground")}
              title={sub}
            >
              {sub}
            </span>
          )}
        </span>
        {working && (
          <Mark kind="working" tone="live" label="Running a task" className="live-breathe size-3" />
        )}
        {variant === "menu" && at !== undefined && (
          <time className="text-muted-foreground shrink-0 text-xs">
            {formatWhen(at, new Date(now))}
          </time>
        )}
        {variant === "page" && (
          <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
        )}
      </button>
    </li>
  );
}

export function CrewList({
  variant,
  activeId,
  onPick,
  now = Date.now(),
  className,
}: {
  variant: CrewVariant;
  /** The bot whose chat or profile is on screen. */
  activeId: string | undefined;
  onPick: (id: string) => void;
  now?: number;
  className?: string;
}) {
  const { sessions, mainId, attention, busy } = useApp();
  const bots = orderCrew(sessions.profiles, mainId, variant === "page");
  const latest = variant === "menu" ? lastActiveOf(sessions.sessions) : new Map<string, number>();
  return (
    <ul
      aria-label="Crew"
      className={cn(
        "flex flex-col",
        variant === "page" && "divide-border bg-card divide-y rounded-xl border p-1",
        className,
      )}
    >
      {bots.map((bot) => (
        <CrewRow
          key={bot.id}
          bot={bot}
          variant={variant}
          active={bot.id === activeId}
          main={bot.id === mainId}
          needsYou={attention.has(bot.id)}
          working={busy.has(bot.id)}
          at={latest.get(bot.id)}
          now={now}
          models={sessions.models}
          onPick={onPick}
        />
      ))}
    </ul>
  );
}
