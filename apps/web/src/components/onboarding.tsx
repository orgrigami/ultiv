/**
 * First-run onboarding: pick a template and the bot exists with a sensible
 * identity, seeded to introduce itself in its own chat — which the home screen
 * opens straight into. Custom identity stays available below the templates.
 */
import { CheckIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import type { ModelInfo } from "@ultiv/contracts";
import { catalogSummary } from "@/components/model-options";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface Template {
  key: string;
  name: string;
  description: string;
  persona: string;
  bullets: string[];
}

const TEMPLATES: Template[] = [
  {
    key: "assistant",
    name: "Assistant",
    description: "Everyday questions, drafts, and small tasks",
    persona:
      "You are a concise, proactive assistant. When a request is ambiguous you ask one clarifying question, then act. You keep answers short unless depth is asked for, and you say so plainly when you are unsure.",
    bullets: [
      "Chats, plans, and drafts",
      "Sees vault names and masked hints only; looks up contacts, can't use logins yet",
      "Remembers what matters across chats",
    ],
  },
  {
    key: "researcher",
    name: "Researcher",
    description: "Web deep dives that end in a written-up source list",
    persona:
      "You are a meticulous researcher. You search before you claim, name where each fact came from, and separate findings from inference. You finish with a structured summary and save long write-ups as artifacts.",
    bullets: ["Searches the live web", "Reads and cites sources", "Saves findings as artifacts"],
  },
  {
    key: "projects",
    name: "Projects",
    description: "Keeps shared projects moving: plans, steps, status",
    persona:
      "You are a project coordinator. You break work into small next steps, track what is done versus what is blocked, and surface blockers early. You write statuses anyone can skim in ten seconds.",
    bullets: [
      "Breaks work into next steps",
      "Reports status on request",
      "Coordinates with your other bots",
    ],
  },
];

export function OnboardingHome({
  models,
  custom,
  onCreated,
}: {
  models: ModelInfo[];
  /** The custom path — rendered below the templates (the Bots panel). */
  custom: React.ReactNode;
  onCreated: (profileId: string) => Promise<void>;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spawn = async (template: Template): Promise<void> => {
    setBusyKey(template.key);
    setError(null);
    try {
      const profile = await api.createProfile({
        name: template.name,
        description: template.description,
        persona: template.persona,
      });
      await onCreated(profile.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4" /> Meet your first bot
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          Pick a starting point. The bot introduces itself in its own chat, and you can change its
          name, personality or model any time.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {TEMPLATES.map((template) => (
            <div key={template.key} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold">{template.name}</p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyKey !== null}
                  onClick={() => void spawn(template)}
                >
                  {busyKey === template.key ? "Creating…" : "Create"}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{template.description}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {template.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-1.5 text-xs">
                    <CheckIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {error !== null && <p className="text-destructive text-sm">{error}</p>}
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground shrink-0 text-xs ">or your own</span>
          <div className="min-w-0 flex-1">{custom}</div>
        </div>
        <p className="text-muted-foreground text-xs">
          {models.length > 0
            ? `Models available: ${catalogSummary(models)}.`
            : "Couldn't load the model list, so the default model is used."}
        </p>
      </CardContent>
    </Card>
  );
}
