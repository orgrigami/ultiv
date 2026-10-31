import { createFileRoute } from "@tanstack/react-router";
import { HistoryList } from "@/components/history-list";
import { Page } from "@/components/page";

export const Route = createFileRoute("/history")({
  component: HistoryPage,
});

function HistoryPage() {
  return (
    <Page title="Past chats">
      <HistoryList />
    </Page>
  );
}
