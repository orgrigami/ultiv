/**
 * Settings › Pause the crew: one switch that freezes autonomous work while
 * the owner keeps chatting. While paused no background task starts (they
 * queue), schedules and webhooks are held (a "held" receipt each, nothing
 * replayed later), and sensors skip their polls. Resuming starts queued work
 * that fits.
 */
import { useCallback, useEffect, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

const card = "bg-card flex flex-col rounded-xl border";

export function PauseSection() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setPaused((await api.settingsPause()).paused);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPaused((await api.setSettingsPause(!(paused ?? false))).paused);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Pause the crew" className="flex flex-col gap-2">
      <SectionHeader title="Pause the crew" />
      {loadError && paused === null ? (
        <ErrorState message="Couldn't load the pause state." onRetry={() => void reload()} />
      ) : paused === null ? (
        <SkeletonRows label="Loading the pause state" rows={1} />
      ) : (
        <div className={card}>
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm">{paused ? "Paused" : "Running"}</span>
              <span className="text-muted-foreground text-xs">
                {paused
                  ? "No task starts, schedules and webhooks are held, sensors skip their polls. Your chats still work."
                  : "One stop freezes every bot's autonomous work if you ever need it."}
              </span>
            </span>
            <Button
              variant={paused ? "outline" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => void toggle()}
            >
              {busy ? <Spinner /> : paused ? <PlayIcon /> : <PauseIcon />}
              {paused ? "Resume" : "Pause"}
            </Button>
          </div>
        </div>
      )}
      {error !== null && <ErrorState message={error} />}
    </section>
  );
}
