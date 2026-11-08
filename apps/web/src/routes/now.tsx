/**
 * Now: the check-in screen. What only the owner can settle comes first and
 * looks it (Needs you: approvals settle in place), then the work running
 * across every bot, what finished in the last day, the goals in motion and
 * the newest files with the chat each came from. Everything but goals and
 * files is data the app already holds; nothing polls.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { PauseIcon } from "lucide-react";
import { NeedsList } from "@/components/needs-list";
import { FilesSection } from "@/components/now/files-section";
import { GoalsSection } from "@/components/now/goals-section";
import { FinishedSection, RunningSection } from "@/components/now/work-sections";
import { Page } from "@/components/page";
import { SectionHeader } from "@/components/ui/section-header";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";

export const Route = createFileRoute("/now")({
  component: NowPage,
});

/** The paused banner: one line at the top of Now, resumable in place. */
function PausedBanner() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setPaused((await api.settingsPause()).paused);
    } catch {
      setPaused(null);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  if (paused !== true) return null;
  const resume = async (): Promise<void> => {
    setBusy(true);
    try {
      setPaused((await api.setSettingsPause(false)).paused);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-card text-sm flex items-center gap-3 rounded-xl border px-3 py-2.5">
      <PauseIcon className="text-muted-foreground size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        The crew is paused
        <span className="text-muted-foreground text-xs">
          Nothing autonomous runs: tasks queue, schedules and webhooks are held, sensors skip their
          polls. Your chats still work.
        </span>
      </span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void resume()}>
        {busy && <Spinner />}
        Resume
      </Button>
    </div>
  );
}

function NowPage() {
  const { reloadNeeds, needsCount } = useApp();
  useEffect(() => void reloadNeeds(), [reloadNeeds]);
  return (
    <Page title="Now" lead="What waits on you, what's running, and what just landed.">
      <PausedBanner />
      <section aria-label="Needs you" className="flex flex-col gap-2">
        <SectionHeader
          title={
            needsCount > 0 ? (
              <span className="text-signal">Needs you · {needsCount}</span>
            ) : (
              "Needs you"
            )
          }
        />
        <NeedsList compact />
      </section>
      <RunningSection />
      <FinishedSection />
      <GoalsSection />
      <FilesSection />
    </Page>
  );
}
