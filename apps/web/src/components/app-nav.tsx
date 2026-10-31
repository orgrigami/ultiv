/**
 * The app nav: one model at every width, Chat · Needs you · Crew · Settings.
 * From sm: up it is a fixed rail (the wordmark with its connection state,
 * the four destinations, and the crew roster under Crew so switching bots
 * is one click). On phones it is a bottom tab bar with the same four. Both
 * mark the current section with aria-current and show the Needs you count.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BellDotIcon,
  MessageCircleIcon,
  SettingsIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { CrewList } from "@/components/crew-list";
import { Mark } from "@/components/state-mark";
import { useApp } from "@/lib/app-state";
import { badgeText, SECTION_LABEL, sectionOf, type Section } from "@/lib/nav";
import { cn } from "@/lib/utils";

export type { Section } from "@/lib/nav";

function useSection(): Section | null {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return sectionOf(path);
}

/**
 * The bot the current view is about: the /c/ session's bot, the profile on
 * /crew/<id>, then ?bot=, then the last bot, then the main bot.
 */
export function useActiveBotId(): string | undefined {
  const { sessions, mainId, lastBot } = useApp();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.search });
  if (path.startsWith("/c/")) {
    const id = sessions.sessions.find(
      (session) => session.id === path.slice("/c/".length),
    )?.profile;
    return id ?? mainId ?? undefined;
  }
  if (path.startsWith("/crew/")) return decodeURIComponent(path.slice("/crew/".length));
  const bot = search.bot;
  if (typeof bot === "string" && bot !== "") return bot;
  return lastBot ?? mainId ?? undefined;
}

const ICONS: Record<Section, LucideIcon> = {
  chat: MessageCircleIcon,
  needs: BellDotIcon,
  crew: UsersIcon,
  settings: SettingsIcon,
};

/** Where each section's link goes; Chat returns to the bot last chatted with. */
function linkOf(
  section: Section,
  lastBot: string | undefined,
): { to: "/" | "/needs" | "/crew" | "/settings"; search: Record<string, string> } {
  if (section === "chat") return { to: "/", search: lastBot !== undefined ? { bot: lastBot } : {} };
  return {
    to: section === "needs" ? "/needs" : section === "crew" ? "/crew" : "/settings",
    search: {},
  };
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  const text = badgeText(count);
  if (text === null) return null;
  return (
    <span
      className={cn(
        "bg-signal text-signal-foreground tnum inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[0.6875rem] leading-none font-semibold",
        className,
      )}
    >
      {text}
    </span>
  );
}

/** One rail row: icon, label, optional count, aria-current. */
function RailLink({ section, current }: { section: Section; current: boolean }) {
  const { lastBot, needsCount } = useApp();
  const Icon = ICONS[section];
  const target = linkOf(section, lastBot);
  const count = section === "needs" ? needsCount : 0;
  return (
    <Link
      to={target.to}
      search={target.search as never}
      aria-current={current ? "page" : undefined}
      aria-label={count > 0 ? `${SECTION_LABEL[section]}, ${count} waiting` : undefined}
      className={cn(
        "focus-visible:ring-ring/40 hover:bg-sidebar-accent/60 text-muted-foreground hover:text-sidebar-foreground flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm outline-none focus-visible:ring-2",
        current && "bg-sidebar-accent text-sidebar-foreground font-medium",
      )}
    >
      <Icon className="size-[1.125rem] shrink-0" />
      <span className="flex-1">{SECTION_LABEL[section]}</span>
      <CountBadge count={count} />
    </Link>
  );
}

/** The wordmark row: the app name and its connection state. */
function Wordmark() {
  const { sessions } = useApp();
  const phase = sessions.phase;
  return (
    <div className="flex items-center gap-2 px-3 pt-1 pb-2">
      <span className="text-[0.9375rem] font-semibold tracking-tight">ultiv</span>
      <span
        className="readout text-muted-foreground flex items-center gap-1.5"
        title={phase === "live" ? "Connected" : "Reconnecting"}
      >
        <Mark
          kind={phase === "live" ? "done" : phase === "connecting" ? "pending" : "error"}
          tone={phase === "live" ? "ok" : phase === "connecting" ? "muted" : "signal"}
          className="size-3"
        />
        {phase === "live" ? "connected" : phase === "connecting" ? "connecting" : "disconnected"}
      </span>
    </div>
  );
}

export function SideNav() {
  const botId = useActiveBotId();
  const { mainId } = useApp();
  const section = useSection();
  const navigate = useNavigate();
  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-64 shrink-0 flex-col border-r sm:flex"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        <Wordmark />
        <RailLink section="chat" current={section === "chat"} />
        <RailLink section="needs" current={section === "needs"} />
        <RailLink section="crew" current={section === "crew"} />
        <CrewList
          variant="rail"
          activeId={section === "chat" ? botId : undefined}
          className="mt-0.5 ml-3 border-l pl-2"
          onPick={(id) => void navigate({ to: "/", search: id === mainId ? {} : { bot: id } })}
        />
      </div>
      <div className="border-sidebar-border border-t p-3">
        <RailLink section="settings" current={section === "settings"} />
      </div>
    </nav>
  );
}

/** One phone tab: icon over label, with the Needs you count on the icon. */
function TabLink({ section, current }: { section: Section; current: boolean }) {
  const { lastBot, needsCount } = useApp();
  const Icon = ICONS[section];
  const target = linkOf(section, lastBot);
  const count = section === "needs" ? needsCount : 0;
  return (
    <Link
      to={target.to}
      search={target.search as never}
      aria-current={current ? "page" : undefined}
      aria-label={
        count > 0 ? `${SECTION_LABEL[section]}, ${count} waiting` : SECTION_LABEL[section]
      }
      className={cn(
        "focus-visible:ring-ring/50 flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-xs outline-none focus-visible:ring-3",
        current ? "text-foreground font-medium" : "text-muted-foreground",
      )}
    >
      <span className="relative">
        <Icon className="size-[1.375rem] shrink-0" />
        <CountBadge count={count} className="ring-background absolute -top-1.5 -right-2.5 ring-2" />
      </span>
      {SECTION_LABEL[section]}
    </Link>
  );
}

export function TabBar() {
  const section = useSection();
  return (
    <nav
      aria-label="Sections"
      className="bg-background/65 border-border/60 fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl sm:hidden"
    >
      {(["chat", "needs", "crew", "settings"] as const).map((entry) => (
        <TabLink key={entry} section={entry} current={section === entry} />
      ))}
    </nav>
  );
}
