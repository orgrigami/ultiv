import { createFileRoute } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { RoutinesContent } from "@/components/routines-panel";
import { useApp } from "@/lib/app-state";

export const Route = createFileRoute("/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  const { sessions } = useApp();
  return (
    <Page title="Routines" lead="Scheduled work, webhooks and watches across the crew.">
      <RoutinesContent profiles={sessions.profiles} />
    </Page>
  );
}
