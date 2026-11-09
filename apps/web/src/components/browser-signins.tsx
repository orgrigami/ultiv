/**
 * The bots' saved sign-ins and browsing history. A sign-in a bot made (you
 * finished a takeover on a site, or a vault login filled) is kept, sealed,
 * so its next session on that site starts signed in; Forget deletes them
 * (and signs a live session out). History is what the bot's browser did —
 * pages, sign-ins, takeovers, files — newest first, for one bot.
 */
import { useCallback, useEffect, useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { api, type BrowserHistoryRow, type BrowserSigninRow } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { useLiveRefresh } from "@/lib/use-live-refresh";

export function SavedSignins({ botId }: { botId?: string }) {
  const [rows, setRows] = useState<readonly BrowserSigninRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    const got = await api.browserSignins().catch(() => null);
    setRows(got === null || !got.available ? null : got.signins);
  }, []);
  useEffect(() => void reload(), [reload]);
  useLiveRefresh(["takeovers"], reload);
  const mine = rows?.filter((row) => botId === undefined || row.profileId === botId) ?? [];
  if (mine.length === 0) return null;
  const forget = async (profileId: string): Promise<void> => {
    setBusy(profileId);
    try {
      await api.browserForget(profileId);
      await reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Saved sign-ins" className="flex flex-col gap-2">
      <SectionHeader title="Saved sign-ins" />
      {mine.map((row) => (
        <div
          key={row.profileId}
          className="bg-card flex flex-wrap items-center gap-3 rounded-xl border p-3"
        >
          <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">
              {botId === undefined ? `${row.botName} · ` : ""}
              {row.sites.join(", ")}
            </span>
            <span className="text-muted-foreground text-xs">saved {formatWhen(row.savedAt)}</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === row.profileId}
            onClick={() => void forget(row.profileId)}
          >
            Forget
          </Button>
        </div>
      ))}
      <p className="text-muted-foreground text-xs">
        A bot starts its next browser session signed in to these sites. Forget signs it out.
      </p>
    </section>
  );
}

export function BrowserHistory({ botId }: { botId: string }) {
  const [rows, setRows] = useState<readonly BrowserHistoryRow[]>([]);
  const reload = useCallback(async (): Promise<void> => {
    const got = await api.browserHistory(botId).catch(() => null);
    if (got !== null) setRows(got.history);
  }, [botId]);
  useEffect(() => void reload(), [reload]);
  useLiveRefresh(["takeovers"], reload);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Browsing history" className="flex flex-col gap-2">
      <SectionHeader title="What its browser did" />
      <ol className="flex flex-col gap-1">
        {rows
          .toReversed()
          .slice(0, 30)
          .map((row) => (
            <li key={`${row.at}-${row.text}`} className="flex gap-2 text-sm">
              <span className="text-muted-foreground w-20 shrink-0 text-xs leading-5">
                {formatWhen(row.at)}
              </span>
              <span className="min-w-0 break-words">{row.text}</span>
            </li>
          ))}
      </ol>
    </section>
  );
}
