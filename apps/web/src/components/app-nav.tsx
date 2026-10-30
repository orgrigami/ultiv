/**
 * The station console. From sm: up, a fixed rail: the wordmark with the
 * station link state, the crew roster under its plate (the bots ARE the
 * navigation; switching = clicking a crew member), labeled system links,
 * the current bot's recents, and the owner's plate at the foundation.
 * On phones, a bottom tab bar (Crew, Routines, raised Chat, Tools, More).
 * Both mark the current section with aria-current.
 */
import { Popover } from "@base-ui/react/popover";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  HistoryIcon,
  MessagesSquareIcon,
  MessageCircleIcon,
  PlusIcon,
  WrenchIcon,
  ChevronsUpDownIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { BotPanel } from "@/components/bot-panel";
import { Mark } from "@/components/state-mark";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { MoreSheet } from "@/components/nav-sheets";
import { NavRecents } from "@/components/nav-recents";
import { OwnerBlock } from "@/components/owner-block";
import { useApp } from "@/lib/app-state";
import { cn } from "@/lib/utils";

export type Section = "chat" | "bots" | "routines" | "tools" | "history" | "rooms";

/** Path prefixes per section; no prefix is a prefix of another. */
const MATCHES: readonly (readonly [string, Section])[] = [
  ["/c/", "chat"],
  ["/bots", "bots"],
  ["/routines", "routines"],
  ["/tools", "tools"],
  ["/connectors", "tools"],
  ["/skills", "tools"],
  ["/vault", "tools"],
  ["/history", "history"],
  ["/rooms", "rooms"],
];

function useSection(): Section | null {
  const path = useRouterState({ select: (state) => state.location.pathname });
  if (path === "/") return "chat";
  return MATCHES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
}

/**
 * The bot the console is "about": the /c/ session's bot when one is open,
 * then ?bot=, then the last bot, then the main bot.
 */
function useActiveBotId(): string | undefined {
  const { sessions, mainId, lastBot } = useApp();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.search });
  if (path.startsWith("/c/")) {
    const id = sessions.sessions.find(
      (session) => session.id === path.slice("/c/".length),
    )?.profile;
    return id ?? mainId ?? undefined;
  }
  const bot = search.bot;
  if (typeof bot === "string" && bot !== "") return bot;
  return lastBot ?? mainId ?? undefined;
}

/** The rail's section row: icon, label, one height, aria-current. */
function SystemLink({
  to,
  search,
  icon: Icon,
  label,
  current,
}: {
  to: "/" | "/routines" | "/tools" | "/history" | "/rooms";
  search?: Record<string, string>;
  icon: LucideIcon;
  label: string;
  current: boolean;
}) {
  return (
    <Link
      to={to}
      search={search as never}
      aria-current={current ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring/40 aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-foreground hover:bg-sidebar-accent/60 text-muted-foreground hover:text-sidebar-foreground pointer-coarse:min-h-11 flex min-h-9 items-center gap-3 rounded-lg px-3 text-sm outline-none focus-visible:ring-2",
        current && "bg-sidebar-accent/70 text-sidebar-foreground font-medium",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </Link>
  );
}

/** New chat: creates a session for the bot the console is about. */
function NewChatRow({ botId, current }: { botId: string | undefined; current: boolean }) {
  const { sessions } = useApp();
  const navigate = useNavigate();
  const disabled = sessions.phase !== "live" || sessions.profiles.length === 0;
  const create = async (): Promise<void> => {
    const created = await sessions.create(null, botId);
    if (created !== undefined) {
      void navigate({ to: "/c/$sessionId", params: { sessionId: created.id } });
    }
  };
  return (
    // Disabled buttons swallow hover, so the reason sits on a wrapper.
    <span
      title={
        sessions.profiles.length === 0
          ? "Create a bot first"
          : sessions.phase !== "live"
            ? "Waiting for the server"
            : undefined
      }
      className="flex"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => void create()}
        aria-current={current ? "page" : undefined}
        className={cn(
          "focus-visible:ring-ring/40 hover:bg-sidebar-accent/60 text-muted-foreground hover:text-sidebar-foreground pointer-coarse:min-h-11 flex min-h-9 w-full items-center gap-3 rounded-lg px-3 text-sm outline-none focus-visible:ring-2",
          current && "bg-sidebar-accent/70 text-sidebar-foreground font-medium",
        )}
      >
        <PlusIcon className="size-4 shrink-0" />
        New chat
      </button>
    </span>
  );
}

/** One crew member on the rail: avatar, name, and their live state. */
function CrewRow({
  id,
  name,
  active,
  needsYou,
  working,
  onPick,
}: {
  id: string;
  name: string;
  active: boolean;
  needsYou: boolean;
  working: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "focus-visible:ring-ring/40 hover:bg-sidebar-accent/60 pointer-coarse:min-h-11 group flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left outline-none focus-visible:ring-2",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-muted-foreground hover:text-sidebar-foreground",
      )}
    >
      <BotAvatar id={id} name={name} size="sm" />
      <span
        className={cn("min-w-0 flex-1 truncate text-sm", active ? "font-medium" : "font-normal")}
      >
        {name}
      </span>
      {needsYou ? (
        <Mark kind="attention" tone="signal" />
      ) : working ? (
        <Mark kind="working" tone="live" className="live-breathe" />
      ) : null}
    </button>
  );
}

