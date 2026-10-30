import { createFileRoute } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { VaultContent } from "@/components/vault-panel";
import { useApp } from "@/lib/app-state";

export const Route = createFileRoute("/vault")({
  component: VaultPage,
});

function VaultPage() {
  const { sessions } = useApp();
  return (
    <Page title="Vault">
      <VaultContent profiles={sessions.profiles} />
    </Page>
  );
}
