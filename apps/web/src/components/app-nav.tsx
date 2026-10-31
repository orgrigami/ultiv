/**
 * The app nav: one model at every width, Chat · Past chats · Needs you ·
 * Crew · Settings. From sm: up it is a sidebar: the wordmark with its
 * connection state, New chat, the five destinations, the crew roster under
 * Crew (switching bots is one click) and Recents, the newest chats, so an old
 * chat is one click away. On phones it is a bottom tab bar with the same
 * five. Both mark the current section with aria-current and show the Needs
 * you count.
 */
import { BrandLockup } from "@/components/brand-mark";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BellDotIcon,
  HistoryIcon,
  MessageCircleIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { CrewList } from "@/components/crew-list";
import { Mark } from "@/components/state-mark";
import { useApp } from "@/lib/app-state";
import { pastChats, type ChatRow } from "@/lib/chats";
import { formatWhen } from "@/lib/format";
import { badgeText, SECTION_LABEL, SECTIONS, sectionOf, type Section } from "@/lib/nav";
import { useQuickSwitch } from "@/lib/quick-switch-context";
import { cn } from "@/lib/utils";

/** ⌘ on Apple keyboards, Ctrl elsewhere. */
const modKey = (): string =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";

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
  history: HistoryIcon,
  needs: BellDotIcon,
  crew: UsersIcon,
  settings: SettingsIcon,
};

/** Where each section's link goes; Chat returns to the bot last chatted with. */
function linkOf(
  section: Section,
  lastBot: string | undefined,
): {
  to: "/" | "/history" | "/needs" | "/crew" | "/settings";
  search: Record<string, string>;
} {
  if (section === "chat") return { to: "/", search: lastBot !== undefined ? { bot: lastBot } : {} };
  return { to: `/${section}`, search: {} };
}

/** Starts a chat with the bot on screen and opens it; the sidebar and N share it. */
export function useNewChat(): { ready: boolean; start: () => Promise<void> } {
  const { sessions } = useApp();
  const botId = useActiveBotId();
  const navigate = useNavigate();
  const ready = sessions.phase === "live" && sessions.profiles.length > 0;
  const start = async (): Promise<void> => {
    if (!ready) return;
    const created = await sessions.create(null, botId);
    if (created !== undefined) {
      void navigate({ to: "/c/$sessionId", params: { sessionId: created.id } });
    }
  };
  return { ready, start };
}

/** Where a chat row goes: a main chat is the bot's Chat tab, the rest live at /c/. */
export function useOpenChat(): (row: ChatRow) => void {
  const { mainId } = useApp();
  const navigate = useNavigate();
  return (row) => {
    if (row.main)
      void navigate({ to: "/", search: row.botId === mainId ? {} : { bot: row.botId } });
    else void navigate({ to: "/c/$sessionId", params: { sessionId: row.id } });
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
        "focus-visible:ring-ring/40 hover:bg-sidebar-accent/60 text-muted-foreground hover:text-sidebar-foreground press flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm outline-none focus-visible:ring-2",
        current && "bg-sidebar-accent text-sidebar-foreground font-medium",
      )}
    >
      <Icon className="size-5 shrink-0" />
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
      <BrandLockup />
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

/** The newest chats, one click each; "All past chats" for the rest. */
function Recents() {
  const { sessions } = useApp();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const open = useOpenChat();
  const rows = pastChats({ sessions: sessions.sessions, profiles: sessions.profiles, limit: 8 });
  if (rows.length === 0) return null;
  return (
    <section aria-label="Recent chats" className="mt-4 flex flex-col gap-0.5">
      <h2 className="section-label px-3 pb-1">Recent</h2>
      {rows.map((row) => {
        const current = !row.main && path === `/c/${row.id}`;
        return (
          <button
            key={row.id}
            type="button"
            onClick={() => open(row)}
            aria-current={current ? "page" : undefined}
            className={cn(
              "hover:bg-sidebar-accent/60 focus-visible:ring-ring/40 press flex min-h-11 w-full cursor-pointer flex-col justify-center rounded-xl px-3 py-1.5 text-left outline-none focus-visible:ring-2",
              current && "bg-sidebar-accent",
            )}
          >
            <span className="truncate text-sm">{row.title}</span>
            <span className="text-muted-foreground truncate text-xs">
              {row.main ? formatWhen(row.at) : `${row.botName} · ${formatWhen(row.at)}`}
            </span>
          </button>
        );
      })}
      <Link
        to="/history"
        className="text-muted-foreground hover:text-sidebar-foreground focus-visible:ring-ring/40 flex min-h-9 items-center rounded-xl px-3 text-xs outline-none focus-visible:ring-2"
      >
        All past chats
      </Link>
    </section>
  );
}

export function SideNav() {
  const botId = useActiveBotId();
  const { mainId } = useApp();
  const section = useSection();
  const navigate = useNavigate();
  const newChat = useNewChat();
  const quick = useQuickSwitch();
  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-64 shrink-0 flex-col border-r sm:flex"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        <Wordmark />
        <button
          type="button"
          disabled={!newChat.ready}
          onClick={() => void newChat.start()}
          className="bg-sidebar-accent hover:bg-sidebar-accent/80 focus-visible:ring-ring/40 press mb-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <SquarePenIcon className="size-5 shrink-0" />
          <span className="flex-1 text-left">New chat</span>
          <kbd className="text-muted-foreground readout">N</kbd>
        </button>
        {quick !== null && (
          <button
            type="button"
            onClick={quick.openSwitcher}
            className="hover:bg-sidebar-accent/60 focus-visible:ring-ring/40 press text-muted-foreground mb-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm outline-none focus-visible:ring-2"
          >
            <SearchIcon className="size-5 shrink-0" />
            <span className="flex-1 text-left">Find</span>
            <kbd className="readout">{modKey()}K</kbd>
          </button>
        )}
        <RailLink section="chat" current={section === "chat"} />
        <RailLink section="history" current={section === "history"} />
        <RailLink section="needs" current={section === "needs"} />
        <RailLink section="crew" current={section === "crew"} />
        <CrewList
          variant="rail"
          activeId={section === "chat" ? botId : undefined}
          className="mt-0.5 ml-3 border-l pl-2"
          onPick={(id) => void navigate({ to: "/", search: id === mainId ? {} : { bot: id } })}
        />
        <Recents />
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
        "focus-visible:ring-ring/50 press flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[0.6875rem] leading-none whitespace-nowrap outline-none focus-visible:ring-3",
        current ? "text-foreground font-medium" : "text-muted-foreground",
      )}
    >
      <span className="relative">
        <Icon className="size-6 shrink-0" />
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
      {SECTIONS.map((entry) => (
        <TabLink key={entry} section={entry} current={section === entry} />
      ))}
    </nav>
  );
}