/** The wordmark plate: the station's name and its link state. */
function Wordmark() {
  const { sessions } = useApp();
  const phase = sessions.phase;
  return (
    <div className="flex items-center gap-2 px-3 pt-1 pb-2">
      <span className="text-[0.9375rem] font-semibold tracking-tight">ultiv</span>
      <span
        className="readout text-muted-foreground flex items-center gap-1.5"
        title={phase === "live" ? "Connected to the station" : "Reconnecting to the station"}
      >
        <Mark
          kind={phase === "live" ? "done" : phase === "connecting" ? "pending" : "error"}
          tone={phase === "live" ? "ok" : phase === "connecting" ? "muted" : "signal"}
          className="size-3"
        />
        {phase === "live" ? "live" : phase === "connecting" ? "linking" : "lost"}
      </span>
    </div>
  );
}

/** The crew plate header: the overline plus the shared bot-panel trigger. */
function CrewPlate({ botId, onMemory }: { botId: string | undefined; onMemory: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-1 pr-1 pl-3">
        <span className="overline-plate">Crew</span>
        <Popover.Trigger
          aria-label="Crew overview"
          className="text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/60 flex size-7 items-center justify-center rounded-md outline-none"
        >
          <ChevronsUpDownIcon className="size-3.5" />
        </Popover.Trigger>
      </div>
      <BotPanel currentId={botId} onMemory={onMemory} />
    </Popover.Root>
  );
}

export function SideNav() {
  const botId = useActiveBotId();
  const { sessions, mainId, attention, busy } = useApp();
  const section = useSection();
  const navigate = useNavigate();
  const [memory, setMemory] = useState<{ id: string; name: string } | null>(null);
  const roster = sessions.profiles
    .filter((bot) => bot.archivedAt === null)
    .sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));

  return (
    <nav
      aria-label="Station"
      className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-64 shrink-0 flex-col overflow-y-auto border-r sm:flex"
    >
      <div className="flex flex-col gap-0.5 p-3 pb-0">
        <Wordmark />
        <div className="mt-2">
          <CrewPlate
            botId={botId}
            onMemory={() => {
              const bot = roster.find((candidate) => candidate.id === botId);
              if (bot !== undefined) setMemory({ id: bot.id, name: bot.name });
            }}
          />
        </div>
        <div className="mt-1 flex flex-col">
          {roster.map((bot) => (
            <CrewRow
              key={bot.id}
              id={bot.id}
              name={bot.name}
              active={bot.id === botId}
              needsYou={attention.has(bot.id)}
              working={busy.has(bot.id)}
              onPick={() =>
                void navigate({ to: "/", search: bot.id === mainId ? {} : { bot: bot.id } })
              }
            />
          ))}
        </div>
        <div className="plate-rule mt-3" />
        <div className="mt-2 flex flex-col">
          <NewChatRow botId={botId} current={section === "chat"} />
          <SystemLink
            to="/routines"
            icon={CalendarClockIcon}
            label="Routines"
            current={section === "routines"}
          />
          <SystemLink
            to="/rooms"
            search={botId !== undefined ? { bot: botId } : {}}
            icon={MessagesSquareIcon}
            label="Bot talks"
            current={section === "rooms"}
          />
          <SystemLink
            to="/tools"
            search={{}}
            icon={WrenchIcon}
            label="Tools"
            current={section === "tools"}
          />
          <SystemLink
            to="/history"
            search={{}}
            icon={HistoryIcon}
            label="History"
            current={section === "history"}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NavRecents profileId={botId} />
      </div>
      <OwnerBlock className="shrink-0" />
      <MemoryPanel
        profileId={memory?.id ?? ""}
        name={memory?.name ?? ""}
        open={memory !== null}
        onOpenChange={(open) => {
          if (!open) setMemory(null);
        }}
      />
    </nav>
  );
}

/** A phone tab for a plain section (Crew, Routines, Tools). */
function TabLink({
  to,
  icon: Icon,
  label,
}: {
  to: "/bots" | "/routines" | "/tools";
  icon: LucideIcon;
  label: string;
}) {
  const current = useSection();
  const section: Section = to === "/bots" ? "bots" : to === "/routines" ? "routines" : "tools";
  return (
    <Link
      to={to}
      search={{}}
      aria-current={current === section ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring/50 pointer-coarse:min-h-11 flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[0.6875rem] outline-none focus-visible:ring-3",
        current === section ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5 shrink-0" />
      {label}
    </Link>
  );
}

export function TabBar() {
  const { lastBot } = useApp();
  const botId = useActiveBotId();
  const section = useSection();
  return (
    <nav
      aria-label="Sections"
      className="bg-background/65 border-border/60 fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-xl sm:hidden"
    >
      <TabLink to="/bots" icon={UsersIcon} label="Crew" />
      <TabLink to="/routines" icon={CalendarClockIcon} label="Routines" />
      <div className="flex flex-1 items-start justify-center">
        <Link
          to="/"
          search={lastBot !== undefined ? { bot: lastBot } : {}}
          aria-label="Chat"
          aria-current={section === "chat" ? "page" : undefined}
          className="bg-primary text-primary-foreground focus-visible:ring-ring/50 -mt-4 flex size-12 items-center justify-center rounded-full shadow-lg outline-none focus-visible:ring-3"
        >
          <MessageCircleIcon className="size-5" />
        </Link>
      </div>
      <TabLink to="/tools" icon={WrenchIcon} label="Tools" />
      <MoreSheet active={false} botId={botId} />
    </nav>
  );
}
