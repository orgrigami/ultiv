/**
 * The app's sections as real links: a bottom tab bar on phones (translucent,
 * safe-area aware, Chat as a raised centre circle) and a single-scroll side
 * nav on desktop (bot switcher, New chat, sections with a collapsible Tools
 * group, per-bot Recents). Both mark the current section with aria-current.
 * Chat covers the home chat and any /c/ session.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  KeyRoundIcon,
  MessageCircleIcon,
  PlugIcon,
  PlusIcon,
  SparklesIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { NavRecents } from "@/components/nav-recents";
import { NavSwitcher } from "@/components/nav-switcher";
import { MoreSheet, ToolsSheet } from "@/components/nav-sheets";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useApp } from "@/lib/app-state";
import { cn } from "@/lib/utils";

export type Section = "chat" | "bots" | "routines" | "tools";

interface NavChild {
  label: string;
  to: "/connectors" | "/skills" | "/vault";
  icon: LucideIcon;
}

interface NavSection {
  id: Section;
  label: string;
  icon: LucideIcon;
  /** Where a plain section links; absent for the collapsible Tools group. */
  to?: "/" | "/bots" | "/routines";
  children?: readonly NavChild[];
}

const SECTIONS: readonly NavSection[] = [
  { id: "chat", label: "Chat", icon: MessageCircleIcon, to: "/" },
  { id: "bots", label: "Bots", icon: BotIcon, to: "/bots" },
  { id: "routines", label: "Routines", icon: BellIcon, to: "/routines" },
  {
    id: "tools",
    label: "Tools",
    icon: WrenchIcon,
    children: [
      { label: "Connectors", to: "/connectors", icon: PlugIcon },
      { label: "Skills", to: "/skills", icon: SparklesIcon },
      { label: "Vault", to: "/vault", icon: KeyRoundIcon },
    ],
  },
];

/** Path prefixes per section, most specific first. */
const MATCHES: readonly (readonly [string, Section])[] = [
  ["/c/", "chat"],
  ["/bots", "bots"],
  ["/routines", "routines"],
  ["/connectors", "tools"],
  ["/skills", "tools"],
  ["/vault", "tools"],
];

/** The shared row classes for a section entry (rail centres icons). */
const sectionRow = (current: boolean): string =>
  cn(
    "focus-visible:ring-ring/50 aria-[current=page]:bg-muted hover:bg-muted pointer-coarse:min-h-11 flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-xs outline-none focus-visible:ring-3 lg:flex-row lg:gap-3 lg:text-sm",
    current ? "text-foreground" : "text-muted-foreground",
  );

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

/**
 * One section row. Plain sections are Links; Tools is a collapsible group
 * whose trigger marks aria-current when one of its child routes is open.
 */
function SectionLink({
  section,
  toolsOpen,
  onToolsToggle,
}: {
  section: NavSection;
  toolsOpen: boolean;
  onToolsToggle: (open: boolean) => void;
}) {
  const { lastBot } = useApp();
  const current = useSection() === section.id;
  const Icon = section.icon;
  if (section.children === undefined) {
    const target = section.to ?? "/";
    return (
      <Link
        to={target}
        search={target === "/" && lastBot !== undefined ? { bot: lastBot } : {}}
        aria-current={current ? "page" : undefined}
        className={sectionRow(current)}
      >
        <Icon className="size-5 shrink-0" />
        {section.label}
      </Link>
    );
  }
  return (
    <Collapsible open={toolsOpen} onOpenChange={onToolsToggle}>
      <CollapsibleTrigger
        aria-current={current ? "true" : undefined}
        className={sectionRow(current)}
      >
        <Icon className="size-5 shrink-0" />
        {section.label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col">
          {section.children.map((child) => (
            <NavChildLink key={child.to} child={child} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A Tools child: indented on the wide sidebar, icon-centred on the rail. */
function NavChildLink({ child }: { child: NavChild }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname.startsWith(child.to);
  const Icon = child.icon;
  return (
    <Link
      to={child.to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring/50 flex min-h-9 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs outline-none focus-visible:ring-3 lg:flex-row lg:justify-start lg:gap-3 lg:pl-8 lg:text-sm",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted",
      )}
    >
      <Icon className="size-5 shrink-0" />
      <span className="hidden lg:inline">{child.label}</span>
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
        size="sm"
        disabled={disabled}
        onClick={() => void create()}
        className="pointer-coarse:min-h-11 lg:w-full"
      >
        <PlusIcon className="size-4 shrink-0" />
        <span className="hidden lg:inline">New chat</span>
      </Button>
    </span>
  );
}

export function SideNav() {
  const botId = useActiveBotId();
  const [toolsOpen, setToolsOpen] = useState(() => localStorage.getItem("nav.tools") !== "false");
  const toggle = (open: boolean): void => {
    setToolsOpen(open);
    try {
      localStorage.setItem("nav.tools", String(open));
    } catch {
      // Private mode: the group just won't persist.
    }
  };
  return (
    <nav
      aria-label="Sections"
      className="bg-background hidden w-20 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 sm:flex lg:w-52 lg:p-3"
    >
      <NavSwitcher botId={botId} />
      <NewChatButton botId={botId} />
      <div className="flex flex-col gap-1">
        {SECTIONS.map((section) => (
          <SectionLink
            key={section.id}
            section={section}
            toolsOpen={toolsOpen}
            onToolsToggle={toggle}
          />
        ))}
      </div>
      <NavRecents profileId={botId} />
    </nav>
  );
}

/** A phone tab for a plain section (Bots, Routines). */
function TabLink({ section }: { section: NavSection }) {
  const current = useSection() === section.id;
  const Icon = section.icon;
  const target = section.to ?? "/";
  return (
    <Link
      to={target}
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
      <ToolsSheet active={section === "tools"} />
      <MoreSheet active={false} botId={botId} />
    </nav>
  );
}
