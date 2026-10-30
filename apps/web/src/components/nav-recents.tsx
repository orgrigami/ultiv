/**
 * The expanded sidebar's "Recents · <bot>" section: the current bot's extra
 * chats (kind "session"), newest first, plus a "More…" row into /history.
 * The all-sessions list is already app-wide, so this is a pure filter.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const RECENTS_LIMIT = 6;

/** One recent-chat row: a real Link so the row can carry aria-current="page". */
function RecentRow({
  sessionId,
  title,
  at,
  now,
}: {
  sessionId: string;
  title: string;
  at: number;
  now: number;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname === `/c/${sessionId}`;
  return (
    <Link
      to="/c/$sessionId"
      params={{ sessionId }}
      aria-current={active ? "page" : undefined}
      className={
        (active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted") +
        " focus-visible:ring-ring/50 flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none focus-visible:ring-3"
      }
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <time className="text-muted-foreground shrink-0 text-xs">
        {formatWhen(at, new Date(now))}
      </time>
    </Link>
  );
}

export function NavRecents({ profileId }: { profileId: string | undefined }) {
  const { sessions } = useApp();
  const now = useNow(30_000, true);
  if (profileId === undefined) return null;
  const bot = sessions.profiles.find((candidate) => candidate.id === profileId);
  const recents = sessions.sessions
    .filter((session) => session.profile === profileId && session.kind === "session")
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, RECENTS_LIMIT);
  if (recents.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-0.5">
      <div className="text-muted-foreground flex min-h-7 items-center px-3 text-[11px] font-medium tracking-wider uppercase">
        Recents · {bot?.name ?? "chat"}
      </div>
      {recents.map((session) => (
        <RecentRow
          key={session.id}
          sessionId={session.id}
          title={session.title === "" ? "Untitled chat" : session.title}
          at={session.lastMessageAt}
          now={now}
        />
      ))}
      <Link
        to="/history"
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none focus-visible:ring-3"
      >
        <MoreHorizontalIcon className="size-4 shrink-0" />
        More…
      </Link>
    </div>
  );
}
