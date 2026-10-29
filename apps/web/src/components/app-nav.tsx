/**
 * The app's sections as real links: a bottom tab bar on phones (translucent,
 * safe-area aware) and a left rail on desktop. Both mark the current section
 * with aria-current. Chat covers the home chat and any /c/ session.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  HistoryIcon,
  KeyRoundIcon,
  MessageCircleIcon,
  PlugIcon,
  SparklesIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useApp } from "@/lib/app-state";
import { cn } from "@/lib/utils";

type Section =
  | "/"
  | "/bots"
  | "/vault"
  | "/connectors"
  | "/skills"
  | "/routines"
  | "/history"
  | "/rooms";

interface NavItem {
  to: Section;
  label: string;
  icon: LucideIcon;
  /** Phones show five tabs; the rest stay reachable from the bot switcher. */
  phone: boolean;
}

const ITEMS: readonly NavItem[] = [
  { to: "/", label: "Chat", icon: MessageCircleIcon, phone: true },
  { to: "/bots", label: "Bots", icon: BotIcon, phone: true },
  { to: "/vault", label: "Vault", icon: KeyRoundIcon, phone: true },
  { to: "/connectors", label: "Connectors", icon: PlugIcon, phone: false },
  { to: "/skills", label: "Skills", icon: SparklesIcon, phone: false },
  { to: "/routines", label: "Routines", icon: BellIcon, phone: true },
  { to: "/history", label: "History", icon: HistoryIcon, phone: true },
  { to: "/rooms", label: "Bot talks", icon: UsersIcon, phone: false },
];

function useSection(): Section | null {
  const path = useRouterState({ select: (state) => state.location.pathname });
  if (path === "/" || path.startsWith("/c/")) return "/";
  return ITEMS.find((item) => item.to !== "/" && path.startsWith(item.to))?.to ?? null;
}

function NavLink({ item, className }: { item: NavItem; className: string }) {
  const { lastBot } = useApp();
  const current = useSection() === item.to;
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      search={item.to === "/" && lastBot !== undefined ? { bot: lastBot } : {}}
      aria-current={current ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-3",
        className,
        current ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5 shrink-0" />
      {item.label}
    </Link>
  );
}

export function TabBar() {
  return (
    <nav
      aria-label="Sections"
      className="bg-background/65 border-border/60 fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-xl sm:hidden"
    >
      {ITEMS.filter((item) => item.phone).map((item) => (
        <NavLink
          key={item.to}
          item={item}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs"
        />
      ))}
    </nav>
  );
}

export function SideNav() {
  return (
    <nav
      aria-label="Sections"
      className="hidden w-20 shrink-0 flex-col gap-1 border-r p-2 sm:flex lg:w-52 lg:p-3"
    >
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          item={item}
          className="hover:bg-muted aria-[current=page]:bg-muted flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-xs lg:flex-row lg:gap-3 lg:text-sm"
        />
      ))}
    </nav>
  );
}
