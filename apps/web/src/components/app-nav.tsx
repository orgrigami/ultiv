/**
 * The app's sections as real links: a bottom tab bar on phones (translucent,
 * safe-area aware, Chat as a raised centre circle) and a fixed 256px side
 * nav from sm: up (bot switcher block, New chat, sections, per-bot Recents).
 * Both mark the current section with aria-current. Chat covers the home chat
 * and any /c/ session.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  MessageCircleIcon,
  PlusIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { NavRecents } from "@/components/nav-recents";
import { NavSwitcher } from "@/components/nav-switcher";
import { MoreSheet } from "@/components/nav-sheets";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app-state";
import { cn } from "@/lib/utils";

export type Section = "chat" | "bots" | "routines" | "tools";

interface NavSection {
  id: Section;
  label: string;
  icon: LucideIcon;
  to: "/" | "/bots" | "/routines" | "/tools";
}

const SECTIONS: readonly NavSection[] = [
  { id: "chat", label: "Chat", icon: MessageCircleIcon, to: "/" },
  { id: "bots", label: "Bots", icon: BotIcon, to: "/bots" },
  { id: "routines", label: "Routines", icon: BellIcon, to: "/routines" },
  { id: "tools", label: "Tools", icon: WrenchIcon, to: "/tools" },
];

/** Path prefixes per section; no prefix is a prefix of another. */
const MATCHES: readonly (readonly [string, Section])[] = [
  ["/c/", "chat"],
  ["/bots", "bots"],
  ["/routines", "routines"],
  ["/tools", "tools"],
  ["/connectors", "tools"],
  ["/skills", "tools"],
  ["/vault", "tools"],
];

function useSection(): Section | null {
  const path = useRouterState({ select: (state) => state.location.pathname });
  if (path === "/") return "chat";
  return MATCHES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
}

/**
 * The bot the sidebar is "about": the /c/ session's bot when one is open,
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

/** The shared row classes for a section entry. */
const sectionRow = (current: boolean): string =>
  cn(
    "focus-visible:ring-ring/50 aria-[current=page]:bg-muted hover:bg-muted pointer-coarse:min-h-11 flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm outline-none focus-visible:ring-3",
    current ? "text-foreground" : "text-muted-foreground",
  );

function SectionLink({ section }: { section: NavSection }) {
  const { lastBot } = useApp();
  const current = useSection() === section.id;
  const Icon = section.icon;
  return (
    <Link
      to={section.to}
      search={section.to === "/" && lastBot !== undefined ? { bot: lastBot } : {}}
      aria-current={current ? "page" : undefined}
      className={sectionRow(current)}
    >
      <Icon className="size-5 shrink-0" />
      {section.label}
    </Link>
  );
}

/** New chat: creates a session for the bot the sidebar is about. */
function NewChatButton({ botId }: { botId: string | undefined }) {
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
      className="flex flex-col"
      title={
        sessions.profiles.length === 0
          ? "Create a bot first"
          : sessions.phase !== "live"
            ? "Waiting for the server"
            : undefined
      }
    >
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => void create()}
        className="pointer-coarse:min-h-11 w-full"
      >
        <PlusIcon className="size-4 shrink-0" />
        New chat
      </Button>
    </span>
  );
}

export function SideNav() {
  const botId = useActiveBotId();
  return (
    <nav
      aria-label="Sections"
      className="bg-background hidden w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3 sm:flex"
    >
      <NavSwitcher botId={botId} />
      <NewChatButton botId={botId} />
      <div className="mt-2 flex flex-col gap-1">
        {SECTIONS.map((section) => (
          <SectionLink key={section.id} section={section} />
        ))}
      </div>
      <NavRecents profileId={botId} />
    </nav>
  );
}

/** A phone tab for a plain section (Bots, Routines, Tools). */
function TabLink({ section }: { section: NavSection }) {
  const current = useSection() === section.id;
  const Icon = section.icon;
  return (
    <Link
      to={section.to}
      aria-current={current ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring/50 pointer-coarse:min-h-11 flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-xs outline-none focus-visible:ring-3",
        current ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5 shrink-0" />
      {section.label}
    </Link>
  );
}

export function TabBar() {
  const section = useSection();
  const { lastBot } = useApp();
  const botId = useActiveBotId();
  return (
    <nav
      aria-label="Sections"
      className="bg-background/65 border-border/60 fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-xl sm:hidden"
    >
      <TabLink section={SECTIONS[1]!} />
      <TabLink section={SECTIONS[2]!} />
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
      <TabLink section={SECTIONS[3]!} />
      <MoreSheet active={false} botId={botId} />
    </nav>
  );
}
