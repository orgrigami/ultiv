/**
 * Skills: the procedure library per bot (built-ins, self-written skills,
 * evolution proposals). The page reads the owner-scoped REST overview; each
 * bot's list mirrors what its prompt section shows.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Page } from "@/components/page.tsx";
import { SkillsContent } from "@/components/skills-panel.tsx";

export const Route = createFileRoute("/skills")({
  component: SkillsPage,
});

function SkillsPage() {
  return (
    <Page title="Skills" lead="Procedures your bots keep, write and evolve.">
      <SkillsContent />
    </Page>
  );
}
