import { createFileRoute } from "@tanstack/react-router";
import { SquarePenIcon } from "lucide-react";
import { HistoryList } from "@/components/history-list";
import { useNewChat } from "@/components/app-nav";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/history")({
  component: HistoryPage,
});

function HistoryPage() {
  const newChat = useNewChat();
  return (
    <Page
      title="Past chats"
      lead="Every bot's main chat and the chats you started, newest first."
      actions={
        <Button
          size="sm"
          disabled={!newChat.ready}
          title={newChat.ready ? undefined : "Waiting for the server"}
          onClick={() => void newChat.start()}
        >
          <SquarePenIcon /> New chat
        </Button>
      }
    >
      <HistoryList />
    </Page>
  );
}
