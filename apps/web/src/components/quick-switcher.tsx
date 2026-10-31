/**
 * Cmd/Ctrl-K: one box that finds any bot, past chat, screen or action and
 * opens it with Enter. N starts a new chat and ? shows every shortcut. Bare
 * keys never fire while typing in a field. The ranking lives in
 * lib/quick-switch.ts; this file is the dialog and the key listener.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import {
  BellDotIcon,
  BotIcon,
  CalendarClockIcon,
  HistoryIcon,
  KeyRoundIcon,
  KeyboardIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  PlugIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  SunMoonIcon,
  UsersIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useNewChat, useOpenChat } from "@/components/app-nav";
import { useApp } from "@/lib/app-state";
import { pastChats } from "@/lib/chats";
import { formatWhen } from "@/lib/format";
import {
  KIND_LABEL,
  moveActive,
  rankItems,
  SHORTCUTS,
  shortcutOf,
  type QuickItem,
} from "@/lib/quick-switch";
import { QuickSwitchContext } from "@/lib/quick-switch-context";
import { setThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface Entry extends QuickItem {
  icon?: LucideIcon;
  bot?: { id: string; name: string };
  run: () => void;
}

const typingIn = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const SCREENS: readonly {
  id: string;
  title: string;
  to: string;
  search?: Record<string, string>;
  icon: LucideIcon;
  keywords?: string[];
}[] = [
  { id: "chat", title: "Chat", to: "/", icon: MessageCircleIcon, keywords: ["home"] },
  {
    id: "history",
    title: "Past chats",
    to: "/history",
    icon: HistoryIcon,
    keywords: ["history", "recent"],
  },
  {
    id: "needs",
    title: "Needs you",
    to: "/needs",
    icon: BellDotIcon,
    keywords: ["approvals", "inbox"],
  },
  { id: "crew", title: "Crew", to: "/crew", icon: UsersIcon, keywords: ["bots"] },
  {
    id: "routines",
    title: "Routines",
    to: "/routines",
    icon: CalendarClockIcon,
    keywords: ["schedules", "cron", "webhooks"],
  },
  { id: "rooms", title: "Bot talks", to: "/rooms", icon: MessagesSquareIcon, keywords: ["rooms"] },
  {
    id: "tools",
    title: "Connectors",
    to: "/tools",
    icon: PlugIcon,
    keywords: ["apps", "tools", "mcp"],
  },
  {
    id: "vault",
    title: "Vault",
    to: "/tools",
    search: { tab: "vault" },
    icon: KeyRoundIcon,
    keywords: ["logins", "passwords"],
  },
  { id: "skills", title: "Skills", to: "/skills", icon: WandSparklesIcon },
  {
    id: "settings",
    title: "Settings",
    to: "/settings",
    icon: SettingsIcon,
    keywords: ["theme", "notifications"],
  },
];

function useEntries(close: () => void, showHelp: () => void): Entry[] {
  const { sessions, mainId } = useApp();
  const navigate = useNavigate();
  const newChat = useNewChat();
  const openChat = useOpenChat();
  const go = (to: string, search: Record<string, string> = {}) => {
    close();
    void navigate({ to: to as never, search: search as never });
  };
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const bots = sessions.profiles.filter((bot) => bot.archivedAt === null);
  return [
    {
      id: "new-chat",
      kind: "action",
      title: "New chat",
      icon: SquarePenIcon,
      shortcut: "N",
      keywords: ["start", "compose"],
      run: () => {
        close();
        void newChat.start();
      },
    },
    {
      id: "theme",
      kind: "action",
      title: dark ? "Switch to light" : "Switch to dark",
      icon: SunMoonIcon,
      keywords: ["theme", "dark", "light"],
      run: () => {
        close();
        setThemeChoice(dark ? "light" : "dark");
      },
    },
    {
      id: "shortcuts",
      kind: "action",
      title: "Keyboard shortcuts",
      icon: KeyboardIcon,
      shortcut: "?",
      keywords: ["keys", "help"],
      run: () => {
        close();
        showHelp();
      },
    },
    ...SCREENS.map((screen): Entry => ({
      id: `screen-${screen.id}`,
      kind: "screen",
      title: screen.title,
      icon: screen.icon,
      keywords: screen.keywords,
      run: () => go(screen.to, screen.search),
    })),
    ...bots.flatMap((bot): Entry[] => [
      {
        id: `bot-${bot.id}`,
        kind: "bot",
        title: bot.name,
        detail: bot.description !== "" ? `Chat · ${bot.description}` : "Chat",
        bot: { id: bot.id, name: bot.name },
        run: () => go("/", bot.id === mainId ? {} : { bot: bot.id }),
      },
      {
        id: `profile-${bot.id}`,
        kind: "bot",
        title: `${bot.name} profile`,
        detail: "Memory, routines, access and files",
        icon: BotIcon,
        run: () => go(`/crew/${bot.id}`),
      },
    ]),
    ...pastChats({ sessions: sessions.sessions, profiles: sessions.profiles }).map(
      (row): Entry => ({
        id: `chat-${row.id}`,
        kind: "chat",
        title: row.title,
        detail: row.main ? formatWhen(row.at) : `${row.botName} · ${formatWhen(row.at)}`,
        icon: MessageCircleIcon,
        run: () => {
          close();
          openChat(row);
        },
      }),
    ),
  ];
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-muted text-muted-foreground readout inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1.5 text-[0.6875rem]">
      {children}
    </kbd>
  );
}

function Switcher({ onClose, showHelp }: { onClose: () => void; showHelp: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const entries = useEntries(onClose, showHelp);
  // A few dozen rows: ranking on each render is cheaper than memoising closures.
  const rows = rankItems(entries, query) as Entry[];
  const current = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <>
      <div className="flex items-center gap-2 border-b px-4">
        <SearchIcon className="text-muted-foreground size-4 shrink-0" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="quick-switch-list"
          aria-activedescendant={rows[current] ? `qs-${rows[current].id}` : undefined}
          aria-label="Find a bot, chat or screen"
          placeholder="Find a bot, chat or screen…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(moveActive(current, rows.length, event.key === "ArrowDown" ? 1 : -1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              rows[current]?.run();
            }
          }}
          className="placeholder:text-muted-foreground h-14 min-w-0 flex-1 bg-transparent text-base outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <ul
        ref={list}
        id="quick-switch-list"
        role="listbox"
        aria-label="Results"
        className="max-h-[min(26rem,60dvh)] overflow-y-auto overscroll-contain p-2"
      >
        {rows.length === 0 && (
          <li className="text-muted-foreground px-3 py-8 text-center text-sm">
            Nothing matches “{query.trim()}”.
          </li>
        )}
        {rows.map((row, index) => {
          const Icon = row.icon;
          const heading = index === 0 || rows[index - 1]?.kind !== row.kind;
          return (
            <li key={row.id} role="presentation">
              {heading && (
                <p className="section-label px-3 pt-2 pb-1" aria-hidden>
                  {KIND_LABEL[row.kind]}
                </p>
              )}
              <div
                id={`qs-${row.id}`}
                role="option"
                aria-selected={index === current}
                data-index={index}
                onMouseMove={() => setActive(index)}
                onClick={() => row.run()}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-1.5",
                  index === current && "bg-muted",
                )}
              >
                {row.bot !== undefined ? (
                  <BotAvatar id={row.bot.id} name={row.bot.name} size="md" />
                ) : Icon !== undefined ? (
                  <span className="grid size-7 shrink-0 place-items-center">
                    <Icon className="text-muted-foreground size-4" />
                  </span>
                ) : null}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{row.title}</span>
                  {row.detail !== undefined && (
                    <span className="text-muted-foreground truncate text-xs">{row.detail}</span>
                  )}
                </span>
                {row.shortcut !== undefined && <Kbd>{row.shortcut}</Kbd>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ShortcutSheet() {
  return (
    <div className="flex flex-col gap-3 p-5">
      <DialogPrimitive.Title className="font-heading text-title font-semibold tracking-tight">
        Keyboard shortcuts
      </DialogPrimitive.Title>
      <dl className="divide-border divide-y rounded-2xl border">
        {SHORTCUTS.map((entry) => (
          <div key={entry.label} className="flex items-center gap-3 px-3 py-2.5">
            <dt className="flex shrink-0 gap-1">
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd className="text-muted-foreground text-sm">{entry.label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Floating({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <DialogPrimitive.Popup
          aria-label={label}
          className="bg-popover text-popover-foreground fixed top-[12dvh] left-1/2 z-50 w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-3xl border shadow-2xl outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none"
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Owns the shortcuts and both dialogs; wraps the app so the sidebar can open them. */
export function QuickSwitchProvider({ children }: { children: React.ReactNode }) {
  const [switcher, setSwitcher] = useState(false);
  const [help, setHelp] = useState(false);
  const newChat = useNewChat();
  const startNew = useRef(newChat.start);
  startNew.current = newChat.start;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const hit = shortcutOf({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        typing: typingIn(event.target),
      });
      if (hit === null) return;
      // A bare key with another dialog open belongs to that dialog.
      if (hit !== "switcher" && document.querySelector("[role=dialog]") !== null) return;
      event.preventDefault();
      if (hit === "switcher") setSwitcher((now) => !now);
      else if (hit === "help") setHelp(true);
      else void startNew.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const controls = useMemo(
    () => ({ openSwitcher: () => setSwitcher(true), openShortcuts: () => setHelp(true) }),
    [],
  );
  return (
    <QuickSwitchContext.Provider value={controls}>
      {children}
      <Floating open={switcher} onOpenChange={setSwitcher} label="Quick switcher">
        {switcher && <Switcher onClose={() => setSwitcher(false)} showHelp={() => setHelp(true)} />}
      </Floating>
      <Floating open={help} onOpenChange={setHelp} label="Keyboard shortcuts">
        <ShortcutSheet />
      </Floating>
    </QuickSwitchContext.Provider>
  );
}
