/**
 * Crew › bot › Browser: the owner's side of a takeover. A bot that meets an
 * identity wall in its browser session asks (browser_session op takeover);
 * its ask appears here. The owner drives ONE act at a time (click, type,
 * press, refresh), each answer showing the fresh screenshot — no stream, no
 * timer — and Finish hands the controls back: the bot is woken with the page
 * as it stands. While a takeover is open the bot's own acts are refused.
 */
import { useCallback, useEffect, useState } from "react";
import { GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

interface TakeoverRow {
  id: string;
  conversationId: string;
  reason: string;
  openedAt: number;
  profileId: string | null;
  botName: string;
}

interface ActReply {
  ok: boolean;
  png: string;
  url: string;
  title: string;
  error: string | null;
}

export function BrowserTakeoverTab() {
  const [rows, setRows] = useState<TakeoverRow[] | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setRows((await api.browserTakeovers()).takeovers);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  return (
    <section aria-label="Browser" className="flex flex-col gap-3">
      <SectionHeader title="Browser" />
      {error && rows === null ? (
        <ErrorState message="Couldn't load the takeovers." onRetry={() => void reload()} />
      ) : rows === null ? (
        <SkeletonRows label="Loading takeovers" rows={1} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-8">
          No takeover open. When a bot meets a sign-in, a code or a CAPTCHA in its browser session,
          its ask appears here.
        </EmptyState>
      ) : (
        rows.map((row) => <TakeoverCard key={row.id} row={row} onGone={reload} />)
      )}
      <p className="text-muted-foreground text-xs">
        While you hold the controls, the bot's own browser acts are refused; Finish wakes it with
        the page as it stands. Each act shows the fresh screenshot — nothing streams, nothing polls.
      </p>
    </section>
  );
}

function TakeoverCard({ row, onGone }: { row: TakeoverRow; onGone: () => Promise<void> }) {
  const [view, setView] = useState<ActReply | null>(null);
  const [selector, setSelector] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const act = async (body: {
    kind: string;
    selector?: string;
    text?: string;
    key?: string;
  }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const reply = await api.browserTakeoverAct(row.id, body);
      setView(reply);
      if (reply.error !== null) setError(reply.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const finish = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.browserTakeoverFinish(row.id);
      setDone(true);
      await onGone();
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.browserTakeoverCancel(row.id);
      await onGone();
    } finally {
      setBusy(false);
    }
  };
  if (done) return null;
  return (
    <div className="bg-card flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex items-center gap-2 text-sm">
        <GlobeIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <strong>{row.botName}</strong> asked you to take the controls
        </span>
        <span className="text-muted-foreground text-xs">{row.reason}</span>
      </div>
      {view?.png ? (
        <img
          src={`data:image/png;base64,${view.png}`}
          alt={view.title === "" ? "The page" : view.title}
          className="w-full rounded-lg border"
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          {busy ? "Loading the page…" : "Refresh to see the page."}
        </p>
      )}
      {view !== null && view.url !== "" && (
        <p className="text-muted-foreground font-mono text-xs">{view.url}</p>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input
          placeholder="CSS selector, e.g. #submit"
          value={selector}
          onChange={(event) => setSelector(event.target.value)}
        />
        <Input
          placeholder="Text to type (for type)"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act({ kind: "refresh" })}
          >
            {busy && <Spinner />}
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || selector.trim() === ""}
            onClick={() => void act({ kind: "click", selector })}
          >
            Click
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || selector.trim() === ""}
            onClick={() => void act({ kind: "type", selector, text })}
          >
            Type
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act({ kind: "press", key: "Enter" })}
          >
            Enter
          </Button>
        </div>
      </div>
      {error !== null && <ErrorState message={error} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
          Step away
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void finish()}>
          {busy && <Spinner />}
          Finish and hand back
        </Button>
      </div>
    </div>
  );
}
