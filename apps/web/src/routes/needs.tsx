/**
 * Needs you: the few things only the owner can settle, from data the app
 * already polls plus one read of tidy counts and escalations on each visit.
 * Approvals settle right in the list; every other row opens what settles it.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { NeedsList } from "@/components/needs-list";
import { Page } from "@/components/page";
import { useApp } from "@/lib/app-state";

export const Route = createFileRoute("/needs")({
  component: NeedsPage,
});

function NeedsPage() {
  const { reloadNeeds } = useApp();
  useEffect(() => void reloadNeeds(), [reloadNeeds]);
  return (
    <Page title="Needs you" lead="Approvals, failures and suggestions waiting on you.">
      <NeedsList />
    </Page>
  );
}
