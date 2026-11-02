/**
 * Tools: Connectors, Skills and Vault as one page. The tab rides ?tab= so
 * every surface (nav, sheets, deep links) can open the exact panel; the
 * panels themselves are the untouched page components.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { ConnectorsPanel } from "@/components/connectors/connectors-panel";
import { SkillsContent } from "@/components/skills-panel";
import { VaultContent } from "@/components/vault-panel";
import { useApp } from "@/lib/app-state";

const TABS = [
  { id: "connectors", label: "Connectors" },
  { id: "skills", label: "Skills" },
  { id: "vault", label: "Vault" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export const Route = createFileRoute("/tools")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    TABS.some((tab) => tab.id === search.tab) ? { tab: search.tab as Tab } : {},
  component: ToolsPage,
});

function ToolsPage() {
  const { sessions } = useApp();
  const { tab } = Route.useSearch();
  const active: Tab = tab ?? "connectors";
  return (
    <Page title="Tools" lead="Everything your bots reach beyond the chat.">
      <div
        role="tablist"
        aria-label="Tool sections"
        className="bg-muted/60 mb-4 inline-flex self-start gap-1 rounded-xl p-1"
      >
        {TABS.map((entry) => (
          <Button
            key={entry.id}
            variant="segment"
            size="lg"
            nativeButton={false}
            role="tab"
            aria-current={active === entry.id ? "page" : undefined}
            render={
              <Link to="/tools" search={entry.id === "connectors" ? {} : { tab: entry.id }} />
            }
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {active === "connectors" && <ConnectorsPanel profiles={sessions.profiles} />}
      {active === "skills" && <SkillsContent />}
      {active === "vault" && <VaultContent profiles={sessions.profiles} />}
    </Page>
  );
}
