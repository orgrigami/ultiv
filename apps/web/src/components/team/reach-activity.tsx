/**
 * Cross-team activity: the reach audit rows (a bot messaging a bot
 * in another home; later, shared folders and VMs) as "Atelier → Yard ·
 * message", newest first. Never content: the row says who and where only.
 * Given a team, only the rows that start or end there.
 */
import { ArrowRightLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { AuditEvent } from "@spriessen/contracts";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { orgApi } from "@/lib/org-api";
import { reachLine, reachTouches } from "@/lib/org-view";
import { useOrg } from "@/lib/use-org";

export function ReachActivity({
  teamId,
  limit = 8,
}: {
  teamId?: string | undefined;
  limit?: number;
}) {
  const { sessions } = useApp();
  const { view } = useOrg();
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    orgApi
      .reach()
      .then((all) => live && setRows(all))
      .catch(
        (cause: unknown) =>
          live && setError(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      live = false;
    };
  }, []);
  if (error !== null) return <ErrorState message={error} />;
  if (rows === null) return <SkeletonRows label="Cross-team activity" rows={2} />;
  const teams = view?.teams ?? [];
  const orgName = view?.org?.name ?? "Org";
  const shown = rows
    .filter((row) => teamId === undefined || reachTouches(row, teamId))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
  if (shown.length === 0)
    return (
      <EmptyState>
        No cross-team activity yet. When a bot messages a bot in another home, it shows here.
      </EmptyState>
    );
  const botName = (id: string | null): string =>
    sessions.profiles.find((bot) => bot.id === id)?.name ?? "A bot";
  return (
    <ul
      aria-label="Cross-team activity"
      className="bg-card divide-border divide-y rounded-xl border"
    >
      {shown.map((row, index) => (
        <li key={`${row.at}-${index}`} className="flex items-center gap-3 px-3 py-2.5">
          <ArrowRightLeftIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="text-ui block truncate">{reachLine(row, teams, orgName)}</span>
            <span className="text-meta text-muted-foreground block truncate">
              {botName(row.profile)}
            </span>
          </span>
          <time className="text-muted-foreground readout shrink-0 text-xs">
            {formatWhen(row.at)}
          </time>
        </li>
      ))}
    </ul>
  );
}
