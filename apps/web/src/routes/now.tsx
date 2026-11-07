/**
 * Now: the check-in screen. What only the owner can settle comes first and
 * looks it (Needs you: approvals settle in place), then the work running
 * across every bot, what finished in the last day, the goals in motion and
 * the newest files with the chat each came from. Everything but goals and
 * files is data the app already holds; nothing polls.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { NeedsList } from "@/components/needs-list";
import { FilesSection } from "@/components/now/files-section";
import { GoalsSection } from "@/components/now/goals-section";
import { FinishedSection, RunningSection } from "@/components/now/work-sections";
import { Page } from "@/components/page";
import { SectionHeader } from "@/components/ui/section-header";
import { useApp } from "@/lib/app-state";

export const Route = createFileRoute("/now")({
  component: NowPage,
});

function NowPage() {
  const { reloadNeeds, needsCount } = useApp();
  useEffect(() => void reloadNeeds(), [reloadNeeds]);
  return (
    <Page title="Now" lead="What waits on you, what's running, and what just landed.">
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
