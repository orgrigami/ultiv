/**
 * The expanded sidebar's "Recents · <bot>" section: the current bot's extra
 * chats (kind "session"), newest first, plus a "More…" row into /history.
 * The all-sessions list is already app-wide, so this is a pure filter.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const RECENTS_LIMIT = 6;

/**
 * One recent-chat row: a real Link so the row can carry aria-current="page".
 * Hovering swaps the timestamp for a delete button (the history-page
 * confirm); touch pointers keep both visible since there is no hover.
 */
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
  const { sessions } = useApp();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname === `/c/${sessionId}`;
  return (
    <div className="group flex items-center gap-0.5">
      <Link
        to="/c/$sessionId"
        params={{ sessionId }}
        aria-current={active ? "page" : undefined}
        className={
          (active
            ? "bg-sidebar-accent text-sidebar-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/60") +
          " focus-visible:ring-ring/50 flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none focus-visible:ring-2"
        }
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <time className="text-muted-foreground shrink-0 text-xs group-hover:hidden">
          {formatWhen(at, new Date(now))}
        </time>
      </Link>
      <ConfirmDialog
        title="Delete this chat?"
        warning="The chat and all its messages are removed. This can't be undone."
        onConfirm={async () => {
          await sessions.remove(sessionId);
        }}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${title}`}
          className="text-muted-foreground hover:text-foreground hidden group-hover:flex group-focus-within:flex pointer-coarse:flex"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </ConfirmDialog>
    </div>
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
        className="text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-ring/50 flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none focus-visible:ring-2"
      >
        <MoreHorizontalIcon className="size-4 shrink-0" />
        More…
      </Link>
    </div>
  );
}
